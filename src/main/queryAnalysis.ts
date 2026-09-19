import { Parser } from 'node-sql-parser';
import type { Dialect } from './db/types';
import type { TableRef } from '@shared/schema';
import type { QueryAnalysis, QueryStage, QueryStageKind, QueryStageReference } from '@shared/query';

type Ast = Record<string, unknown>;

const DATABASES: Record<Dialect, string> = {
    postgres: 'Postgresql',
    mysql: 'MySQL',
    mssql: 'TransactSQL',
    sqlite: 'SQLite',
    demo: 'SQLite',
};

const MUTATING_TYPES = new Set([
    'insert', 'update', 'delete', 'replace', 'merge', 'create', 'drop', 'alter', 'truncate',
    'grant', 'revoke', 'call', 'execute', 'transaction', 'begin', 'commit', 'rollback',
]);

/** Parses a safe, single read-only SELECT for execution through the query viewer. */
export function analyzeSelect(input: string, dialect: Dialect): { sql: string; analysis: QueryAnalysis } {
    if (typeof input !== 'string') throw new Error('SQL must be text.');
    if (input.length > 100_000) throw new Error('SQL is limited to 100,000 characters.');
    if (dialect === 'mysql' && containsExecutableMysqlComment(input)) {
        throw new Error('MySQL executable comments are not supported.');
    }
    const sql = removeTerminalSemicolon(input, dialect);
    if (!sql.trim()) throw new Error('Enter a SELECT statement.');

    // PostgreSQL folds unquoted identifiers to lower case; use that form only for analysis.
    // The returned SQL remains exactly what the user entered (apart from its terminal delimiter).
    const parserSql = dialect === 'postgres' ? foldPostgresUnquotedAscii(sql) : sql;
    let parsed: unknown;
    try {
        parsed = new Parser().astify(parserSql, { database: DATABASES[dialect] });
    } catch (error) {
        throw new Error('Unsupported or invalid SQL syntax.');
    }
    if (Array.isArray(parsed) || !isAst(parsed) || parsed.type !== 'select') {
        throw new Error('Only one SELECT statement is supported.');
    }
    rejectUnsafeAst(parsed);

    const tables: TableRef[] = [];
    const seen = new Set<string>();
    collectTables(parsed, new Set(), tables, seen);
    const stages = collectStages(parsed);
    const warnings: string[] = [];
    if (hasNestedSelect(parsed) || hasSetOperation(parsed)) {
        warnings.push('Nested and set queries are shown as a logical overview, not a database execution plan.');
    }
    return { sql, analysis: { tables, stages, warnings } };
}

function rejectUnsafeAst(value: unknown): void {
    if (Array.isArray(value)) {
        value.forEach(rejectUnsafeAst);
        return;
    }
    if (!isAst(value)) return;
    const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
    if (MUTATING_TYPES.has(type)) throw new Error(`Read-only SELECTs cannot contain ${type.toUpperCase()}.`);
    if (type === 'param' || type === 'var_string' || (type === 'var' && !isDollarQuotedVar(value)) || (type === 'origin' && isPlaceholder(value.value))) {
        throw new Error('Parameter placeholders are not supported in the SQL editor.');
    }
    if (hasInto(value.into) || value.locking_read || value.for_update || value.table_hint) {
        throw new Error('SELECT INTO and locking clauses are not supported.');
    }
    Object.values(value).forEach(rejectUnsafeAst);
}

function isDollarQuotedVar(value: Ast): boolean {
    return typeof value.prefix === 'string'
        && typeof value.suffix === 'string'
        && value.prefix === value.suffix
        && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$$/.test(value.prefix);
}

function hasInto(value: unknown): boolean {
    return isAst(value) && (
        (value.position !== null && value.position !== undefined)
        || (value.keyword !== null && value.keyword !== undefined)
        || value.expr !== undefined
    );
}

