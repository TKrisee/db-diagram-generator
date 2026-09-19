import { DOMParser } from '@xmldom/xmldom';
import { PLAN_NODE_LIMIT, PLAN_TEXT_LIMIT, type QueryPlan, type QueryPlanNode, type RawQueryPlan } from '../shared/queryPlan';
import type { Dialect, TableRef } from '../shared/schema';

type JsonObject = Record<string, unknown>;

class PlanLimitError extends Error {
    constructor() { super(`Plan exceeds the ${PLAN_NODE_LIMIT} node limit and was not normalized.`); }
}

class PlanBuilder {
    readonly nodes: QueryPlanNode[] = [];
    readonly warnings: string[] = [];
    private nextId = 1;

    warn(message: string): void { this.warnings.push(message); }

    add(input: Omit<QueryPlanNode, 'id' | 'children'>, children: string[] = []): string | null {
        if (this.nodes.length >= PLAN_NODE_LIMIT) {
            throw new PlanLimitError();
        }
        const id = `plan-${this.nextId++}`;
        this.nodes.push({ ...input, id, children });
        return id;
    }
}

export function normalizeQueryPlan(plan: RawQueryPlan, dialect: Dialect): QueryPlan {
    const builder = new PlanBuilder();
    const result: QueryPlan = { ...plan, engine: dialect, nodes: builder.nodes, roots: [], warnings: builder.warnings };
    if (!plan.raw.trim()) {
        builder.warnings.push('The database returned an empty plan.');
        return result;
    }
    if (plan.raw.length > PLAN_TEXT_LIMIT) {
        builder.warnings.push(`Plan text exceeds the ${PLAN_TEXT_LIMIT.toLocaleString()} character limit.`);
        return result;
    }
    try {
        let roots: string[] = [];
        if (dialect === 'postgres') roots = postgres(plan.raw, builder);
        else if (dialect === 'mysql') roots = mysql(plan.raw, builder);
        else if (dialect === 'mssql') roots = mssql(plan.raw, builder);
        else if (dialect === 'sqlite' || dialect === 'demo') roots = sqlite(plan.raw, builder);
        else builder.warnings.push(`Estimated plans are not supported for ${dialect}.`);
        result.roots = roots;
        if (!roots.length && !builder.warnings.length) builder.warnings.push('The plan did not contain recognizable operators.');
    } catch (error) {
        builder.nodes.length = 0;
        result.roots = [];
        builder.warnings.push(error instanceof PlanLimitError ? error.message : 'The database returned a malformed or unsupported estimated plan.');
    }
    return result;
}

function json(raw: string): unknown { return JSON.parse(raw); }
function object(value: unknown): JsonObject | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null; }
function number(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function details(source: JsonObject, keys: string[]): { label: string; value: string }[] {
    return keys.flatMap((key) => {
        const value = source[key];
        const rendered = detailValue(value);
        return rendered ? [{ label: key.replace(/_/g, ' '), value: rendered }] : [];
    });
}
function detailValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value.trim() || undefined;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value) || object(value)) {
        try { return JSON.stringify(value); } catch { return undefined; }
    }
    return undefined;
}
function relation(name: unknown, schema?: unknown): TableRef | undefined {
    const table = string(name);
    return table ? { name: table, schema: string(schema) ?? null } : undefined;
}
function kind(name: string): QueryPlanNode['kind'] {
    const value = name.toLowerCase();
    if (/scan|seek|lookup|table access|index/.test(value)) return 'scan';
    if (/join|nested loop|merge/.test(value)) return 'join';
    if (/filter|having/.test(value)) return 'filter';
    if (/sort|order|temp b-tree/.test(value)) return 'sort';
    if (/aggregate|group|hash match/.test(value)) return 'aggregate';
    if (/limit|top/.test(value)) return 'limit';
    return 'other';
}

