import type { ConnectionConfig, DiagramPayload } from '@shared/schema';
import type { QueryData } from '@shared/query';
import type { DbAdapter } from './types';
import type { RawQueryPlan } from '@shared/queryPlan';

export class SqliteAdapter implements DbAdapter {
    readonly dialect = 'sqlite' as const;
    async connect(_cfg: ConnectionConfig): Promise<void> {
        throw new Error('SQLite adapter: not yet implemented.');
    }
    async disconnect(): Promise<void> { }
    async getDiagram(): Promise<DiagramPayload> {
        throw new Error('SQLite adapter: not yet implemented.');
    }
    async executeQuery(_sql: string): Promise<QueryData> {
        throw new Error('SQLite adapter: not yet implemented.');
    }
    async explainQuery(_sql: string): Promise<RawQueryPlan> {
        throw new Error('SQLite adapter: not yet implemented.');
    }
}