function isPlaceholder(value: unknown): boolean {
    return typeof value === 'string' && (value === '?' || /^\$\d+$/.test(value) || /^[:@][A-Za-z_][A-Za-z0-9_]*$/.test(value));
}

function collectTables(select: Ast, inheritedCtes: Set<string>, output: TableRef[], seen: Set<string>): void {
    const ctes = new Set(inheritedCtes);
    const withItems = Array.isArray(select.with) ? select.with : [];
    if (withItems.some(item => isAst(item) && item.recursive)) {
        for (const item of withItems) {
            const name = isAst(item) ? identifier(item.name) : null;
            if (name) ctes.add(name);
        }
    }
    for (const item of withItems) {
        if (!isAst(item) || !isAst(item.stmt)) continue;
        const nested = isAst(item.stmt.ast) ? item.stmt.ast : item.stmt;
        if (nested.type !== 'select') throw new Error('Read-only SELECTs cannot contain a mutating CTE.');
        collectTables(nested, ctes, output, seen);
        const name = identifier(item.name);
        if (name) ctes.add(name);
    }

    const from = Array.isArray(select.from) ? select.from : [];
    for (const item of from) {
        if (!isAst(item)) continue;
        if (typeof item.table === 'string') {
            const name = item.table;
            const schema = typeof item.db === 'string' ? item.db : null;
            if (schema !== null || !ctes.has(name)) addTable({ schema, name }, output, seen);
        }
        if (isAst(item.expr) && isAst(item.expr.ast) && item.expr.ast.type === 'select') {
            collectTables(item.expr.ast, ctes, output, seen);
        }
        // FROM has both derived tables and JOIN predicates; inspect the predicate for scalar subqueries.
        walkSubqueries(item, ctes, output, seen, new Set(['expr']));
    }
    // Find scalar subqueries while avoiding CTEs, FROM subqueries, and set branches handled above.
    walkSubqueries(select, ctes, output, seen, new Set(['with', 'from', '_next']));
    if (isAst(select._next) && select._next.type === 'select') collectTables(select._next, ctes, output, seen);
}

function walkSubqueries(value: unknown, ctes: Set<string>, output: TableRef[], seen: Set<string>, skip: Set<string>): void {
    if (Array.isArray(value)) return value.forEach(item => walkSubqueries(item, ctes, output, seen, skip));
    if (!isAst(value)) return;
    for (const [key, child] of Object.entries(value)) {
        if (skip.has(key)) continue;
        if (isAst(child) && child.type === 'select') {
            collectTables(child, ctes, output, seen);
            continue;
        }
        if (isAst(child) && isAst(child.ast) && child.ast.type === 'select') {
            collectTables(child.ast, ctes, output, seen);
            continue;
        }
        walkSubqueries(child, ctes, output, seen, skip);
    }
}

function addTable(table: TableRef, output: TableRef[], seen: Set<string>): void {
    const key = `${table.schema ?? ''}\u0000${table.name}`;
    if (!seen.has(key)) {
        seen.add(key);
        output.push(table);
    }
}