function postgres(raw: string, builder: PlanBuilder): string[] {
    const top = json(raw);
    const entries = Array.isArray(top) ? top : [top];
    const plans = entries.map(object).map((entry) => entry && object(entry.Plan)).filter((entry): entry is JsonObject => !!entry);
    if (!plans.length) throw new Error('not postgres explain json');
    if (plans.reduce((sum, plan) => sum + postgresCount(plan), 0) > PLAN_NODE_LIMIT) {
        builder.warn(`Plan exceeds the ${PLAN_NODE_LIMIT} node limit and was not normalized.`);
        return [];
    }
    const roots = plans.flatMap((plan) => {
        const id = postgresNode(plan, builder, 0);
        return id ? [id] : [];
    });
    if (!roots.length) throw new Error('not postgres explain json');
    return roots;
}
function postgresCount(value: JsonObject): number {
    const pending = [value];
    let count = 0;
    while (pending.length) {
        const next = pending.pop()!;
        if (++count > PLAN_NODE_LIMIT) return count;
        for (const child of list(next.Plans)) { const plan = object(child); if (plan) pending.push(plan); }
    }
    return count;
}
function postgresNode(value: JsonObject, builder: PlanBuilder, depth: number): string | null {
    if (depth > PLAN_NODE_LIMIT) throw new PlanLimitError();
    const children = list(value.Plans).map((child) => object(child)).flatMap((child) => child ? [postgresNode(child, builder, depth + 1)] : []).filter((id): id is string => !!id);
    const label = string(value['Node Type']);
    if (!label) return null;
    return builder.add({ label, kind: kind(label), relation: relation(value['Relation Name'], value.Schema), alias: string(value.Alias), index: string(value['Index Name']), estimatedRows: number(value['Plan Rows']), cost: number(value['Total Cost']), details: details(value, ['Filter', 'Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Recheck Cond', 'TID Cond', 'Join Type', 'Sort Key', 'Group Key', 'Output', 'Strategy']) }, children);
}

function mysql(raw: string, builder: PlanBuilder): string[] {
    const value = object(json(raw));
    const block = value && object(value.query_block);
    if (!block) throw new Error('not mysql explain json');
    builder.warnings.push('MySQL FORMAT=JSON does not expose a complete physical data-flow graph; join algorithms are not inferred.');
    const id = mysqlPart(block, builder, 0, 'Query block');
    return id ? [id] : [];
}
function mysqlPart(value: JsonObject, builder: PlanBuilder, depth: number, fallback: string): string | null {
    if (depth > PLAN_NODE_LIMIT) throw new PlanLimitError();
    const table = object(value.table);
    const nested = list(value.nested_loop);
    const nestedChildren = nested.map(object).filter((item): item is JsonObject => !!item).flatMap((item) => {
        const id = mysqlPart(item, builder, depth + 1, 'Nested operation'); return id ? [id] : [];
    });
    const subqueries = mysqlSubqueries(value, builder, depth + 1);
    if (table) {
        const tableName = string(table.table_name);
        // MySQL can print an alias in table_name. Only the SQL-aware linker can
        // establish that it names a physical source.
        return builder.add({ label: tableName ?? 'Table access', kind: 'scan', alias: tableName, index: string(table.key), estimatedRows: number(table.rows_examined_per_scan) ?? number(table.rows_produced_per_join), cost: mysqlCost(table), details: details(table, ['access_type', 'attached_condition', 'using_index', 'using_filesort', 'rows_examined_per_scan', 'rows_produced_per_join', 'filtered']) }, [...subqueries, ...mysqlSubqueries(table, builder, depth + 1)]);
    }
    const wrappers: Array<[string, QueryPlanNode['kind']]> = [['ordering_operation', 'sort'], ['grouping_operation', 'aggregate'], ['duplicates_removal', 'other'], ['windowing', 'other']];
    for (const [key, nodeKind] of wrappers) {
        const child = object(value[key]);
        if (child) {
            const id = mysqlPart(child, builder, depth + 1, key.replace(/_/g, ' '));
            return builder.add({ label: key.replace(/_/g, ' '), kind: nodeKind, estimatedRows: number(child.rows_examined_per_scan), cost: mysqlCost(child), details: details(child, ['using_filesort', 'using_temporary_table', 'rows_examined_per_scan', 'rows_produced_per_join', 'filtered']) }, id ? [id, ...subqueries] : [...nestedChildren, ...subqueries]);
        }
    }
    return builder.add({ label: nestedChildren.length ? 'Join inputs (plan order)' : fallback, kind: nestedChildren.length ? 'join' : 'other', cost: number(object(value.cost_info)?.query_cost), details: details(value, ['select_id', 'message']) }, [...nestedChildren, ...subqueries]);
}
function mysqlCost(value: JsonObject): number | undefined {
    const costs = object(value.cost_info);
    return number(costs?.prefix_cost) ?? number(costs?.query_cost);
}
function mysqlSubqueries(value: JsonObject, builder: PlanBuilder, depth: number): string[] {
    const candidates: JsonObject[] = [];
    for (const key of ['materialized_from_subquery', 'attached_subqueries']) {
        const single = object(value[key]); if (single) candidates.push(single);
        candidates.push(...list(value[key]).map(object).filter((item): item is JsonObject => !!item));
    }
    const union = object(value.union_result);
    if (union) candidates.push(...list(union.query_specifications).map(object).filter((item): item is JsonObject => !!item));
    return candidates.flatMap((entry) => {
        const block = object(entry.query_block) ?? entry;
        const id = mysqlPart(block, builder, depth, 'Subquery');
        return id ? [id] : [];
    });
}

