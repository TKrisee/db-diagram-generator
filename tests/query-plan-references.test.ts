import assert from 'node:assert/strict';
import test from 'node:test';
import { linkPlanRelations } from '../src/main/queryPlanReferences';
import type { QueryPlan } from '../src/shared/queryPlan';
import type { Dialect } from '../src/shared/schema';

function plan(aliases: string[]): QueryPlan {
    return {
        format: 'json', raw: '{}', durationMs: 0, engine: 'mysql', roots: [], warnings: [],
        nodes: aliases.map((alias, index) => ({ id: String(index), label: alias, kind: 'scan', children: [], alias, details: [] })),
    };
}
function relations(value: QueryPlan): Array<string | undefined> { return value.nodes.map((node) => node.relation && `${node.relation.schema ?? ''}.${node.relation.name}`); }

test('links unambiguous aliases, including schema-qualified sources', () => {
    const linked = linkPlanRelations(plan(['u', 'o']), 'SELECT * FROM app.users u JOIN sales.orders o ON o.user_id = u.id', 'mysql');
    assert.deepEqual(relations(linked), ['app.users', 'sales.orders']);
});

test('links SQLite qualified scan targets without confusing an explicit dotted alias', () => {
    const linked = linkPlanRelations(plan(['public.orders']), 'SELECT * FROM public.orders', 'sqlite');
    assert.deepEqual(relations(linked), ['public.orders']);
    const ambiguous = linkPlanRelations(plan(['public.orders']), 'SELECT * FROM public.orders JOIN users AS "public.orders" ON 1=1', 'sqlite');
    assert.deepEqual(relations(ambiguous), [undefined]);
});

test('links self-join aliases to their shared physical relation and preserves plan references', () => {
    const input = plan(['manager', 'employee']);
    input.nodes[0].relation = { schema: 'authoritative', name: 'managers' };
    const linked = linkPlanRelations(input, 'SELECT * FROM employees employee JOIN employees manager ON manager.id = employee.manager_id', 'sqlite');
    assert.deepEqual(relations(linked), ['authoritative.managers', '.employees']);
});

test('does not guess aliases reused by a scalar subquery in a JOIN predicate', () => {
    const linked = linkPlanRelations(plan(['x']), 'SELECT * FROM users x JOIN products p ON EXISTS (SELECT 1 FROM orders x)', 'mysql');
    assert.deepEqual(relations(linked), [undefined]);
});

test('does not link CTE or derived-table aliases, even when a catalog table has the CTE name', () => {
    const cte = linkPlanRelations(plan(['recent', 'r']), 'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent r', 'sqlite');
    const collision = linkPlanRelations(plan(['u']), 'WITH users AS (SELECT * FROM orders) SELECT * FROM users u', 'mysql');
    const derived = linkPlanRelations(plan(['d']), 'SELECT * FROM (SELECT * FROM orders) d', 'mysql');
    assert.deepEqual(relations(cte), [undefined, undefined]);
    assert.deepEqual(relations(collision), [undefined]);
    assert.deepEqual(relations(derived), [undefined]);
});

test('a WITH source stays nonphysical in later UNION branches', () => {
    const linked = linkPlanRelations(plan(['r']), 'WITH recent AS (SELECT * FROM orders) SELECT * FROM users UNION ALL SELECT * FROM recent r', 'sqlite');
    assert.deepEqual(relations(linked), [undefined]);
});

test('uses PostgreSQL identifier folding for aliases', () => {
    const linked = linkPlanRelations(plan(['u']), 'SELECT * FROM Public.Users U', 'postgres' as Dialect);
    assert.deepEqual(relations(linked), ['public.users']);
});

test('keeps PostgreSQL quoted identifiers intact while folding surrounding SQL', () => {
    const linked = linkPlanRelations(plan(['U']), `SELECT '"' FROM "Users" "U"`, 'postgres');
    assert.deepEqual(relations(linked), ['.Users']);
});
