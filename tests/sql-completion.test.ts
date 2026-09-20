import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionContext, type Completion } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { schemaCompletionSource } from '@codemirror/lang-sql';
import type { TableSchema } from '../src/shared/schema';
import { createSqlConfig, createSqlLanguage } from '../src/renderer/components/sqlLanguage';

const tables: TableSchema[] = [
    {
        schema: 'public', name: 'users',
        columns: [
            { name: 'id', dataType: 'uuid', nullable: false, isPrimaryKey: true, isUnique: true, default: null, comment: null },
            { name: 'display name', dataType: 'text', nullable: false, isPrimaryKey: false, isUnique: false, default: null, comment: null },
        ], foreignKeys: [], referencedBy: [], uniqueConstraints: [], indexes: [],
    },
    {
        schema: 'public', name: 'orders',
        columns: [
            { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, isUnique: true, default: null, comment: null },
            { name: 'user_id', dataType: 'uuid', nullable: false, isPrimaryKey: false, isUnique: false, default: null, comment: null },
        ], foreignKeys: [], referencedBy: [], uniqueConstraints: [], indexes: [],
    },
    {
        schema: 'archive', name: 'users',
        columns: [{ name: 'archived_at', dataType: 'timestamp', nullable: false, isPrimaryKey: false, isUnique: false, default: null, comment: null }],
        foreignKeys: [], referencedBy: [], uniqueConstraints: [], indexes: [],
    },
    {
        schema: 'public', name: 'order',
        columns: [{ name: 'select', dataType: 'text', nullable: false, isPrimaryKey: false, isUnique: false, default: null, comment: null }],
        foreignKeys: [], referencedBy: [], uniqueConstraints: [], indexes: [],
    },
];

function registered(input: string, dialect: 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'demo' = 'postgres') {
    return registeredFor(tables, input, dialect);
}

function registeredFor(sourceTables: TableSchema[], input: string, dialect: 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'demo' = 'postgres') {
    const pos = input.indexOf('|');
    assert.notEqual(pos, -1, 'completion input must include a cursor marker');
    const doc = input.replace('|', '');
    const support = createSqlLanguage(sourceTables, dialect);
    const state = EditorState.create({ doc, extensions: [support] });
    return state.languageDataAt<((context: CompletionContext) => { options: readonly Completion[] } | null)>('autocomplete', pos)
        .flatMap(source => {
            const result = source(new CompletionContext(state, pos, true));
            assert.ok(!(result instanceof Promise));
            return result?.options ?? [];
        });
}

function labels(doc: string, dialect: 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'demo' = 'postgres') {
    return registered(doc, dialect).map(option => option.label);
}

test('completes an unambiguous table and schema-qualified tables', () => {
    assert.ok(labels('SELECT * FROM ord|').includes('orders'));
    assert.ok(labels('SELECT * FROM public.ord|', 'demo').includes('orders'));
    assert.ok(labels('SELECT * FROM arch|').includes('archive'));
});

test('completes columns for AS and implicit table aliases', () => {
    const asColumns = registered('SELECT u.| FROM public.users AS u', 'demo');
    assert.deepEqual(asColumns.map(option => option.label), ['id', 'display name']);
    assert.equal(asColumns[0].detail, 'uuid');
    assert.deepEqual(registered('SELECT u.di| FROM public.users AS u', 'demo').map(option => option.label), ['id', 'display name']);
    assert.deepEqual(registered('SELECT public.users.di| FROM public.users', 'demo').map(option => option.label), ['id', 'display name']);

    assert.deepEqual(registered('SELECT o.| FROM public.orders o').map(option => option.label), ['id', 'user_id']);
    assert.deepEqual(registered('SELECT id FROM public.users u WHERE u.di|', 'postgres').map(option => option.label), ['id', 'display name']);
});

test('completes global columns before FROM and columns for joined aliases', () => {
    assert.ok(labels('SELECT |').includes('display name'));
    assert.deepEqual(registered('SELECT u.id, o.| FROM public.users u JOIN public.orders o ON o.user_id = u.id').map(option => option.label), ['id', 'user_id']);
    assert.ok(!registered('SELECT * FROM |').some(option => option.type === 'property'));
});

const packageTables: TableSchema[] = [
    ...['packages', 'package_downloads', 'package_satis_client', 'package_versions'].map(name => ({ ...tables[0], name })),
    {
        ...tables[1], name: 'repository_builds',
        columns: ['packages', 'public'].map(name => ({ ...tables[1].columns[0], name, dataType: 'jsonb' })),
    },
];