function mssql(raw: string, builder: PlanBuilder): string[] {
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<ShowPlanXML/i.test(raw) || /<!DOCTYPE/i.test(raw)) throw new Error('not xml');
    let xmlError = false;
    const doc = new DOMParser({ errorHandler: { error: () => { xmlError = true; }, fatalError: () => { xmlError = true; } } }).parseFromString(raw, 'text/xml');
    if (xmlError || doc.getElementsByTagName('parsererror').length) throw new Error('bad xml');
    const elements = Array.from(doc.getElementsByTagName('*'));
    if (elements.length > PLAN_NODE_LIMIT * 20) throw new Error('xml traversal limit');
    const all = elements.filter((element) => element.localName === 'RelOp');
    if (all.length > PLAN_NODE_LIMIT) throw new PlanLimitError();
    const parents = new Set(all.flatMap((element) => directRelOps(element)));
    const roots = all.filter((element) => !parents.has(element)).map((element) => mssqlNode(element, builder, 0)).filter((id): id is string => !!id);
    if (!roots.length) throw new Error('no relops');
    return roots;
}
function directRelOps(element: Element): Element[] {
    const found: Element[] = [];
    const visit = (node: Element) => childElements(node).forEach((child) => {
        if (child.localName === 'RelOp') found.push(child); else visit(child);
    });
    visit(element); return found;
}
function ownElements(element: Element, name: string): Element[] {
    const result: Element[] = [];
    const visit = (node: Element) => childElements(node).forEach((child) => {
        if (child.localName === 'RelOp') return;
        if (child.localName === name) result.push(child);
        visit(child);
    });
    visit(element); return result;
}
function childElements(element: Element): Element[] {
    return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
}
function mssqlNode(element: Element, builder: PlanBuilder, depth: number): string | null {
    if (depth > PLAN_NODE_LIMIT) throw new PlanLimitError();
    const children = directRelOps(element).map((child) => mssqlNode(child, builder, depth + 1)).filter((id): id is string => !!id);
    const physical = element.getAttribute('PhysicalOp') || '';
    const logical = element.getAttribute('LogicalOp') || '';
    const label = physical || logical || 'Operator';
    const objectElement = ownElements(element, 'Object')[0];
    const table = objectElement?.getAttribute('Table');
    const schema = objectElement?.getAttribute('Schema');
    const predicateElement = ['Predicate', 'SeekPredicates', 'ProbeResidual', 'Residual'].map((name) => ownElements(element, name)[0]).find((item): item is Element => !!item);
    const predicate = predicateElement ? scalarString(predicateElement) ?? predicateElement.textContent?.trim() : undefined;
    const order = ownElements(element, 'OrderByColumn').flatMap((item) => ownElements(item, 'ColumnReference')).map((item) => item.getAttribute('Column')).filter((item): item is string => !!item);
    const operatorDetails = [
        ...details({ 'Logical operation': element.getAttribute('LogicalOp') }, ['Logical operation']),
        ...(predicate ? [{ label: /seek/i.test(label) ? 'Seek predicate' : /join/i.test(`${logical} ${physical}`) ? 'Join predicate' : 'Predicate', value: predicate }] : []),
        ...(order.length ? [{ label: 'Order by', value: order.join(', ') }] : []),
    ];
    return builder.add({ label, kind: kind(`${logical} ${physical}`), relation: mssqlRelation(table, schema), alias: decodedIdentifier(objectElement?.getAttribute('Alias')), index: decodedIdentifier(objectElement?.getAttribute('Index')), estimatedRows: numericAttr(element, 'EstimateRows'), cost: numericAttr(element, 'EstimatedTotalSubtreeCost') ?? numericAttr(element, 'EstimateCPU'), details: operatorDetails }, children);
}
function scalarString(element: Element): string | undefined { return ownElements(element, 'ScalarOperator')[0]?.getAttribute('ScalarString') ?? undefined; }
function numericAttr(element: Element, name: string): number | undefined { const raw = element.getAttribute(name); return raw === null ? undefined : number(raw); }
function decodedIdentifier(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    return value.replace(/^\[|\]$/g, '').replace(/\]\]/g, ']') || undefined;
}
function mssqlRelation(table: string | null | undefined, schema: string | null | undefined): TableRef | undefined {
    if (!table) return undefined;
    const parts = table.match(/\[(?:[^\]]|\]\])+\]|[^.]+/g)?.map(decodedIdentifier).filter((part): part is string => !!part) ?? [];
    const name = parts.at(-1);
    return name ? { name, schema: decodedIdentifier(schema) ?? (parts.length > 1 ? parts.at(-2) ?? null : null) } : undefined;
}

