import { Parser } from 'node-sql-parser';
import { foldPostgresUnquotedAscii } from './queryAnalysis';
import type { Dialect, TableRef } from '../shared/schema';
import type { QueryPlan } from '../shared/queryPlan';

type Ast = Record<string, unknown>;

const DATABASES: Record<Dialect, string> = {
    postgres: 'Postgresql',
    mysql: 'MySQL',
    mssql: 'TransactSQL',
    sqlite: 'SQLite',
    demo: 'SQLite',
};

/**
 * Adds physical-table references when a plan format reports only a SQL alias.
 * Plan-native references are authoritative and are never replaced.  Because a
 * plan does not describe SQL scope, aliases are linked only when their meaning
 * is identical in every parsed scope and they never name a CTE or derived table.
 */
export function linkPlanRelations(plan: QueryPlan, sql: string, dialect: Dialect): QueryPlan {
    const aliases = aliasesInSql(sql, dialect);
    if (!aliases.size) return plan;

    let linked = false;
    const nodes = plan.nodes.map((node) => {
        if (node.relation || !node.alias) return node;
        const relation = aliases.get(key(node.alias));
        if (!relation) return node;
        linked = true;
        return { ...node, relation };
    });
    return linked ? { ...plan, nodes } : plan;
}

function aliasesInSql(sql: string, dialect: Dialect): Map<string, TableRef> {
    let parsed: unknown;
    try {
        parsed = new Parser().astify(dialect === 'postgres' ? foldPostgresUnquotedAscii(sql) : sql, { database: DATABASES[dialect] });
    } catch {
        return new Map();
    }
    if (!isAst(parsed) || Array.isArray(parsed) || parsed.type !== 'select') return new Map();

    const physical = new Map<string, TableRef[]>();
    const blocked = new Set<string>();
    collectScopes(parsed, physical, blocked, new Set());
    const resolved = new Map<string, TableRef>();
    for (const [alias, candidates] of physical) {
        if (blocked.has(alias) || !sameTable(candidates)) continue;
        resolved.set(alias, candidates[0]);
    }
    return resolved;
}

function collectScopes(select: Ast, physical: Map<string, TableRef[]>, blocked: Set<string>, inheritedCtes: Set<string>): void {
    const withItems = Array.isArray(select.with) ? select.with : [];
    const ctes = new Set(inheritedCtes);
    for (const item of withItems) {
        if (!isAst(item)) continue;
        const name = identifier(item.name);
        if (!name) continue;
        ctes.add(key(name));
        blocked.add(key(name));
    }
    for (const item of withItems) {
        if (!isAst(item)) continue;
        const nested = isAst(item.stmt) && isAst(item.stmt.ast) ? item.stmt.ast : item.stmt;
        if (isAst(nested) && nested.type === 'select') collectScopes(nested, physical, blocked, ctes);
    }

    for (const item of (Array.isArray(select.from) ? select.from : [])) {
        if (!isAst(item)) continue;
        const alias = typeof item.as === 'string' ? item.as : null;
        if (typeof item.table === 'string') {
            const sourceName = key(item.table);
            // An unqualified CTE source may have the same name as a catalog
            // table. The plan alias therefore cannot prove it is physical.
            if (item.db == null && ctes.has(sourceName)) blocked.add(key(alias ?? item.table));
            else {
                const source = table(item);
                addPhysical(physical, alias ?? item.table, source);
                // SQLite EQP retains the schema on unaliased qualified scans.
                if (!alias && source.schema) addPhysical(physical, `${source.schema}.${source.name}`, source);
            }
        } else {
            if (alias) blocked.add(key(alias));
            const nested = isAst(item.expr) && isAst(item.expr.ast) ? item.expr.ast : item.expr;
            if (isAst(nested) && nested.type === 'select') collectScopes(nested, physical, blocked, ctes);
        }
        // Derived sources were handled above, but JOIN predicates can contain
        // scalar SELECTs with conflicting aliases.
        walkNestedSelects(item, new Set(['expr']), (nested) => collectScopes(nested, physical, blocked, ctes));
    }

    // Scalar subqueries may introduce alias names too.  We do not link their
    // plan nodes by scope, but their aliases still make a global name unsafe.
    walkNestedSelects(select, new Set(['with', 'from', '_next']), (nested) => collectScopes(nested, physical, blocked, ctes));
    if (isAst(select._next) && select._next.type === 'select') collectScopes(select._next, physical, blocked, ctes);
}

function addPhysical(target: Map<string, TableRef[]>, alias: string, relation: TableRef): void {
    const name = key(alias);
    const entries = target.get(name) ?? [];
    entries.push(relation);
    target.set(name, entries);
}

function walkNestedSelects(value: unknown, skip: Set<string>, visit: (select: Ast) => void): void {
    if (Array.isArray(value)) return value.forEach((item) => walkNestedSelects(item, skip, visit));
    if (!isAst(value)) return;
    for (const [name, child] of Object.entries(value)) {
        if (skip.has(name)) continue;
        if (isAst(child) && child.type === 'select') { visit(child); continue; }
        if (isAst(child) && isAst(child.ast) && child.ast.type === 'select') { visit(child.ast); continue; }
        walkNestedSelects(child, skip, visit);
    }
}

function table(item: Ast): TableRef {
    return { schema: typeof item.db === 'string' ? item.db : null, name: item.table as string };
}

function sameTable(tables: TableRef[]): boolean {
    return tables.length > 0 && tables.every((candidate) => candidate.name === tables[0].name && candidate.schema === tables[0].schema);
}
function key(value: string): string { return value; }
function identifier(value: unknown): string | null {
    if (typeof value === 'string') return value;
    return isAst(value) && typeof value.value === 'string' ? value.value : null;
}
function isAst(value: unknown): value is Ast { return value !== null && typeof value === 'object' && !Array.isArray(value); }