for (const dialect of ['postgres', 'mysql', 'sqlite', 'mssql', 'demo'] as const) {
    test(`${dialect}: table and schema suggestions survive same-named global columns`, () => {
        for (const sql of [
            'SELECT * FROM |',
            'SELECT *\nFROM package|\nLIMIT 100;',
            'SELECT * FROM repository_builds b JOIN pack|',
        ]) {
            const options = registeredFor(packageTables, sql, dialect);
            assert.ok(options.some(option => option.label === 'packages' && option.type === 'class' && option.detail === 'public'), sql);
            assert.ok(options.some(option => option.label === 'public' && option.type === 'namespace'), sql);
            assert.ok(!options.some(option => option.type === 'property'), sql);
        }
    });
}

test('same-named columns do not hide quoted table suggestions', () => {
    for (const [dialect, opening, closing] of [
        ['postgres', '"', '"'], ['mysql', '`', '`'], ['mssql', '[', ']'],
    ] as const) {
        for (const suffix of ['', closing]) {
            const options = registeredFor(packageTables, `SELECT * FROM ${opening}package|${suffix}`, dialect);
            assert.ok(options.some(option => option.label === `${opening}packages${closing}` && option.type === 'class' && option.apply === undefined));
            assert.ok(!options.some(option => option.type === 'property'));
        }
    }
});

test('column and qualified suggestions remain available when table names collide with columns', () => {
    const global = registeredFor(packageTables, 'SELECT package|');
    assert.ok(global.some(option => option.label === 'packages' && option.type === 'property' && option.detail === 'jsonb'));
    const aliased = registeredFor(packageTables, 'SELECT b.package| FROM repository_builds b');
    assert.ok(aliased.some(option => option.label === 'packages' && option.type === 'property'));
    const qualified = registeredFor(packageTables, 'SELECT * FROM public.package|');
    assert.ok(qualified.some(option => option.label === 'packages' && option.type === 'class'));
});

test('quotes reserved and unusual identifiers with the configured dialect', () => {
    const postgresOrder = registered('SELECT * FROM ord|', 'postgres').find(option => option.label === 'order');
    assert.equal(postgresOrder?.apply, '"order"');
    const mysqlOrder = registered('SELECT * FROM ord|', 'mysql').find(option => option.label === 'order');
    assert.equal(mysqlOrder?.apply, '`order`');
    const mssqlOrder = registered('SELECT * FROM ord|', 'mssql').find(option => option.label === 'order');
    assert.equal(mssqlOrder?.apply, '[order]');
    assert.equal(registered('SELECT |').find(option => option.label === 'display name')?.apply, '"display name"');
});

test('does not offer schema completions inside strings or comments', () => {
    assert.deepEqual(registered("SELECT 'ord|"), []);
    assert.deepEqual(registered('-- ord|'), []);
    const quoted = registered('SELECT * FROM "pub|');
    assert.ok(quoted.some(option => option.label === '"public"' && option.apply === undefined));
});

test('keeps embedded identifier quotes escaped in quoted completion labels', () => {
    const quotedName = [{ ...tables[0], name: 'we"ird' }];
    const options = registeredFor(quotedName, 'SELECT * FROM "we|');
    assert.ok(options.some(option => option.label === '"we""ird"' && option.apply === undefined));
});

test('does not guess aliases for duplicate table names and keeps aliases statement scoped', () => {
    assert.deepEqual(labels('SELECT users.| FROM public.users u'), []);
    assert.deepEqual(labels('SELECT u.x FROM public.users u; SELECT u.|'), []);
});

test('schema construction is safe for prototype-like table and column names', () => {
    const hostile = [{ ...tables[0], schema: '__proto__', name: 'constructor', columns: [{ ...tables[0].columns[0], name: '__proto__' }] }];
    assert.ok(registered('SELECT * FROM con|', 'postgres'));
    const config = createSqlConfig(hostile, 'postgres');
    const state = EditorState.create({ doc: 'SELECT * FROM con', extensions: [createSqlLanguage(hostile, 'postgres')] });
    const result = schemaCompletionSource(config)(new CompletionContext(state, state.doc.length, true));
    assert.ok(result && !(result instanceof Promise));
    assert.ok(result.options.some(option => option.label === 'constructor'));
});

test('a schema and table sharing a name retain their separate completion paths', () => {
    const collision = [
        { ...tables[0], schema: 'public', name: 'public' },
        { ...tables[1], schema: 'public', name: 'orders' },
    ];
    const support = createSqlLanguage(collision, 'demo');
    const state = EditorState.create({ doc: 'SELECT * FROM public.ord', extensions: [support] });
    const sources = state.languageDataAt<((context: CompletionContext) => { options: readonly Completion[] } | null)>('autocomplete', state.doc.length);
    const options = sources.flatMap(source => source(new CompletionContext(state, state.doc.length, true))?.options ?? []);
    assert.ok(options.some(option => option.label === 'orders'));
});

test('completes literal dots in schema and table names through quoted paths', () => {
    const dotted = [{ ...tables[0], schema: 'data.set', name: 'user.profile' }];
    const options = registeredFor(dotted, 'SELECT * FROM "data.set"."user.|');
    assert.ok(options.some(option => option.label === '"user.profile"'));
});
