import type { ConnectionConfig, DiagramPayload } from './schema';
import type { QueryAnalysis, QueryResult } from './query';

export const IPC = {
    connect: 'db:connect',
    disconnect: 'db:disconnect',
    getDiagram: 'db:getDiagram',
    analyzeQuery: 'db:analyzeQuery',
    executeQuery: 'db:executeQuery',
    listSaved: 'conn:list',
    saveConnection: 'conn:save',
    deleteConnection: 'conn:delete',
    loadSaved: 'conn:load'
} as const;

export type ConnectResult = { ok: true } | { ok: false; error: string };
export type SaveResult = { ok: true; id: string } | { ok: false; error: string };

export type SavedConnectionMeta = {
    id: string;
    name: string;
    dialect: ConnectionConfig['dialect'];
    host?: string;
    port?: number;
    user?: string;
    database?: string;
    file?: string;
    ssl?: boolean;
    ssh?: { host: string; port: number; user: string };
};

export type IpcContract = {
    connect: (cfg: ConnectionConfig) => Promise<ConnectResult>;
    disconnect: () => Promise<void>;
    getDiagram: () => Promise<DiagramPayload>;
    analyzeQuery: (sql: string) => Promise<QueryAnalysis>;
    executeQuery: (sql: string) => Promise<QueryResult>;
    listSaved: () => Promise<SavedConnectionMeta[]>;
    saveConnection: (name: string, cfg: ConnectionConfig) => Promise<SaveResult>;
    deleteConnection: (id: string) => Promise<void>;
    loadSaved: (id: string) => Promise<ConnectionConfig>;
};