function collectStages(select: Ast): QueryStage[] {
    const stages: QueryStage[] = [];
    const scope = directScope(select);
    const outputs = projectedAliases(select);
    const add = (kind: QueryStageKind, label: string, detail: string, expression?: unknown, focus: QueryStage['focus'] = 'columns', wildcardAsColumn = false) => {
        const used = expression === undefined ? emptyReferences() : expressionReferences(expression, scope, wildcardAsColumn);
        stages.push({ kind, label, detail, focus, references: used.references, ...(used.unresolved ? { unresolved: true } : {}) });
    };
    const from = Array.isArray(select.from) ? select.from : [];
    if (from.length) {
        const refs = scope.tables.map(table => ({ table, column: null }));
        stages.push({ kind: 'source', label: 'Source', detail: from.length === 1 ? 'Read source rows.' : 'Read source rows for the query.', focus: 'tables', references: refs, ...(scope.unresolved ? { unresolved: true } : {}) });
        if (from.length > 1) {
            const joinExpressions = from.slice(1).map(item => isAst(item) ? item.on : null).filter(Boolean);
            const used = joinExpressions.length ? expressionReferences(joinExpressions, scope) : { references: [], unresolved: false };
            const usingRefs = scope.unresolved ? [] : from.flatMap((item, index) => isAst(item) ? usingReferences(item.using, scope.tables.slice(0, index), scope.tables[index]) : []);
            usingRefs.forEach(reference => {
                if (!used.references.some(existing => sameReference(existing, reference))) used.references.push(reference);
            });
            if (!scope.unresolved && !joinExpressions.length && !usingRefs.length) used.references = refs;
            used.unresolved ||= scope.unresolved;
            stages.push({ kind: 'join', label: 'Join', detail: 'Combine source rows using the query’s join conditions and join types.', focus: 'columns', references: used.references, ...(used.unresolved ? { unresolved: true } : {}) });
        }
    }
    if (select.where) add('filter', 'Filter', 'Keep rows matching WHERE.', select.where);
    if (select.groupby) add('group', 'Group', 'Group rows for aggregation.', replaceClauseOrdinals(select.groupby, select.columns));
    if (select.having) add('having', 'Having', 'Filter grouped rows.', select.having);
    add('project', 'Project', 'Choose the result columns.', select.columns, 'columns', true);
    if (hasDistinct(select.distinct)) add('distinct', 'Distinct', 'Remove duplicate result rows.', undefined, 'result');
    const finalSelect = terminalSetBranch(select);
    if (hasSetOperation(select)) add('set', 'Set operation', 'Combine SELECT result sets.', undefined, 'result');
    if (hasOrderBy(finalSelect.orderby)) {
        if (hasSetOperation(select)) add('sort', 'Sort', 'Order the result rows.', undefined, 'result');
        else add('sort', 'Sort', 'Order the result rows.', resolveOrderExpressions(finalSelect.orderby, finalSelect.columns, outputs));
    }
    if (hasLimit(finalSelect.limit) || hasTop(finalSelect.top)) add('limit', 'Limit', 'Keep the requested number of rows.', undefined, 'result');
    add('result', 'Result', 'Return result rows.', undefined, 'result');
    return stages;
}

type Scope = { tables: TableRef[]; aliases: Map<string, TableRef>; names: Map<string, TableRef[]>; unresolved: boolean };

function directScope(select: Ast): Scope {
    const tables: TableRef[] = [];
    const aliases = new Map<string, TableRef>();
    const names = new Map<string, TableRef[]>();
    const ctes = new Set((Array.isArray(select.with) ? select.with : []).map(item => isAst(item) ? identifier(item.name) : null).filter((name): name is string => name !== null));
    let unresolved = false;
    for (const item of (Array.isArray(select.from) ? select.from : [])) {
        if (!isAst(item)) { unresolved = true; continue; }
        if (typeof item.table !== 'string' || isAst(item.expr) || (item.db == null && ctes.has(item.table))) { unresolved = true; continue; }
        const table = { schema: typeof item.db === 'string' ? item.db : null, name: item.table };
        tables.push(table);
        const named = names.get(item.table) ?? [];
        named.push(table); names.set(item.table, named);
        // An alias is unambiguous; unaliased short table names are only usable if unique.
        if (typeof item.as === 'string') aliases.set(item.as, table);
    }
    for (const [name, matches] of names) if (matches.length === 1 && !aliases.has(name)) aliases.set(name, matches[0]);
    return { tables, aliases, names, unresolved };
}

function projectedAliases(select: Ast): Map<string, unknown> {
    const aliases = new Map<string, unknown>();
    for (const item of (Array.isArray(select.columns) ? select.columns : [])) {
        if (isAst(item) && typeof item.as === 'string' && item.expr !== undefined) aliases.set(item.as, item.expr);
    }
    return aliases;
}