function sqlite(raw: string, builder: PlanBuilder): string[] {
    const rows = json(raw);
    if (!Array.isArray(rows) || !rows.length) throw new Error('not eqp rows');
    const parsed = rows.map(object);
    if (parsed.some((row) => !row || typeof row.id !== 'number' || typeof row.parent !== 'number' || !string(row.detail))) throw new Error('invalid eqp row');
    const typed = parsed as JsonObject[];
    if (typed.length > PLAN_NODE_LIMIT) throw new PlanLimitError();
    if (new Set(typed.map((row) => row.id as number)).size !== typed.length) throw new Error('duplicate eqp row');
    builder.warnings.push('SQLite EXPLAIN QUERY PLAN rows describe loop order, not a complete data-flow tree.');
    const ids = new Map<number, string>();
    const children = new Map<number, number[]>();
    for (const row of typed) children.set(row.id as number, []);
    for (const row of typed) if (children.has(row.parent as number)) children.get(row.parent as number)?.push(row.id as number);
    const byId = new Map(typed.map((row) => [row.id as number, row]));
    const building = new Set<number>();
    const build = (row: JsonObject): string | null => {
        const rowId = row.id as number;
        if (ids.has(rowId)) return ids.get(rowId)!;
        if (building.has(rowId)) throw new Error('cyclic eqp rows');
        building.add(rowId);
        const detail = string(row.detail)!;
        const childIds = (children.get(rowId) ?? []).map((id) => byId.get(id)).flatMap((child) => child ? [build(child)] : []).filter((id): id is string => !!id);
        const match = /^(?:SCAN|SEARCH)\s+(?:TABLE\s+)?(.+?)(?:\s+USING\s+|\s+LEFT-JOIN\b|$)/i.exec(detail);
        const target = match?.[1];
        const name = target && !/^(?:(?:\d+\s+)?CONSTANT ROWS?|SUBQUERY \d+)$/i.test(target) ? target : undefined;
        // EQP only prints its scan target. It may be an SQL alias, so defer turning
        // it into a physical relation to the SQL-aware linker.
        const index = /USING\s+(?:COVERING\s+)?INDEX\s+(?:"([^"]+)"|\[([^\]]+)\]|([^\s(]+))/i.exec(detail);
        const nodeKind: QueryPlanNode['kind'] = /^SCAN\b/i.test(detail) && index ? 'scan' : kind(detail);
        const id = builder.add({ label: sqliteLabel(detail), kind: nodeKind, alias: name, index: index?.[1] ?? index?.[2] ?? index?.[3], details: [{ label: 'Operation', value: detail }] }, childIds);
        building.delete(rowId);
        if (id) ids.set(rowId, id);
        return id;
    };
    const roots = typed.filter((row) => !byId.has(row.parent as number));
    if (!roots.length) throw new Error('cyclic eqp rows');
    const result = roots.map(build).filter((id): id is string => !!id);
    // A disconnected cycle has no root, so validate every row after building roots.
    for (const row of typed) build(row);
    return result;
}
function sqliteLabel(detail: string): string {
    if (/^SEARCH\b/i.test(detail)) return 'Index search';
    if (/^SCAN\b/i.test(detail)) return /USING\s+(?:COVERING\s+)?INDEX/i.test(detail) ? 'Index scan' : 'Table scan';
    if (/TEMP B-TREE/i.test(detail)) return 'Sort (temporary B-tree)';
    if (/COMPOUND QUERY/i.test(detail)) return 'Compound query';
    return detail.length > 72 ? `${detail.slice(0, 69)}…` : detail;
}
