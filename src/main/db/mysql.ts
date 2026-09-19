import mysql, { Connection, RowDataPacket } from 'mysql2/promise';
import type { Connection as StreamingConnection, FieldPacket } from 'mysql2';
import type {
    ConnectionConfig,
    DiagramPayload,
    TableSchema,
    ColumnMeta,
    ForeignKey,
    IndexMeta
} from '@shared/schema';
import { QUERY_ROW_LIMIT, QUERY_TIMEOUT_MS, type QueryData } from '@shared/query';
import type { DbAdapter } from './types';
import { toQueryRow } from './queryValues';
import { PLAN_TEXT_LIMIT, type RawQueryPlan } from '@shared/queryPlan';

type TableRef = {
    schema: string;
    name: string;
};

export class MysqlAdapter implements DbAdapter {
    readonly dialect = 'mysql' as const;
    private connection: Connection | null = null;
    private queryOptions: Parameters<typeof mysql.createConnection>[0] | null = null;
    private activeQueryConnection: Connection | null = null;
    private generation = 0;
    private cancelQuery: (() => void) | null = null;

    async connect(cfg: ConnectionConfig) {
        if (cfg.dialect !== 'mysql') {
            throw new Error('Wrong dialect for MysqlAdapter');
        }

        this.generation++;
        this.queryOptions = {
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            password: cfg.password,
            database: cfg.database,
            ssl: cfg.ssl ? {} : undefined,
            rowsAsArray: false
        };
        this.connection = await mysql.createConnection(this.queryOptions);
    }

    async disconnect() {
        this.generation++;
        this.cancelQuery?.();
        this.activeQueryConnection?.destroy();
        this.activeQueryConnection = null;
        await this.connection?.end();
        this.connection = null;
        this.queryOptions = null;
    }

    private c() {
        if (!this.connection) {
            throw new Error('Not connected');
        }

        return this.connection;
    }

    private async listTables(): Promise<TableRef[]> {
        const [rows] = await this.c().query<RowDataPacket[]>(
            `
            SELECT
                table_schema AS schema_name,
                table_name AS table_name
            FROM information_schema.tables
            WHERE table_type = 'BASE TABLE'
              AND table_schema = DATABASE()
            ORDER BY table_name
            `
        );

        return (rows as any[]).map((r) => ({
            schema: r.schema_name,
            name: r.table_name
        }));
    }

