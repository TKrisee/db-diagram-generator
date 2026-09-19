import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQueryPlan } from '../src/main/queryPlan';
import { PLAN_NODE_LIMIT, PLAN_TEXT_LIMIT } from '../src/shared/queryPlan';

const raw = (value: unknown, format: 'json' | 'xml' = 'json') => ({ format, raw: typeof value === 'string' ? value : JSON.stringify(value), durationMs: 0 });

test('normalizes PostgreSQL JSON plans with estimates and nested operators', () => {
    const plan = normalizeQueryPlan(raw([{ Plan: { 'Node Type': 'Sort', 'Plan Rows': 3, 'Total Cost': 14.2, 'Sort Key': ['u.name'], Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'users', Schema: 'public', Alias: 'u', 'Index Name': 'users_pkey', 'Plan Rows': 3, 'Index Cond': '(id > 0)' }] } }]), 'postgres');
    assert.equal(plan.nodes.length, 2);
    assert.equal(plan.nodes.find((node) => node.kind === 'scan')?.relation?.name, 'users');
    assert.equal(plan.nodes.find((node) => node.kind === 'scan')?.alias, 'u');
    assert.equal(plan.nodes.find((node) => node.kind === 'sort')?.cost, 14.2);
    assert.equal(plan.roots.length, 1);
});

test('normalizes MySQL JSON conservatively without inventing join algorithms', () => {
    const plan = normalizeQueryPlan(raw({ query_block: { nested_loop: [{ table: { table_name: 'users', access_type: 'range', key: 'PRIMARY', rows_examined_per_scan: 4 } }, { table: { table_name: 'orders', access_type: 'ref', attached_condition: 'orders.user_id = users.id' } }] } }), 'mysql');
    assert.equal(plan.nodes.filter((node) => node.kind === 'scan').length, 2);
    assert.ok(plan.nodes.filter((node) => node.kind === 'scan').every((node) => node.relation === undefined));
    assert.equal(plan.nodes.find((node) => node.kind === 'join')?.label, 'Join inputs (plan order)');
    assert.ok(plan.warnings.some((warning) => /not expose a complete/i.test(warning)));
    assert.ok(!plan.nodes.some((node) => /hash|merge/i.test(node.label)));
});

test('normalizes SQL Server operators without taking details from child operators', () => {
    const xml = '<?xml version="1.0"?><ShowPlanXML><RelOp PhysicalOp="Nested Loops" EstimateRows="2" EstimatedTotalSubtreeCost="3"><NestedLoops><OuterReferences/><RelOp PhysicalOp="Index Seek"><IndexScan><Object Table="[dbo].[users]" Index="[PK_users]"/><Predicate>child predicate</Predicate></IndexScan></RelOp></NestedLoops></RelOp></ShowPlanXML>';
    const plan = normalizeQueryPlan(raw(xml, 'xml'), 'mssql');
    const join = plan.nodes.find((node) => node.kind === 'join');
    assert.equal(join?.details.length, 0);
    assert.equal(plan.nodes.find((node) => node.kind === 'scan')?.relation?.name, 'users');
    assert.equal(join?.cost, 3);
});

test('retains MySQL materialized and union subquery blocks and string costs', () => {
    const plan = normalizeQueryPlan(raw({ query_block: { table: { table_name: '<derived2>', cost_info: { query_cost: '8.5' }, materialized_from_subquery: { query_block: { table: { table_name: 'source' } } } }, union_result: { query_specifications: [{ query_block: { table: { table_name: 'other_source' } } }] } } }), 'mysql');
    assert.equal(plan.nodes.find((node) => node.alias === '<derived2>')?.cost, 8.5);
    assert.deepEqual(plan.nodes.filter((node) => node.kind === 'scan').map((node) => node.alias).sort(), ['<derived2>', 'other_source', 'source']);
});

test('retains PostgreSQL array details and SQL Server source metadata exactly', () => {
    const postgres = normalizeQueryPlan(raw([{ Plan: { 'Node Type': 'Sort', 'Sort Key': ['"user.name"'], Output: ['id', 'name'] } }]), 'postgres');
    assert.equal(postgres.nodes[0].details.find((detail) => detail.label === 'Sort Key')?.value, '["\\\"user.name\\\""]');
    assert.equal(postgres.nodes[0].details.find((detail) => detail.label === 'Output')?.value, '["id","name"]');
    const xml = '<ShowPlanXML><RelOp PhysicalOp="Index Seek"><IndexScan><Object Schema="[odd.schema]" Table="[a]]b]" Alias="[u]" Index="[IX]]name]"/><SeekPredicates><ScalarOperator ScalarString="[u].[id]=(1)"/></SeekPredicates></IndexScan></RelOp></ShowPlanXML>';
    const mssql = normalizeQueryPlan(raw(xml, 'xml'), 'mssql').nodes[0];
    assert.deepEqual(mssql.relation, { schema: 'odd.schema', name: 'a]b' });
    assert.equal(mssql.alias, 'u');
    assert.equal(mssql.index, 'IX]name');
    assert.equal(mssql.cost, undefined);
    assert.equal(mssql.details.find((detail) => detail.label === 'Seek predicate')?.value, '[u].[id]=(1)');
});

