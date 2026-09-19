import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSelect } from '../src/main/queryAnalysis';

function stage(sql: string, kind: string, dialect: 'postgres' | 'mysql' | 'mssql' | 'sqlite' | 'demo' = 'demo') {
    const found = analyzeSelect(sql, dialect).analysis.stages.find(item => item.kind === kind);
    assert.ok(found, `expected ${kind} stage`);
    return found;
}

test('stage references target only the columns used by each logical clause', () => {
    const filter = stage('SELECT u.name, o.id FROM public.users u JOIN public.orders o ON o.user_id = u.id WHERE o.total >= 50', 'filter');
    assert.equal(filter.focus, 'columns');
    assert.deepEqual(filter.references, [{ table: { schema: 'public', name: 'orders' }, column: 'total' }]);

    const join = stage('SELECT u.name FROM public.users u JOIN public.orders o ON o.user_id = u.id', 'join');
    assert.deepEqual(join.references, [
        { table: { schema: 'public', name: 'orders' }, column: 'user_id' },
        { table: { schema: 'public', name: 'users' }, column: 'id' },
    ]);
});

test('stage references retain a conservative candidate scope for unqualified columns', () => {
    const filter = stage('SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE total >= 50', 'filter');
    assert.deepEqual(filter.references, [{
        table: null,
        column: 'total',
        candidates: [{ schema: null, name: 'users' }, { schema: null, name: 'orders' }],
    }]);
});

test('stage references support quoted identifiers and dialect aliases', () => {
    const postgres = stage('SELECT o."Total" FROM "Sales"."Order Items" o WHERE o."Total" > 50', 'filter', 'postgres');
    assert.deepEqual(postgres.references, [{ table: { schema: 'Sales', name: 'Order Items' }, column: 'Total' }]);

    const mysql = stage('SELECT o.total FROM `orders` o WHERE o.total > 50', 'filter', 'mysql');
    assert.deepEqual(mysql.references, [{ table: { schema: null, name: 'orders' }, column: 'total' }]);
});

test('sort output aliases resolve to their projected source expressions', () => {
    const sort = stage('SELECT o.total AS order_total FROM orders o ORDER BY order_total DESC', 'sort');
    assert.deepEqual(sort.references, [{ table: { schema: null, name: 'orders' }, column: 'total' }]);

    const ordinal = stage('SELECT total AS status, status AS value FROM orders ORDER BY 2', 'sort');
    assert.deepEqual(ordinal.references, [{ table: null, column: 'status', candidates: [{ schema: null, name: 'orders' }] }]);
    const constant = stage('SELECT 2 AS position, total FROM orders ORDER BY position', 'sort');
    assert.deepEqual(constant.references, []);
    const wildcardOrdinal = stage('SELECT u.*, o.total FROM users u JOIN orders o ON u.id=o.user_id ORDER BY 2', 'sort');
    assert.deepEqual(wildcardOrdinal.references, []);
    assert.equal(wildcardOrdinal.unresolved, true);
});

test('constants need no physical references and complex scopes stay unresolved without broad highlights', () => {
    assert.deepEqual(stage('SELECT 1 FROM orders o WHERE 1 = 1', 'filter').references, []);
    const filter = stage('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent WHERE total > 50', 'filter');
    assert.deepEqual(filter.references, []);
    assert.equal(filter.unresolved, true);
});

test('wildcards, USING joins, qualified schemas, and ordinals retain precise stage targets', () => {
    const project = stage('SELECT o.*, COUNT(*) FROM orders o', 'project');
    assert.deepEqual(project.references, [{ table: { schema: null, name: 'orders' }, column: '*' }, { table: { schema: null, name: 'orders' }, column: null }]);

    const join = stage('SELECT * FROM users u JOIN orders o USING (id)', 'join');
    assert.deepEqual(join.references, [{ table: { schema: null, name: 'users' }, column: 'id' }, { table: { schema: null, name: 'orders' }, column: 'id' }]);

    const mssql = stage('SELECT dbo.users.id FROM dbo.users WHERE dbo.users.id = 1', 'filter', 'mssql');
    assert.deepEqual(mssql.references, [{ table: { schema: 'dbo', name: 'users' }, column: 'id' }]);

    const group = stage('SELECT o.total AS value FROM orders o GROUP BY 1', 'group');
    assert.deepEqual(group.references, [{ table: { schema: null, name: 'orders' }, column: 'total' }]);
});

test('unions and unresolved sources do not imply a physical sort or source target', () => {
    const unionSort = stage('SELECT id FROM first_table UNION SELECT id FROM second_table ORDER BY 1', 'sort');
    assert.equal(unionSort.focus, 'result');
    assert.deepEqual(unionSort.references, []);

    const source = stage('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent', 'source');
    assert.equal(source.unresolved, true);
    assert.deepEqual(source.references, []);
});