    private async loadAllTables(refs: TableRef[]): Promise<TableSchema[]> {
        const [[colRows], [uniqueRows], [fkRows], [refRows], [idxRows]] = await Promise.all([
            this.c().query<RowDataPacket[]>(`
                SELECT
                    table_schema AS ts,
                    table_name AS tn,
                    column_name AS col_name,
                    column_type AS col_type,
                    data_type,
                    is_nullable,
                    column_default AS col_default,
                    column_key AS col_key,
                    character_maximum_length AS char_max_len,
                    numeric_precision AS num_prec,
                    numeric_scale AS num_scale
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                ORDER BY table_name, ordinal_position
            `),

            this.c().query<RowDataPacket[]>(`
                SELECT
                    tc.table_name,
                    tc.constraint_name,
                    kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_schema = kcu.constraint_schema
                 AND tc.table_schema = kcu.table_schema
                 AND tc.table_name = kcu.table_name
                 AND tc.constraint_name = kcu.constraint_name
                WHERE tc.constraint_type = 'UNIQUE'
                  AND tc.table_schema = DATABASE()
                ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
            `),

            this.c().query<RowDataPacket[]>(`
                SELECT
                    rc.table_name,
                    rc.constraint_name,
                    kcu.column_name,
                    kcu.referenced_table_schema,
                    kcu.referenced_table_name,
                    kcu.referenced_column_name,
                    rc.delete_rule,
                    rc.update_rule,
                    kcu.ordinal_position
                FROM information_schema.referential_constraints rc
                JOIN information_schema.key_column_usage kcu
                  ON rc.constraint_schema = kcu.constraint_schema
                 AND rc.constraint_name = kcu.constraint_name
                 AND rc.table_name = kcu.table_name
                WHERE rc.constraint_schema = DATABASE()
                ORDER BY rc.table_name, rc.constraint_name, kcu.ordinal_position
            `),

            this.c().query<RowDataPacket[]>(`
                SELECT
                    kcu.referenced_table_name,
                    rc.constraint_name,
                    kcu.column_name,
                    kcu.table_schema,
                    kcu.table_name,
                    kcu.referenced_column_name,
                    kcu.ordinal_position
                FROM information_schema.referential_constraints rc
                JOIN information_schema.key_column_usage kcu
                  ON rc.constraint_schema = kcu.constraint_schema
                 AND rc.constraint_name = kcu.constraint_name
                 AND rc.table_name = kcu.table_name
                WHERE kcu.referenced_table_schema = DATABASE()
                ORDER BY kcu.referenced_table_name, rc.constraint_name, kcu.ordinal_position
            `),

            this.c().query<RowDataPacket[]>(`
                SELECT TABLE_NAME  AS table_name,
                       INDEX_NAME  AS index_name,
                       COLUMN_NAME AS column_name,
                       INDEX_TYPE  AS index_type,
                       SEQ_IN_INDEX AS seq
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND NON_UNIQUE = 1
                ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
            `)
        ]);

        // Columns per table
        const colsByTable = new Map<string, any[]>();
        for (const r of colRows as any[]) {
            const tn = r.tn as string;
            if (!colsByTable.has(tn)) colsByTable.set(tn, []);
            colsByTable.get(tn)!.push(r);
        }

        // Unique constraints per table
        const uqsByTable = new Map<string, Map<string, string[]>>();
        for (const row of uniqueRows as any[]) {
            const tn = row.table_name as string;
            if (!uqsByTable.has(tn)) uqsByTable.set(tn, new Map());
            const m = uqsByTable.get(tn)!;
            if (!m.has(row.constraint_name)) m.set(row.constraint_name, []);
            m.get(row.constraint_name)!.push(row.column_name);
        }

        // Outgoing FKs per table
        const fksByTable = new Map<string, Map<string, ForeignKey & { onDelete?: string; onUpdate?: string }>>();
        for (const row of fkRows as any[]) {
            const tn = row.table_name as string;
            if (!fksByTable.has(tn)) fksByTable.set(tn, new Map());
            const m = fksByTable.get(tn)!;
            if (!m.has(row.constraint_name)) {
                m.set(row.constraint_name, {
                    columns: [],
                    refSchema: row.referenced_table_schema,
                    refTable: row.referenced_table_name,
                    refColumns: [],
                    onDelete: row.delete_rule,
                    onUpdate: row.update_rule
                });
            }
            const fk = m.get(row.constraint_name)!;
            fk.columns.push(row.column_name);
            fk.refColumns.push(row.referenced_column_name);
        }

        // Indexes per table
        const idxsByTable = new Map<string, Map<string, { columns: string[]; type: string }>>();
        for (const row of idxRows as any[]) {
            const tn = row.table_name as string;
            if (!idxsByTable.has(tn)) idxsByTable.set(tn, new Map());
            const m = idxsByTable.get(tn)!;
            if (!m.has(row.index_name)) m.set(row.index_name, { columns: [], type: row.index_type as string });
            m.get(row.index_name)!.columns.push(row.column_name);
        }

        // Incoming FKs per referenced table
        const refsByTable = new Map<string, Map<string, ForeignKey>>();
        for (const row of refRows as any[]) {
            const tn = row.referenced_table_name as string;
            if (!refsByTable.has(tn)) refsByTable.set(tn, new Map());
            const m = refsByTable.get(tn)!;
            if (!m.has(row.constraint_name)) {
                m.set(row.constraint_name, {
                    columns: [],
                    refSchema: row.table_schema,
                    refTable: row.table_name,
                    refColumns: []
                });
            }
            const ref = m.get(row.constraint_name)!;
            ref.columns.push(row.column_name);
            ref.refColumns.push(row.referenced_column_name);
        }

        return refs.map(({ schema, name }) => {
            const uqMap = uqsByTable.get(name) ?? new Map<string, string[]>();
            const uniqueConstraints = [...uqMap.values()];
            const uqSet = new Set(uniqueConstraints.flat());

            const tableCols = colsByTable.get(name) ?? [];

            const columns: ColumnMeta[] = tableCols.map((r) => ({
                name: r.col_name,
                dataType: formatMysqlType({
                    column_type: r.col_type,
                    data_type: r.data_type,
                    character_maximum_length: r.char_max_len,
                    numeric_precision: r.num_prec,
                    numeric_scale: r.num_scale
                }),
                nullable: r.is_nullable === 'YES',
                isPrimaryKey: r.col_key === 'PRI',
                isUnique: r.col_key === 'UNI' || uqSet.has(r.col_name),
                default: r.col_default,
                comment: null
            }));

            const idxMap = idxsByTable.get(name) ?? new Map<string, { columns: string[]; type: string }>();
            const indexes: IndexMeta[] = [...idxMap.entries()].map(([idxName, v]) => ({ name: idxName, columns: v.columns, type: v.type }));

            return {
                schema,
                name,
                columns,
                foreignKeys: [...(fksByTable.get(name)?.values() ?? [])],
                referencedBy: [...(refsByTable.get(name)?.values() ?? [])],
                uniqueConstraints,
                indexes
            };
        });
    }

    async getDiagram(): Promise<DiagramPayload> {
        const refs = await this.listTables();
        const tables = await this.loadAllTables(refs);
        return { tables };
    }

