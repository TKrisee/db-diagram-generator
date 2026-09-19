import type { ConnectionConfig, DiagramPayload, TableSchema } from '@shared/schema';
import { QUERY_ROW_LIMIT, QUERY_TIMEOUT_MS, type QueryData } from '@shared/query';
import { spawn, type ChildProcess } from 'node:child_process';
import type { DbAdapter } from './types';

const users: TableSchema = {
    schema: 'public',
    name: 'users',
    columns: [
        { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, isUnique: false, default: null, comment: null },
        { name: 'email', dataType: 'varchar(255)', nullable: false, isPrimaryKey: false, isUnique: true, default: null, comment: null },
        { name: 'name', dataType: 'varchar(120)', nullable: true, isPrimaryKey: false, isUnique: false, default: null, comment: null },
        { name: 'created_at', dataType: 'timestamptz', nullable: false, isPrimaryKey: false, isUnique: false, default: 'now()', comment: null }
    ],
    foreignKeys: [],
    referencedBy: [
        { columns: ['id'], refSchema: 'public', refTable: 'orders', refColumns: ['user_id'] },
        { columns: ['id'], refSchema: 'public', refTable: 'sessions', refColumns: ['user_id'] }
    ],
    uniqueConstraints: [['email']],
    indexes: [{ name: 'idx_users_name', columns: ['name'], type: 'BTREE' }]
};

const orders: TableSchema = {
    schema: 'public',
    name: 'orders',
    columns: [
        { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, isUnique: false, default: null, comment: null },
        { name: 'user_id', dataType: 'bigint', nullable: false, isPrimaryKey: false, isUnique: false, default: null, comment: null },
        { name: 'total', dataType: 'numeric(10,2)', nullable: false, isPrimaryKey: false, isUnique: false, default: '0', comment: null },
        { name: 'status', dataType: 'varchar(32)', nullable: false, isPrimaryKey: false, isUnique: false, default: "'pending'", comment: null }
    ],
    foreignKeys: [
        { columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE' }
    ],
    referencedBy: [],
    uniqueConstraints: [['user_id', 'status']],
    indexes: [
        { name: 'idx_orders_status', columns: ['status'], type: 'BTREE' },
        { name: 'idx_orders_user_created', columns: ['user_id', 'total'], type: 'BTREE' }
    ]
};

const sessions: TableSchema = {
    schema: 'public',
    name: 'sessions',
    columns: [
        { name: 'token', dataType: 'varchar(64)', nullable: false, isPrimaryKey: true, isUnique: false, default: null, comment: null },
        { name: 'user_id', dataType: 'bigint', nullable: false, isPrimaryKey: false, isUnique: false, default: null, comment: null },
        { name: 'expires_at', dataType: 'timestamptz', nullable: false, isPrimaryKey: false, isUnique: false, default: null, comment: null }
    ],
    foreignKeys: [
        { columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE' }
    ],
    referencedBy: [],
    uniqueConstraints: [],
    indexes: []
};

export class DemoAdapter implements DbAdapter {
    readonly dialect = 'demo' as const;
    private activeChild: ChildProcess | null = null;
    async connect(_cfg: ConnectionConfig) { }
    async disconnect() {
        this.activeChild?.kill('SIGKILL');
        this.activeChild = null;
    }

    async getDiagram(): Promise<DiagramPayload> {
        return { tables: [users, orders, sessions] };
    }

    /** A child process can be killed even while synchronous SQLite is executing native code. */
    async executeQuery(sql: string): Promise<QueryData> {
        const startedAt = Date.now();
        const child = spawn(process.execPath, ['-e', DEMO_QUERY_CHILD], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        this.activeChild = child;
        try {
            return await new Promise<QueryData>((resolve, reject) => {
                let settled = false;
                const finish = (error?: Error, value?: Omit<QueryData, 'durationMs'>) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    if (error) reject(error);
                    else resolve({ ...value!, durationMs: Date.now() - startedAt });
                };
                const timeout = setTimeout(() => {
                    child.kill('SIGKILL');
                    finish(new Error(`Query timed out after ${QUERY_TIMEOUT_MS / 1000} seconds`));
                }, QUERY_TIMEOUT_MS);
                child.on('message', (result: ({ ready?: boolean; error?: string } & Partial<Omit<QueryData, 'durationMs'>>)) => {
                    if (result.ready) {
                        child.send({ sql, rowLimit: QUERY_ROW_LIMIT }, (error) => { if (error) finish(error); });
                        return;
                    }
                    if (result.error) finish(new Error(result.error));
                    else finish(undefined, result as Omit<QueryData, 'durationMs'>);
                });
                child.once('error', finish);
                child.once('exit', (code, signal) => {
                    if (code !== 0) finish(new Error('Demo query process exited' + (signal ? ' (' + signal + ')' : ' with code ' + code)));
                });
            });
        } finally {
            if (this.activeChild === child) this.activeChild = null;
            child.kill('SIGKILL');
        }
    }
}

// Keep the SQL data out of Electron's main process: node:sqlite is synchronous and cannot be interrupted there.
const DEMO_QUERY_CHILD = String.raw`
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec("ATTACH DATABASE ':memory:' AS public;");
db.exec([
    'CREATE TABLE public.users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL);',
    'CREATE TABLE public.orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, total REAL NOT NULL, status TEXT NOT NULL);',
    'CREATE TABLE public.sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL);',
    "INSERT INTO public.users VALUES (1, 'ada@example.test', 'Ada Lovelace', '2025-01-10T09:00:00.000Z'), (2, 'linus@example.test', 'Linus Torvalds', '2025-02-14T12:30:00.000Z'), (3, 'grace@example.test', 'Grace Hopper', '2025-03-03T08:15:00.000Z');",
    "INSERT INTO public.orders VALUES (101, 1, 89.50, 'paid'), (102, 1, 25.00, 'pending'), (103, 2, 150.00, 'paid'), (104, 3, 42.75, 'refunded');",
    "INSERT INTO public.sessions VALUES ('ada-active', 1, '2026-01-01T00:00:00.000Z'), ('linus-active', 2, '2026-02-01T00:00:00.000Z'), ('grace-expired', 3, '2024-01-01T00:00:00.000Z');"
].join('\n'));
db.exec('PRAGMA query_only = ON;');
process.send({ ready: true });
process.once('message', (workerData) => {
  try {
  const statement = db.prepare(workerData.sql);
  const columns = statement.columns().map((column) => column.name || '');
  if (typeof statement.setReturnArrays !== 'function') throw new Error('Demo queries require node:sqlite StatementSync.setReturnArrays().');
  statement.setReturnArrays(true);
  const rows = [];
  let truncated = false;
  for (const row of statement.iterate()) {
    if (rows.length === workerData.rowLimit) { truncated = true; break; }
    rows.push(row.map((value) => {
      if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Date) return value.toISOString();
      if (Buffer.isBuffer(value)) return value.toString('base64');
      return String(value);
    }));
  }
  process.send({ columns, rows, truncated, rowLimit: workerData.rowLimit });
  } catch (error) {
    process.send({ error: error instanceof Error ? error.message : String(error) });
  } finally { db.close(); }
});
`;
