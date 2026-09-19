import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoAdapter } from '../src/main/db/demo';
import { toQueryValue } from '../src/main/db/queryValues';

async function demoQuery(sql: string) {
    const adapter = new DemoAdapter();
    await adapter.connect({ dialect: 'demo' });
    try {
        return await adapter.executeQuery(sql);
    } finally {
        await adapter.disconnect();
    }
}

async function demoPlan(sql: string) {
    const adapter = new DemoAdapter();
    await adapter.connect({ dialect: 'demo' });
    try { return await adapter.explainQuery(sql); } finally { await adapter.disconnect(); }
}

test('demo returns SQLite estimated plan rows without query row truncation', async () => {
    const plan = await demoPlan('SELECT * FROM public.orders WHERE status = \'paid\' ORDER BY total');
    assert.equal(plan.format, 'json');
    const rows = JSON.parse(plan.raw) as Array<{ detail: string }>;
    assert.ok(rows.length > 0);
    assert.match(rows.map(row => row.detail).join(' '), /SEARCH|SCAN|USE TEMP B-TREE/i);
});

test('demo explain rejects invalid SQL', async () => {
    await assert.rejects(() => demoPlan('SELEC nope'), /near "SELEC"|syntax error/i);
});

test('demo explain accepts a terminal semicolon and does not execute a recursive aggregate', async () => {
    const plan = await demoPlan(`
        WITH RECURSIVE numbers(value) AS (
            VALUES(1) UNION ALL SELECT value + 1 FROM numbers
        ) SELECT SUM(value) FROM numbers;
    `);
    assert.equal(plan.format, 'json');
    assert.ok(JSON.parse(plan.raw).length > 0);
});

test('disconnect terminates a pending demo plan', async () => {
    const adapter = new DemoAdapter();
    await adapter.connect({ dialect: 'demo' });
    const pending = adapter.explainQuery('SELECT * FROM public.orders');
    await adapter.disconnect();
    await assert.rejects(pending, /process exited|terminated|closed/i);
});

test('demo executes joins and filters qualified public tables', async () => {
    const result = await demoQuery(`
        SELECT u.name, o.total
        FROM public.users u
        JOIN public.orders o ON o.user_id = u.id
        WHERE o.status = 'paid'
        ORDER BY o.id
    `);
    assert.deepEqual(result.columns, ['name', 'total']);
    assert.deepEqual(result.rows, [['Ada Lovelace', 89.5], ['Linus Torvalds', 150]]);
    assert.equal(result.truncated, false);
    assert.equal(result.rowLimit, 500);
});

test('demo executes aggregates, empty results, duplicate names, and null values', async () => {
    const aggregate = await demoQuery('SELECT status, COUNT(*) AS count, ROUND(SUM(total), 2) AS total FROM public.orders GROUP BY status ORDER BY status');
    assert.deepEqual(aggregate.rows, [['paid', 2, 239.5], ['pending', 1, 25], ['refunded', 1, 42.75]]);

    const empty = await demoQuery('SELECT id FROM public.users WHERE id = 999');
    assert.deepEqual(empty.columns, ['id']);
    assert.deepEqual(empty.rows, []);

    const duplicate = await demoQuery('SELECT id AS value, id + 100 AS value, NULL AS missing FROM public.users WHERE id = 1');
    assert.deepEqual(duplicate.columns, ['value', 'value', 'missing']);
    assert.deepEqual(duplicate.rows, [[1, 101, null]]);
});

test('demo detects one row beyond the result limit', async () => {
    const result = await demoQuery(`
        WITH RECURSIVE numbers(value) AS (
            VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 501
        ) SELECT value FROM numbers
    `);
    assert.equal(result.rows.length, 500);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.rows[0], [1]);
    assert.deepEqual(result.rows[499], [500]);
});

test('demo rejects invalid and write statements after query_only is enabled', async () => {
    await assert.rejects(() => demoQuery('SELEC nope'), /near "SELEC"|syntax error/i);
    await assert.rejects(() => demoQuery("INSERT INTO public.users VALUES (9, 'write@test', 'Write', '2025-01-01')"), /readonly|read-only|attempt to write/i);
});

test('disconnect terminates a pending demo query', async () => {
    const adapter = new DemoAdapter();
    await adapter.connect({ dialect: 'demo' });
    const pending = adapter.executeQuery('WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM numbers) SELECT SUM(value) FROM numbers');
    const rejected = assert.rejects(pending, /process exited|terminated|closed/i);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await adapter.disconnect();
    await rejected;
});

test('normalizes bigints, binary values, and structured driver values for IPC', () => {
    assert.equal(toQueryValue(42n), '42');
    assert.equal(toQueryValue(Buffer.from([1, 2, 3])), 'AQID');
    assert.equal(toQueryValue(new Uint8Array([4, 5])), 'BAU=');
    assert.equal(toQueryValue({ nested: ['value', null] }), '{"nested":["value",null]}');
});
