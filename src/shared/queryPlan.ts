import type { QueryAnalysis } from './query';
import type { Dialect, TableRef } from './schema';

export const PLAN_NODE_LIMIT = 250;
export const PLAN_TEXT_LIMIT = 2_000_000;

/** Native estimated plans only: collecting a plan does not run the SELECT. */
export type RawQueryPlan = {
    format: 'json' | 'xml';
    raw: string;
    durationMs: number;
};

export type QueryPlanNode = {
    id: string;
    label: string;
    kind: 'scan' | 'join' | 'filter' | 'sort' | 'aggregate' | 'limit' | 'other';
    /** Inputs to this operator. Edges flow from these children to this node. */
    children: string[];
    relation?: TableRef;
    alias?: string;
    index?: string;
    estimatedRows?: number;
    cost?: number;
    details: { label: string; value: string }[];
};

export type QueryPlan = RawQueryPlan & {
    engine: Dialect;
    nodes: QueryPlanNode[];
    roots: string[];
    warnings: string[];
};

export type QueryPlanResult = QueryPlan & { analysis: QueryAnalysis };