function emptyReferences(): { references: QueryStageReference[]; unresolved: boolean } {
    return { references: [], unresolved: false };
}

/** Walk node-sql-parser expressions, deliberately stopping at nested SELECT scopes. */
function expressionReferences(value: unknown, scope: Scope, wildcardAsColumn = false): { references: QueryStageReference[]; unresolved: boolean } {
    const references: QueryStageReference[] = [];
    let unresolved = scope.unresolved;
    const add = (reference: QueryStageReference) => {
        if (!references.some(existing => sameReference(existing, reference))) references.push(reference);
    };
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!isAst(node)) return;
        if (node.type === 'unresolved_stage_reference') { unresolved = true; return; }
        if (node.type === 'select' || (isAst(node.ast) && node.ast.type === 'select')) { unresolved = true; return; }
        if (node.type === 'column_ref') {
            const tableName = typeof node.table === 'string' ? node.table : null;
            const column = columnName(node.column);
            if (column === null) { unresolved = true; return; }
            if (tableName) {
                const schema = typeof node.schema === 'string' ? node.schema : typeof node.db === 'string' ? node.db : null;
                const table = schema === null ? scope.aliases.get(tableName) : scope.names.get(tableName)?.find(candidate => candidate.schema === schema);
                if (!table) { unresolved = true; return; }
                add({ table, column: column === '*' ? (wildcardAsColumn ? '*' : null) : column });
            } else if (column === '*') {
                if (scope.unresolved) unresolved = true;
                else scope.tables.forEach(table => add({ table, column: wildcardAsColumn ? '*' : null }));
            } else if (!scope.unresolved && scope.tables.length) {
                add({ table: null, column, candidates: scope.tables });
            } else unresolved = true;
            return;
        }
        if (node.type === 'star') {
            if (scope.unresolved) unresolved = true;
            else scope.tables.forEach(table => add({ table, column: wildcardAsColumn ? '*' : null }));
            return;
        }
        // COUNT(*) refers to the source rows, while SELECT * is a displayed-column wildcard.
        if (node.type === 'aggr_func' && String(node.name).toUpperCase() === 'COUNT' && isAst(node.args) && isAst(node.args.expr) && node.args.expr.type === 'star') {
            if (scope.unresolved) unresolved = true;
            else scope.tables.forEach(table => add({ table, column: null }));
            if (node.over) walk(node.over);
            return;
        }
        Object.values(node).forEach(walk);
    };
    walk(value);
    return { references, unresolved };
}

function sameReference(left: QueryStageReference, right: QueryStageReference): boolean {
    return left.table?.schema === right.table?.schema && left.table?.name === right.table?.name && left.column === right.column
        && (left.candidates ?? []).every((candidate, index) => candidate.schema === right.candidates?.[index]?.schema && candidate.name === right.candidates?.[index]?.name)
        && (left.candidates?.length ?? 0) === (right.candidates?.length ?? 0);
}

function usingReferences(value: unknown, prior: TableRef[], current: TableRef | undefined): QueryStageReference[] {
    if (!current || !Array.isArray(value)) return [];
    const columns = value.map(columnName).filter((column): column is string => column !== null);
    return columns.flatMap(column => [...prior, current].map(table => ({ table, column })));
}

function ordinalExpression(expression: unknown, columns: unknown): unknown {
    const projected = Array.isArray(columns) ? columns : [];
    const ordinal = isAst(expression) && expression.type === 'number' && typeof expression.value === 'number' ? expression.value : null;
    // A wildcard expands to an unknown number of result columns here. Do not
    // confuse its expression index with a result-column ordinal.
    if (ordinal !== null && Number.isInteger(ordinal) && ordinal > 0 && projected.slice(0, ordinal).some(item =>
        isAst(item) && isAst(item.expr) && (item.expr.type === 'star' || (item.expr.type === 'column_ref' && columnName(item.expr.column) === '*')))) {
        return { type: 'unresolved_stage_reference' };
    }
    return ordinal !== null && Number.isInteger(ordinal) && ordinal > 0 && isAst(projected[ordinal - 1])
        ? projected[ordinal - 1].expr : expression;
}

