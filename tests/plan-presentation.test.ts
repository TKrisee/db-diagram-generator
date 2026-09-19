import assert from 'node:assert/strict';
import test from 'node:test';
import { planNodeStage, planWalkOrder } from '../src/renderer/components/planPresentation';
import type { QueryPlan } from '../src/shared/queryPlan';

const plan: QueryPlan = {
    engine: 'postgres', format: 'json', raw: '', durationMs: 0, warnings: [], roots: ['join', 'extra'],
    nodes: [
        { id: 'join', label: 'Hash Join', kind: 'join', children: ['orders', 'users'], details: [] },
        { id: 'orders', label: 'Seq Scan', kind: 'scan', children: [], relation: { schema: 'public', name: 'orders' }, details: [] },
        { id: 'users', label: 'Index Scan', kind: 'scan', children: [], relation: { schema: 'public', name: 'users' }, details: [] },
        { id: 'extra', label: 'Result', kind: 'other', children: [], details: [] },
    ],
};

test('plan walkthrough visits inputs before their parent and preserves multiple roots', () => {
    assert.deepEqual(planWalkOrder(plan).map(node => node.id), ['orders', 'users', 'join', 'extra']);
});

test('scan highlights only its own table, while join highlights its known inputs without guessing columns', () => {
    const scan = planNodeStage(plan.nodes[1], plan)!;
    assert.deepEqual(scan.references, [{ table: { schema: 'public', name: 'orders' }, column: null }]);
    const join = planNodeStage(plan.nodes[0], plan)!;
    assert.deepEqual(join.references.map(ref => ref.table?.name), ['orders', 'users']);
    assert.equal(join.focus, 'tables');
    assert.deepEqual(planNodeStage(plan.nodes[3], plan)?.references, []);
});

test('repeated inputs and defensive cycles do not repeat walkthrough operators', () => {
    const cyclic = { ...plan, nodes: plan.nodes.map(node => node.id === 'users' ? { ...node, children: ['join', 'orders'] } : node) };
    assert.equal(planWalkOrder(cyclic).length, 4);
    assert.equal(planNodeStage(cyclic.nodes[0], cyclic)?.references.length, 2);
});