test('explicit aliases win over same-name table lookup aliases', () => {
    const filter = stage('SELECT * FROM users orders JOIN orders o ON orders.id = o.user_id WHERE orders.name = \'Ada\'', 'filter');
    assert.deepEqual(filter.references, [{ table: { schema: null, name: 'users' }, column: 'name' }]);
});

test('GROUP and HAVING retain unqualified input candidates while ORDER resolves only a bare output alias', () => {
    const group = stage('SELECT o.total AS status FROM orders o GROUP BY status', 'group');
    assert.deepEqual(group.references, [{ table: null, column: 'status', candidates: [{ schema: null, name: 'orders' }] }]);

    const having = stage('SELECT o.total AS status FROM orders o GROUP BY o.total HAVING status > 0', 'having');
    assert.deepEqual(having.references, [{ table: null, column: 'status', candidates: [{ schema: null, name: 'orders' }] }]);

    const nestedOrder = stage('SELECT o.total AS status FROM orders o ORDER BY length(status)', 'sort');
    assert.deepEqual(nestedOrder.references, [{ table: null, column: 'status', candidates: [{ schema: null, name: 'orders' }] }]);

    const siblingOrder = stage('SELECT o.total AS status, status AS value FROM orders o ORDER BY value', 'sort');
    assert.deepEqual(siblingOrder.references, [{ table: null, column: 'status', candidates: [{ schema: null, name: 'orders' }] }]);
});

test('recursive CTE references are not physical source tables', () => {
    for (const dialect of ['postgres', 'demo'] as const) {
        const query = analyzeSelect('WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<3) SELECT * FROM nums', dialect);
        assert.deepEqual(query.analysis.tables, []);
    }
});

test('MySQL double subtraction cannot hide an executable comment', () => {
    assert.throws(() => analyzeSelect("SELECT 1--1 /*!50000 INTO OUTFILE '/tmp/result' */", 'mysql'), /executable comments/);
});

test('analyses a SELECT and removes one terminal delimiter', () => {
    const result = analyzeSelect('/* keep */ SELECT DISTINCT u.id FROM public.users u JOIN orders o ON o.user_id = u.id WHERE u.active = true ORDER BY u.id LIMIT 5;\n', 'postgres');
    assert.equal(result.sql, '/* keep */ SELECT DISTINCT u.id FROM public.users u JOIN orders o ON o.user_id = u.id WHERE u.active = true ORDER BY u.id LIMIT 5\n');
    assert.deepEqual(result.analysis.tables, [{ schema: 'public', name: 'users' }, { schema: null, name: 'orders' }]);
    assert.deepEqual(result.analysis.stages.map(stage => stage.kind), ['source', 'join', 'filter', 'project', 'distinct', 'sort', 'limit', 'result']);
});

test('keeps quoted identifiers and finds tables through CTEs and subqueries', () => {
    const result = analyzeSelect('WITH active AS (SELECT * FROM "Sales"."Order Items") SELECT * FROM active WHERE id IN (SELECT id FROM audit_log)', 'postgres');
    assert.deepEqual(result.analysis.tables, [{ schema: 'Sales', name: 'Order Items' }, { schema: null, name: 'audit_log' }]);
    assert.equal(result.analysis.warnings.length, 1);
});

test('resolves CTE definitions sequentially and keeps schema-qualified physical tables', () => {
    const qualified = analyzeSelect('WITH users AS (SELECT * FROM public.users) SELECT * FROM users', 'postgres');
    assert.deepEqual(qualified.analysis.tables, [{ schema: 'public', name: 'users' }]);

    const nonRecursive = analyzeSelect('WITH users AS (SELECT * FROM users) SELECT * FROM users', 'postgres');
    assert.deepEqual(nonRecursive.analysis.tables, [{ schema: null, name: 'users' }]);
});

test('folds PostgreSQL unquoted identifiers for analysis without changing quoted names or executable SQL', () => {
    const unquoted = analyzeSelect("SELECT 'UPPER TEXT' FROM PUBLIC.USERS", 'postgres');
    assert.equal(unquoted.sql, "SELECT 'UPPER TEXT' FROM PUBLIC.USERS");
    assert.deepEqual(unquoted.analysis.tables, [{ schema: 'public', name: 'users' }]);

    const quoted = analyzeSelect('SELECT * FROM "PUBLIC"."USERS"', 'postgres');
    assert.deepEqual(quoted.analysis.tables, [{ schema: 'PUBLIC', name: 'USERS' }]);
});