function replaceClauseOrdinals(clause: unknown, columns: unknown): unknown {
    if (isAst(clause) && Array.isArray(clause.columns)) return { ...clause, columns: clause.columns.map(expr => ordinalExpression(expr, columns)) };
    if (Array.isArray(clause)) return clause.map(item => isAst(item) ? { ...item, expr: ordinalExpression(item.expr, columns) } : item);
    return clause;
}

/** Resolve a bare ORDER BY alias or ordinal once, then inspect its source expression. */
function resolveOrderExpressions(clause: unknown, columns: unknown, outputs: Map<string, unknown>): unknown {
    if (!Array.isArray(clause)) return clause;
    return clause.map(item => {
        if (!isAst(item) || !isAst(item.expr)) return item;
        if (item.expr.type === 'number') return { ...item, expr: ordinalExpression(item.expr, columns) };
        if (item.expr.type !== 'column_ref' || item.expr.table != null) return item;
        const name = columnName(item.expr.column);
        const expression = name === null ? undefined : outputs.get(name);
        return expression === undefined ? item : { ...item, expr: expression };
    });
}

function columnName(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (isAst(value)) {
        if (typeof value.value === 'string') return value.value;
        if (isAst(value.expr) && typeof value.expr.value === 'string') return value.expr.value;
    }
    return null;
}

function hasDistinct(value: unknown): boolean {
    if (value === true || typeof value === 'string') return true;
    return isAst(value) && value.type !== null && value.type !== undefined;
}

function hasOrderBy(value: unknown): boolean {
    return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
}

function hasLimit(value: unknown): boolean {
    if (!isAst(value)) return false;
    return Array.isArray(value.value) ? value.value.length > 0 : value.value !== null && value.value !== undefined;
}

function hasTop(value: unknown): boolean {
    return value !== null && value !== undefined;
}

function terminalSetBranch(select: Ast): Ast {
    let branch = select;
    while (isAst(branch._next) && branch._next.type === 'select') branch = branch._next;
    return branch;
}

function hasSetOperation(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasSetOperation);
    if (!isAst(value)) return false;
    if (typeof value.set_op === 'string' || isAst(value._next)) return true;
    return Object.values(value).some(hasSetOperation);
}

function hasNestedSelect(select: Ast): boolean {
    let count = 0;
    const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (!isAst(value)) return;
        if (value.type === 'select') count++;
        Object.values(value).forEach(walk);
    };
    walk(select);
    return count > 1;
}

function identifier(value: unknown): string | null {
    if (typeof value === 'string') return value;
    return isAst(value) && typeof value.value === 'string' ? value.value : null;
}

function isAst(value: unknown): value is Ast {
    return typeof value === 'object' && value !== null;
}

// A scanner is used only to remove one final delimiter; statement validation remains AST-based.
function removeTerminalSemicolon(sql: string, dialect: Dialect): string {
    let terminalSeparator = -1;
    for (let index = 0; index < sql.length; index++) {
        const char = sql[index];
        const next = sql[index + 1];
        if ((char === '-' && next === '-') || (dialect === 'mysql' && char === '#')) { index = skipLineComment(sql, index + (char === '-' ? 2 : 1)); continue; }
        if (char === '/' && next === '*') { index = skipBlockComment(sql, index + 2); continue; }
        if (char === "'" || char === '"' || char === '`') { index = skipQuoted(sql, index + 1, char); continue; }
        if (char === '[') { index = skipBracketIdentifier(sql, index + 1); continue; }
        if (char === '$') {
            const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
            if (tag) { index = skipDollarQuote(sql, index + tag.length, tag); continue; }
        }
        if (char === ';') terminalSeparator = index;
    }
    if (terminalSeparator < 0 || !isTrivia(sql.slice(terminalSeparator + 1), dialect)) return sql;
    return sql.slice(0, terminalSeparator) + sql.slice(terminalSeparator + 1);
}

