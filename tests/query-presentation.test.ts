import assert from 'node:assert/strict';
import test from 'node:test';
import type { TableSchema } from '../src/shared/schema';
import type { QueryStage } from '../src/shared/query';
import { initialQuery, resolveQueryStage, resolveQueryTables } from '../src/renderer/components/queryPresentation';

const tables = ['public', 'archive'].map(schema => ({
    schema, name: 'users', columns: [], foreignKeys: [], referencedBy: [], uniqueConstraints: [], indexes: [],
})) satisfies TableSchema[];

test('diagram resolution does not guess which schema an ambiguous table uses', () => {
    const ambiguous = resolveQueryTables([{ schema: null, name: 'users' }], tables);
    assert.equal(ambiguous.keys.size, 0);
    assert.equal(ambiguous.warnings.length, 1);
    const qualified = resolveQueryTables([{ schema: 'archive', name: 'users' }], tables);
    assert.deepEqual([...qualified.keys], ['archive.users']);
    assert.equal(qualified.warnings.length, 0);
});

test('sources outside the loaded diagram are reported without hiding query results', () => {
    const result = resolveQueryTables([{ schema: 'public', name: 'view_users' }], tables);
    assert.equal(result.keys.size, 0);
    assert.match(result.warnings[0], /not in the loaded schema/);
});

test('starter SQL quotes unusual identifiers for each supported dialect', () => {
    const table = { ...tables[0], schema: 'odd"schema', name: 'user`records]' };
    assert.match(initialQuery([table], 'postgres'), /"odd""schema"\."user`records\]"/);
    assert.match(initialQuery([table], 'mysql'), /`user``records\]`/);
    assert.match(initialQuery([table], 'mssql'), /^SELECT TOP 100 \*\nFROM \[odd"schema\]\.\[user`records\]\]\];$/);
    assert.equal(initialQuery([], 'postgres'), 'SELECT 1 AS value;');
});

const stageTables = [
    { schema: 'public', name: 'orders', columns: [{ name: 'id' }, { name: 'total' }, { name: 'status' }] },
    { schema: 'public', name: 'users', columns: [{ name: 'id' }, { name: 'name' }] },
    { schema: 'archive', name: 'orders', columns: [{ name: 'id' }, { name: 'total' }] },
].map(table => ({ ...table, columns: table.columns.map(column => ({ ...column, dataType: 'text', nullable: false, isPrimaryKey: false, isUnique: false, default: null, comment: null })), foreignKeys: [], referencedBy: [], uniqueConstraints: [], indexes: [] })) satisfies TableSchema[];

function filterStage(references: QueryStage['references']): QueryStage {
    return { kind: 'filter', label: 'Filter', detail: '', focus: 'columns', references };
}

test('stage resolution highlights only the qualified filter column', () => {
    const result = resolveQueryStage(filterStage([{ table: { schema: 'public', name: 'orders' }, column: 'total' }]), stageTables);
    assert.deepEqual([...result.keys], ['public.orders']);
    assert.deepEqual([...result.columns.get('public.orders') ?? []], ['total']);
    assert.deepEqual(result.labels, ['public.orders.total']);

    const unknown = resolveQueryStage(filterStage([{ table: { schema: 'public', name: 'orders' }, column: 'missing' }]), stageTables);
    assert.equal(unknown.keys.size, 0);
    assert.equal(unknown.columns.size, 0);
});

test('stage resolution finds an unqualified column only when one current source owns it', () => {
    const result = resolveQueryStage(filterStage([{ table: null, column: 'total', candidates: [{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'users' }] }]), stageTables);
    assert.deepEqual([...result.keys], ['public.orders']);
    assert.deepEqual([...result.columns.get('public.orders') ?? []], ['total']);
});

test('stage resolution does not guess ambiguous columns or schemas', () => {
    const ambiguousColumn = resolveQueryStage(filterStage([{ table: null, column: 'id', candidates: [{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'users' }] }]), stageTables);
    assert.equal(ambiguousColumn.keys.size, 0);
    assert.match(ambiguousColumn.warnings.join(' '), /ambiguous/);

    const duplicateSchema = resolveQueryStage(filterStage([{ table: { schema: null, name: 'orders' }, column: 'total' }]), stageTables);
    assert.equal(duplicateSchema.keys.size, 0);
    assert.match(duplicateSchema.warnings.join(' '), /multiple schemas/);
});

test('stage resolution expands explicit wildcards and leaves result and unknown source unhighlighted', () => {
    const wildcard = resolveQueryStage(filterStage([{ table: { schema: 'public', name: 'orders' }, column: '*' }]), stageTables);
    assert.deepEqual([...wildcard.columns.get('public.orders') ?? []], ['id', 'total', 'status']);
    assert.deepEqual(wildcard.labels, ['public.orders.*']);

    const result = resolveQueryStage({ kind: 'result', label: 'Result', detail: '', focus: 'result', references: [] }, stageTables);
    assert.equal(result.keys.size, 0);
    assert.equal(result.columns.size, 0);

    const unknownSource = resolveQueryStage(filterStage([{ table: null, column: 'total', candidates: [] }]), stageTables);
    assert.equal(unknownSource.keys.size, 0);
    assert.match(unknownSource.warnings.join(' '), /source table is unknown/);

    const partialScope = resolveQueryStage(filterStage([{ table: null, column: 'total', candidates: [{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'missing_source' }] }]), stageTables);
    assert.equal(partialScope.keys.size, 0);
    assert.match(partialScope.warnings.join(' '), /missing_source is not in the loaded schema/);
});