test('finds a scalar subquery in a JOIN predicate', () => {
    const result = analyzeSelect('SELECT * FROM accounts a JOIN profiles p ON EXISTS (SELECT 1 FROM audit_log l WHERE l.account_id = a.id)', 'postgres');
    assert.deepEqual(result.analysis.tables, [
        { schema: null, name: 'accounts' },
        { schema: null, name: 'profiles' },
        { schema: null, name: 'audit_log' },
    ]);
    assert.ok(result.analysis.stages.some(stage => stage.kind === 'join'));
});

test('sets an overview warning and a set stage for unions', () => {
    const result = analyzeSelect('SELECT id FROM first_table UNION ALL SELECT id FROM second_table', 'sqlite');
    assert.deepEqual(result.analysis.tables, [{ schema: null, name: 'first_table' }, { schema: null, name: 'second_table' }]);
    assert.ok(result.analysis.stages.some(stage => stage.kind === 'set'));
    assert.equal(result.analysis.warnings.length, 1);
});

test('does not add empty PostgreSQL distinct and limit nodes, and orders UNION stages correctly', () => {
    const plain = analyzeSelect('SELECT * FROM things', 'postgres');
    assert.deepEqual(plain.analysis.stages.map(stage => stage.kind), ['source', 'project', 'result']);

    const union = analyzeSelect('SELECT id FROM first_table UNION SELECT id FROM second_table ORDER BY id LIMIT 3', 'postgres');
    assert.deepEqual(union.analysis.stages.map(stage => stage.kind), ['source', 'project', 'set', 'sort', 'limit', 'result']);
});

test('does not mistake SQL-looking text in strings or comments for another statement', () => {
    const result = analyzeSelect("SELECT 'drop table x; select * from y' AS note FROM things -- ; DELETE FROM things\n", 'sqlite');
    assert.deepEqual(result.analysis.tables, [{ schema: null, name: 'things' }]);
});

test('removes a terminal delimiter before a trailing comment', () => {
    const result = analyzeSelect('SELECT * FROM things; /* cursor query */', 'sqlite');
    assert.equal(result.sql, 'SELECT * FROM things /* cursor query */');
});

test('does not confuse delimiters inside escaped, dollar-quoted, bracketed, or hash-commented SQL', () => {
    assert.equal(analyzeSelect("SELECT 'it\\'s; fine' FROM things;", 'mysql').sql, "SELECT 'it\\'s; fine' FROM things");
    assert.equal(analyzeSelect('SELECT $tag$; still text $tag$ FROM things; -- trailing', 'postgres').sql, 'SELECT $tag$; still text $tag$ FROM things -- trailing');
    assert.equal(analyzeSelect('SELECT * FROM [semi;table];', 'mssql').sql, 'SELECT * FROM [semi;table]');
    assert.equal(analyzeSelect('SELECT * FROM things; # trailing ; comment', 'mysql').sql, 'SELECT * FROM things # trailing ; comment');
    assert.equal(analyzeSelect("SELECT payload #>> '{a}' FROM things;", 'postgres').sql, "SELECT payload #>> '{a}' FROM things");
});

test('rejects MySQL executable comments but preserves their text in quoted literals', () => {
    assert.throws(() => analyzeSelect("SELECT * FROM users /*!50000 INTO OUTFILE '/tmp/x' */", 'mysql'), /executable comments/);
    assert.throws(() => analyzeSelect('SELECT * FROM users /*M!100000 INTO OUTFILE \'/tmp/x\' */', 'mysql'), /executable comments/);
    assert.equal(analyzeSelect("SELECT '/*!50000 INTO OUTFILE' AS note FROM users", 'mysql').sql, "SELECT '/*!50000 INTO OUTFILE' AS note FROM users");
});

test('rejects a non-string SQL value before reading its length', () => {
    assert.throws(() => analyzeSelect(null as unknown as string, 'sqlite'), /SQL must be text/);
});

for (const [name, sql, dialect, message] of [
    ['stacked statements', 'SELECT * FROM users; DELETE FROM users', 'sqlite', 'Only one SELECT'],
    ['CTE mutation', 'WITH changed AS (INSERT INTO users(id) VALUES (1) RETURNING id) SELECT * FROM changed', 'postgres', 'cannot contain INSERT'],
    ['SELECT INTO', 'SELECT * INTO archive FROM users', 'postgres', 'SELECT INTO'],
    ['output file', "SELECT * FROM users INTO OUTFILE 'rows.csv'", 'mysql', 'SELECT INTO'],
    ['locking read', 'SELECT * FROM users FOR UPDATE', 'mysql', 'locking clauses'],
    ['parameter', 'SELECT * FROM users WHERE id = ?', 'sqlite', 'Parameter placeholders'],
] as const) {
    test(`rejects ${name}`, () => {
        assert.throws(() => analyzeSelect(sql, dialect), new RegExp(message));
    });
}
