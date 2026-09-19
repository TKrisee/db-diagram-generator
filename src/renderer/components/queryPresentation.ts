import type { Dialect, TableRef, TableSchema } from '@shared/schema';
import type { QueryStage, QueryValue } from '@shared/query';

export type QueryStageFocus = {
    keys: Set<string>;
    columns: Map<string, Set<string>>;
    labels: string[];
    warnings: string[];
};

const tableKey = (table: TableRef) => `${table.schema ?? ''}.${table.name}`;

function tableLabel(table: TableSchema, tables: TableSchema[]) {
    return tables.filter(candidate => candidate.name === table.name).length > 1 && table.schema
        ? `${table.schema}.${table.name}`
        : table.name;
}

/** Resolve a walkthrough stage only where the SQL analysis proves a diagram target. */
export function resolveQueryStage(stage: QueryStage | undefined, tables: TableSchema[]): QueryStageFocus {
    const keys = new Set<string>();
    const columns = new Map<string, Set<string>>();
    const labels: string[] = [];
    const warnings: string[] = [];
    const response = () => ({ keys, columns, labels, warnings: [...new Set(warnings)] });

    if (!stage || stage.focus === 'result') return response();
    if (stage.unresolved) warnings.push('Some references in this stage could not be traced to a source table.');

    const addLabel = (label: string) => {
        if (!labels.includes(label)) labels.push(label);
    };
    const addTable = (table: TableSchema) => {
        keys.add(tableKey(table));
        return tableLabel(table, tables);
    };
    const addColumn = (table: TableSchema, column: string, label = true) => {
        const key = tableKey(table);
        const selected = columns.get(key) ?? new Set<string>();
        selected.add(column);
        columns.set(key, selected);
        if (label) addLabel(`${tableLabel(table, tables)}.${column}`);
    };
    const resolveTable = (ref: TableRef, purpose: string) => {
        const matches = tables.filter(table => table.name === ref.name && (ref.schema === null || table.schema === ref.schema));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) warnings.push(`Cannot identify ${purpose}: ${ref.name} has multiple schemas.`);
        else warnings.push(`${ref.schema ? `${ref.schema}.` : ''}${ref.name} is not in the loaded schema diagram.`);
        return undefined;
    };
    const resolveCandidates = (candidates: TableRef[] | undefined) => {
        if (!candidates?.length) {
            warnings.push('Cannot resolve this column because its source table is unknown.');
            return [];
        }
        const attempted = candidates.map(candidate => resolveTable(candidate, 'source table'));
        // A missing or ambiguous member of the SQL scope means an unqualified
        // column cannot be proven, even if another candidate happens to match.
        if (attempted.some(table => !table)) return [];
        const resolved = attempted.filter((table): table is TableSchema => Boolean(table));
        return [...new Map(resolved.map(table => [tableKey(table), table])).values()];
    };

    for (const reference of stage.references) {
        if (reference.table) {
            const table = resolveTable(reference.table, 'table');
            if (!table) continue;
            if (reference.column === null) {
                addLabel(addTable(table));
                continue;
            }
            if (reference.column === '*') {
                const label = addTable(table);
                for (const column of table.columns) addColumn(table, column.name, false);
                addLabel(`${label}.*`);
                continue;
            }
            const label = tableLabel(table, tables);
            if (table.columns.some(column => column.name === reference.column)) {
                addTable(table);
                addColumn(table, reference.column);
            } else warnings.push(`${label}.${reference.column} is not in the loaded schema diagram.`);
            continue;
        }

        if (reference.column === null) {
            warnings.push('Cannot resolve a table reference without a table name.');
            continue;
        }
        const candidates = resolveCandidates(reference.candidates);
        if (!candidates.length) continue;
        if (reference.column === '*') {
            for (const table of candidates) {
                const label = addTable(table);
                for (const column of table.columns) addColumn(table, column.name, false);
                addLabel(`${label}.*`);
            }
            continue;
        }
        const matches = candidates.filter(table => table.columns.some(column => column.name === reference.column));
        if (matches.length === 1) {
            const table = matches[0];
            addTable(table);
            addColumn(table, reference.column);
        } else if (matches.length > 1) {
            warnings.push(`Cannot resolve ${reference.column}: it is ambiguous across source tables.`);
        } else {
            warnings.push(`${reference.column} is not in the active source tables.`);
        }
    }

    return response();
}

export function resolveQueryTables(refs: TableRef[], tables: TableSchema[]) {
    const keys = new Set<string>();
    const warnings: string[] = [];
    for (const ref of refs) {
        const matches = tables.filter(t => t.name === ref.name && (ref.schema === null || ref.schema === t.schema));
        if (matches.length === 1) keys.add(`${matches[0].schema ?? ''}.${matches[0].name}`);
        else if (matches.length > 1) warnings.push(`Qualify ${ref.name} with its schema to identify it in the diagram.`);
        else warnings.push(`${ref.schema ? ref.schema + '.' : ''}${ref.name} is not in the loaded schema diagram.`);
    }
    return { keys, warnings };
}

export function quoteIdentifier(value: string, dialect: Dialect) {
    if (dialect === 'mysql') return '`' + value.replaceAll('`', '``') + '`';
    if (dialect === 'mssql') return '[' + value.replaceAll(']', ']]') + ']';
    return '"' + value.replaceAll('"', '""') + '"';
}

export function initialQuery(tables: TableSchema[], dialect: Dialect) {
    if (dialect === 'demo') return `SELECT u.name, o.id AS order_id, o.total, o.status
FROM public.users AS u
JOIN public.orders AS o ON o.user_id = u.id
WHERE o.total >= 50
ORDER BY o.total DESC;`;
    const table = tables[0];
    if (!table) return 'SELECT 1 AS value;';
    const name = [table.schema, table.name].filter((s): s is string => s !== null)
        .map(s => quoteIdentifier(s, dialect)).join('.');
    return dialect === 'mssql' ? `SELECT TOP 100 *\nFROM ${name};` : `SELECT *\nFROM ${name}\nLIMIT 100;`;
}

export function displayValue(value: QueryValue) {
    return value === null ? 'NULL' : String(value);
}