test('uses SQL Server logical joins and only native predicate containers', () => {
    const xml = '<ShowPlanXML><RelOp PhysicalOp="Hash Match" LogicalOp="Inner Join"><Hash><DefinedValues><DefinedValue><ScalarOperator ScalarString="computed expression"/></DefinedValue></DefinedValues><ProbeResidual><ScalarOperator ScalarString="[a]=[b]"/></ProbeResidual></Hash><OrderBy><OrderByColumn><ColumnReference Column="[a]"/></OrderByColumn></OrderBy></RelOp></ShowPlanXML>';
    const node = normalizeQueryPlan(raw(xml, 'xml'), 'mssql').nodes[0];
    assert.equal(node.kind, 'join');
    assert.equal(node.details.find((detail) => detail.label === 'Join predicate')?.value, '[a]=[b]');
    assert.equal(node.details.find((detail) => detail.label === 'Order by')?.value, '[a]');
});

test('normalizes SQLite EQP rows as explicitly limited structural groups', () => {
    const plan = normalizeQueryPlan(raw([{ id: 0, parent: -1, notused: 0, detail: 'SCAN users' }, { id: 1, parent: -1, notused: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' }]), 'sqlite');
    assert.equal(plan.nodes.find((node) => node.kind === 'scan')?.relation, undefined);
    assert.equal(plan.nodes.find((node) => node.kind === 'scan')?.alias, 'users');
    assert.ok(plan.warnings.some((warning) => /loop order/i.test(warning)));
    assert.equal(plan.nodes.find((node) => node.kind === 'sort')?.cost, undefined);
    assert.equal(plan.nodes.find((node) => node.kind === 'scan')?.label, 'Table scan');
    assert.equal(plan.nodes.find((node) => node.kind === 'scan')?.details[0].value, 'SCAN users');
});

test('builds unordered SQLite EQP rows and rejects duplicate or cyclic identifiers', () => {
    const unordered = normalizeQueryPlan(raw([{ id: 2, parent: 1, notused: 0, detail: 'SEARCH child USING INDEX ix_child (id=?)' }, { id: 1, parent: -1, notused: 0, detail: 'SCAN parent' }]), 'sqlite');
    assert.equal(unordered.nodes.find((node) => node.alias === 'parent')?.children.length, 1);
    assert.ok(normalizeQueryPlan(raw([{ id: 1, parent: -1, notused: 0, detail: 'SCAN a' }, { id: 1, parent: -1, notused: 0, detail: 'SCAN b' }]), 'sqlite').warnings.length);
    assert.ok(normalizeQueryPlan(raw([{ id: 1, parent: 2, notused: 0, detail: 'SCAN a' }, { id: 2, parent: 1, notused: 0, detail: 'SCAN b' }]), 'sqlite').warnings.length);
});

test('SQLite keeps complete scan aliases and does not treat constant rows as a physical source', () => {
    const plan = normalizeQueryPlan(raw([
        { id: 1, parent: 0, detail: 'SCAN user alias USING INDEX idx_users' },
        { id: 2, parent: 0, detail: 'SCAN CONSTANT ROW' },
    ]), 'sqlite');
    assert.equal(plan.nodes[0].alias, 'user alias');
    assert.equal(plan.nodes[1].alias, undefined);
});

test('returns warnings for malformed, empty, and oversized plans', () => {
    assert.ok(normalizeQueryPlan(raw('{nope'), 'postgres').warnings.length);
    assert.ok(normalizeQueryPlan(raw(''), 'mysql').warnings.some((warning) => /empty/i.test(warning)));
    assert.ok(normalizeQueryPlan(raw('x'.repeat(PLAN_TEXT_LIMIT + 1)), 'mssql').warnings.some((warning) => /limit/i.test(warning)));
    let nested: Record<string, unknown> = { 'Node Type': 'Result' };
    for (let index = 0; index <= PLAN_NODE_LIMIT; index++) nested = { 'Node Type': 'Result', Plans: [nested] };
    assert.ok(normalizeQueryPlan(raw([{ Plan: nested }]), 'postgres').warnings.some((warning) => /node limit/i.test(warning)));
});
