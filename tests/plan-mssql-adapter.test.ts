import assert from 'node:assert/strict';
import test from 'node:test';
import { MssqlAdapter } from '../src/main/db/mssql';
import { QUERY_TIMEOUT_MS } from '../src/shared/query';

type Deferred = { promise: Promise<unknown>; reject: (error: Error) => void };

function deferred(): Deferred {
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((_resolve, rejectPromise) => { reject = rejectPromise; });
    return { promise, reject };
}

function planHarness(options: { select?: () => Promise<unknown> | unknown } = {}) {
    const batches: Array<{ request: object; sql: string }> = [];
    const pool = { connected: false, closed: false, async connect() { this.connected = true; return this; }, async close() { this.closed = true; } };
    const transaction = {
        begun: false, rolledBack: false,
        async begin() { this.begun = true; },
        async rollback() { this.rolledBack = true; },
        request() {
            const request = {
                cancelled: false,
                cancel() { this.cancelled = true; },
                async batch(sql: string) {
                    batches.push({ request, sql });
                    if (/^SELECT/i.test(sql)) return options.select ? options.select() : { recordsets: [[{ 'Microsoft SQL Server 2005 XML Showplan': '<ShowPlanXML Version="1.0" />' }]] };
                    return { recordsets: [] };
                },
            };
            return request;
        },
    };
    const adapter = new MssqlAdapter() as any;
    adapter.planConfig = {};
    adapter.mssql = { ConnectionPool: class { constructor(_config: unknown) { return pool; } }, Transaction: class { constructor(_pool: unknown) { return transaction; } } };
    return { adapter: adapter as MssqlAdapter, batches, pool, transaction };
}

test('mssql plan uses one pinned transaction and extracts the native XML column', async () => {
    const { adapter, batches, pool, transaction } = planHarness();
    const plan = await adapter.explainQuery('SELECT 1');
    assert.equal(plan.raw, '<ShowPlanXML Version="1.0" />');
    assert.deepEqual(batches.map(entry => entry.sql), ['SET SHOWPLAN_XML ON', 'SELECT 1', 'SET SHOWPLAN_XML OFF']);
    assert.equal(new Set(batches.map(entry => entry.request)).size, 3, 'batches use transaction-bound requests');
    assert.equal(transaction.rolledBack, true);
    assert.equal(pool.closed, true);
});

test('mssql plan rolls back and closes after a SELECT syntax failure', async () => {
    const { adapter, batches, pool, transaction } = planHarness({ select: () => { throw new Error('Incorrect syntax near SELECT'); } });
    await assert.rejects(() => adapter.explainQuery('SELECT broken'), /Incorrect syntax/);
    assert.deepEqual(batches.map(entry => entry.sql), ['SET SHOWPLAN_XML ON', 'SELECT broken', 'SET SHOWPLAN_XML OFF']);
    assert.equal(transaction.rolledBack, true);
    assert.equal(pool.closed, true);
});

test('mssql disconnect cancels an in-flight plan and still releases its transaction', async () => {
    const pendingSelect = deferred();
    const { adapter, batches, pool, transaction } = planHarness({ select: () => pendingSelect.promise });
    const pending = adapter.explainQuery('SELECT slow');
    await new Promise(resolve => setImmediate(resolve));
    await adapter.disconnect();
    pendingSelect.reject(new Error('Cancelled'));
    await assert.rejects(pending, /Cancelled|closed|starting the plan/i);
    assert.deepEqual(batches.map(entry => entry.sql), ['SET SHOWPLAN_XML ON', 'SELECT slow', 'SET SHOWPLAN_XML OFF']);
    assert.equal(batches.filter(entry => /^SELECT/i.test(entry.sql)).length, 1);
    assert.equal(transaction.rolledBack, true);
    assert.equal(pool.closed, true);
});

test('mssql plan timeout releases its pinned transaction', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pendingSelect = deferred();
    const { adapter, batches, pool, transaction } = planHarness({ select: () => pendingSelect.promise });
    const pending = adapter.explainQuery('SELECT slow');
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(QUERY_TIMEOUT_MS);
    pendingSelect.reject(new Error('Cancelled'));
    await assert.rejects(pending, /Plan timed out/);
    assert.deepEqual(batches.map(entry => entry.sql), ['SET SHOWPLAN_XML ON', 'SELECT slow']);
    assert.equal(transaction.rolledBack, true);
    assert.equal(pool.closed, true);
});
