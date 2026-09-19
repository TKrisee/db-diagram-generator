import type { ConnectionConfig, DiagramPayload, Dialect as SchemaDialect } from '@shared/schema';
import type { QueryData } from '@shared/query';

export type Dialect = SchemaDialect;

export interface DbAdapter {
    readonly dialect: ConnectionConfig['dialect'];
    connect(cfg: ConnectionConfig): Promise<void>;
    disconnect(): Promise<void>;
    getDiagram(): Promise<DiagramPayload>;
    executeQuery(sql: string): Promise<QueryData>;
}