function isTrivia(value: string, dialect: Dialect): boolean {
    for (let index = 0; index < value.length;) {
        if (/\s/.test(value[index])) { index++; continue; }
        if (value[index] === '-' && value[index + 1] === '-') {
            const newline = value.indexOf('\n', index + 2);
            if (newline < 0) return true;
            index = newline + 1;
            continue;
        }
        if (dialect === 'mysql' && value[index] === '#') return true;
        if (value[index] === '/' && value[index + 1] === '*') {
            const close = value.indexOf('*/', index + 2);
            if (close < 0) return false;
            index = close + 2;
            continue;
        }
        return false;
    }
    return true;
}

function containsExecutableMysqlComment(sql: string): boolean {
    for (let index = 0; index < sql.length; index++) {
        const char = sql[index];
        const next = sql[index + 1];
        // MySQL requires whitespace after --; otherwise it is two subtraction operators.
        if (char === '-' && next === '-' && /\s/.test(sql[index + 2] ?? '')) { index = skipLineComment(sql, index + 2); continue; }
        if (char === '#') { index = skipLineComment(sql, index + 1); continue; }
        if (char === '/' && next === '*') {
            if (sql[index + 2] === '!' || (/[mM]/.test(sql[index + 2] ?? '') && sql[index + 3] === '!')) return true;
            index = skipBlockComment(sql, index + 2);
            continue;
        }
        if (char === "'" || char === '"' || char === '`') { index = skipQuoted(sql, index + 1, char); continue; }
    }
    return false;
}

function foldPostgresUnquotedAscii(sql: string): string {
    let output = '';
    for (let index = 0; index < sql.length; index++) {
        const char = sql[index];
        const next = sql[index + 1];
        if (char === '-' && next === '-') {
            const end = skipLineComment(sql, index + 2);
            output += sql.slice(index, end);
            index = end - 1;
            continue;
        }
        if (char === '/' && next === '*') {
            const end = skipBlockComment(sql, index + 2) + 1;
            output += sql.slice(index, end);
            index = end - 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            const end = skipQuoted(sql, index + 1, char) + 1;
            output += sql.slice(index, end);
            index = end - 1;
            continue;
        }
        if (char === '$') {
            const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
            if (tag) {
                const end = skipDollarQuote(sql, index + tag.length, tag) + 1;
                output += sql.slice(index, end);
                index = end - 1;
                continue;
            }
        }
        output += char >= 'A' && char <= 'Z' ? char.toLowerCase() : char;
    }
    return output;
}

function skipLineComment(sql: string, index: number): number {
    const newline = sql.indexOf('\n', index);
    return newline < 0 ? sql.length : newline;
}

function skipBlockComment(sql: string, index: number): number {
    const close = sql.indexOf('*/', index);
    return close < 0 ? sql.length : close + 1;
}

function skipQuoted(sql: string, index: number, quote: string): number {
    for (; index < sql.length; index++) {
        if (sql[index] === '\\') { index++; continue; }
        if (sql[index] === quote && sql[index + 1] === quote) { index++; continue; }
        if (sql[index] === quote) return index;
    }
    return sql.length;
}

function skipBracketIdentifier(sql: string, index: number): number {
    for (; index < sql.length; index++) {
        if (sql[index] === ']' && sql[index + 1] === ']') { index++; continue; }
        if (sql[index] === ']') return index;
    }
    return sql.length;
}

function skipDollarQuote(sql: string, index: number, tag: string): number {
    const close = sql.indexOf(tag, index);
    return close < 0 ? sql.length : close + tag.length - 1;
}
