import type { TableRef } from './schema';

export const QUERY_ROW_LIMIT = 500;
export const QUERY_TIMEOUT_MS = 15_000;

export type QueryStageKind = 'source' | 'join' | 'filter' | 'group' | 'having' | 'project' | 'distinct' | 'sort' | 'limit' | 'set' | 'result';

/** A physical table/column used by one logical query stage. */
export type QueryStageReference = {
    /** null is reserved for an unqualified column; see candidates. */
    table: TableRef | null;
    /** null means source rows; '*' means all columns, as in SELECT *. */
    column: string | null;
    /** Direct physical FROM scope for an unqualified column. */
    candidates?: TableRef[];
};

export type QueryStage = {
    kind: QueryStageKind;
    label: string;
    detail: string;
    focus: 'tables' | 'columns' | 'result';
    references: QueryStageReference[];
    unresolved?: boolean;
};

export type QueryAnalysis = {
    tables: TableRef[];
    stages: QueryStage[];
    warnings: string[];
};

export type QueryValue = string | number | boolean | null;

export type QueryData = {
    columns: string[];
    rows: QueryValue[][];
    durationMs: number;
    truncated: boolean;
    rowLimit: number;
};

export type QueryResult = QueryData & { analysis: QueryAnalysis };