    /** Stream on a dedicated read-only connection, with a deadline covering connection setup too. */
    async executeQuery(sql: string): Promise<QueryData> {
        if (!this.queryOptions) throw new Error('Not connected');
        const options = this.queryOptions;
        const startedAt = Date.now();
        const generation = this.generation;
        return new Promise<QueryData>((resolve, reject) => {
            let connection: Connection | null = null;
            const rows: unknown[][] = [];
            let columns: string[] = [];
            let settled = false;
            const finish = (error?: Error, truncated = false) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                // Closing the dedicated connection rolls back its read-only transaction.
                connection?.destroy();
                if (this.activeQueryConnection === connection) this.activeQueryConnection = null;
                if (this.cancelQuery === cancel) this.cancelQuery = null;
                if (error) reject(error);
                else resolve({ columns, rows: rows.map(toQueryRow), truncated,
                    durationMs: Date.now() - startedAt, rowLimit: QUERY_ROW_LIMIT });
            };
            const cancel = () => finish(new Error('Connection was closed while running the query'));
            this.cancelQuery = cancel;
            const timeout = setTimeout(() => finish(new Error(`Query timed out after ${QUERY_TIMEOUT_MS / 1000} seconds`)), QUERY_TIMEOUT_MS);
            mysql.createConnection({ ...options, rowsAsArray: true, connectTimeout: QUERY_TIMEOUT_MS })
                .then(async connected => {
                    if (settled || generation !== this.generation) {
                        connected.destroy();
                        cancel();
                        return;
                    }
                    connection = connected;
                    this.activeQueryConnection = connected;
                    await connected.query('SET TRANSACTION READ ONLY');
                    if (settled) return;
                    await connected.beginTransaction();
                    if (settled) return;
                    // The promise wrapper exposes its underlying connection for streaming.
                    const streamConnection = (connected as Connection & { connection: StreamingConnection }).connection;
                    const query = streamConnection.query({ sql, rowsAsArray: true });
                    query.on('fields', (fields: FieldPacket[]) => { columns = fields.map(field => field.name); });
                    query.on('result', (row: unknown[]) => {
                        if (settled) return;
                        if (rows.length === QUERY_ROW_LIMIT) { finish(undefined, true); return; }
                        rows.push(row);
                    });
                    query.on('error', finish);
                    query.on('end', () => finish());
                }).catch(finish);
        });
    }

    async explainQuery(sql: string): Promise<RawQueryPlan> {
        if (!this.queryOptions) throw new Error('Not connected');
        const startedAt = Date.now();
        const generation = this.generation;
        let connection: Connection | null = null;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; connection?.destroy(); }, QUERY_TIMEOUT_MS);
        try {
            connection = await mysql.createConnection({ ...this.queryOptions, connectTimeout: QUERY_TIMEOUT_MS });
            this.activeQueryConnection = connection;
            if (timedOut) throw new Error(`Plan timed out after ${QUERY_TIMEOUT_MS / 1000} seconds`);
            if (generation !== this.generation) throw new Error('Connection was closed while starting the plan');
            await connection.query('SET TRANSACTION READ ONLY');
            if (timedOut || generation !== this.generation) throw new Error(timedOut ? `Plan timed out after ${QUERY_TIMEOUT_MS / 1000} seconds` : 'Connection was closed while starting the plan');
            await connection.beginTransaction();
            if (timedOut || generation !== this.generation) throw new Error(timedOut ? `Plan timed out after ${QUERY_TIMEOUT_MS / 1000} seconds` : 'Connection was closed while starting the plan');
            const [rows] = await connection.query<RowDataPacket[]>(`EXPLAIN FORMAT=JSON ${stripMysqlTrailingSemicolon(sql)}`);
            if (timedOut || generation !== this.generation) throw new Error(timedOut ? `Plan timed out after ${QUERY_TIMEOUT_MS / 1000} seconds` : 'Connection was closed while starting the plan');
            const raw = String((rows as any[])[0]?.EXPLAIN ?? '');
            if (!raw) throw new Error('MySQL did not return a JSON query plan');
            if (raw.length > PLAN_TEXT_LIMIT) throw new Error(`Query plan exceeds the ${PLAN_TEXT_LIMIT} character limit`);
            return { format: 'json', raw, durationMs: Date.now() - startedAt };
        } catch (error) {
            if (timedOut) throw new Error(`Plan timed out after ${QUERY_TIMEOUT_MS / 1000} seconds`);
            throw error;
        } finally {
            clearTimeout(timeout);
            connection?.destroy();
            if (this.activeQueryConnection === connection) this.activeQueryConnection = null;
        }
    }

}

function stripMysqlTrailingSemicolon(sql: string): string { return sql.trim().replace(/;\s*$/, ''); }

function formatMysqlType(r: {
    column_type: string;
    data_type: string;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
}): string {
    if (
        r.data_type === 'varchar' ||
        r.data_type === 'char' ||
        r.data_type === 'binary' ||
        r.data_type === 'varbinary'
    ) {
        return r.character_maximum_length != null
            ? `${r.data_type}(${r.character_maximum_length})`
            : r.data_type;
    }

    if (
        ['decimal', 'numeric'].includes(r.data_type) &&
        r.numeric_precision != null
    ) {
        return r.numeric_scale != null
            ? `${r.data_type}(${r.numeric_precision},${r.numeric_scale})`
            : `${r.data_type}(${r.numeric_precision})`;
    }

    return r.column_type;
}
