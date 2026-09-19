import { LanguageSupport } from '@codemirror/language';
import { CompletionContext, ifNotIn, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import {
    MSSQL,
    MySQL,
    PostgreSQL,
    SQLite,
    keywordCompletionSource,
    schemaCompletionSource,
    type SQLConfig,
    type SQLDialect,
    type SQLNamespace,
} from '@codemirror/lang-sql';
import type { Completion } from '@codemirror/autocomplete';
import type { Dialect, TableSchema } from '../../shared/schema';

const dialects: Record<Dialect, SQLDialect> = {
    postgres: PostgreSQL,
    mysql: MySQL,
    sqlite: SQLite,
    mssql: MSSQL,
    // The bundled demo query engine is SQLite.
    demo: SQLite,
};

type NamespaceMap = Record<string, SQLNamespace>;

function map(): NamespaceMap {
    return Object.create(null) as NamespaceMap;
}

// SQLNamespace treats dots in object keys as path separators.
function namespaceKey(name: string): string {
    return name.replaceAll('.', '\\.');
}

function quoteIdentifier(name: string, dialect: SQLDialect): string {
    // SQL Server accepts double quotes too, but brackets match the dialect's
    // conventional identifier syntax and the rest of the application's SQL.
    const opening = dialect === MSSQL ? '[' : (dialect.spec.identifierQuotes?.[0] ?? '"');
    const closing = opening === '[' ? ']' : opening;
    return opening + name.replaceAll(closing, closing + closing) + closing;
}

function identifierCompletion(name: string, type: string, detail: string | undefined, dialect: SQLDialect): Completion {
    const words = new Set([
        ...(dialect.spec.keywords ?? '').split(' '),
        ...(dialect.spec.builtin ?? '').split(' '),
        ...(dialect.spec.types ?? '').split(' '),
    ]);
    const canUseBareIdentifier = /^[a-z_][a-z_\d]*$/.test(name)
        && !words.has(name.toLowerCase())
        && (dialect.spec.caseInsensitiveIdentifiers || name === name.toLowerCase());
    return {
        label: name,
        type,
        detail,
        ...(canUseBareIdentifier ? {} : { apply: quoteIdentifier(name, dialect) }),
    };
}

function tableCompletion(table: TableSchema, dialect: SQLDialect): Completion {
    return {
        ...identifierCompletion(table.name, 'class', table.schema ?? undefined, dialect),
    };
}

function columnCompletion(name: string, dataType: string, dialect: SQLDialect): Completion {
    return identifierCompletion(name, 'property', dataType, dialect);
}

function columnsFor(table: TableSchema, dialect: SQLDialect): readonly Completion[] {
    return table.columns.map(column => columnCompletion(column.name, column.dataType, dialect));
}

/**
 * Build the namespace consumed by CodeMirror's built-in SQL schema completer.
 *
 * A table only appears at the top level when its name identifies exactly one
 * loaded table. Every table is available through its schema path, so duplicate
 * names must be qualified before their columns can be selected.
 */
function schemaNamespace(tables: TableSchema[], dialect: SQLDialect): SQLNamespace {
    const root = map();
    const counts = new Map<string, number>();
    const schemas = new Map<string, TableSchema[]>();
    for (const table of tables) counts.set(table.name, (counts.get(table.name) ?? 0) + 1);
    for (const table of tables) {
        if (table.schema !== null) {
            const group = schemas.get(table.schema) ?? [];
            group.push(table);
            schemas.set(table.schema, group);
        }
    }

    for (const table of tables) {
        // A schema name takes precedence over a same-named table at the root,
        // where SQLNamespace cannot represent two different children by label.
        if (counts.get(table.name) === 1 && !schemas.has(table.name)) {
            root[namespaceKey(table.name)] = { self: tableCompletion(table, dialect), children: columnsFor(table, dialect) };
        }
    }
    for (const [schemaName, schemaTables] of schemas) {
        const children = map();
        for (const table of schemaTables) {
            children[namespaceKey(table.name)] = { self: tableCompletion(table, dialect), children: columnsFor(table, dialect) };
        }
        root[namespaceKey(schemaName)] = {
            self: identifierCompletion(schemaName, 'namespace', undefined, dialect),
            children,
        };
    }
    return root;
}

function globalColumns(tables: TableSchema[], dialect: SQLDialect): Completion[] {
    const seen = new Set<string>();
    const result: Completion[] = [];
    for (const table of tables) {
        for (const column of table.columns) {
            // Before FROM there is no source table to resolve duplicate column
            // names against. Present one deterministic entry for each name.
            if (!seen.has(column.name)) {
                seen.add(column.name);
                result.push(columnCompletion(column.name, column.dataType, dialect));
            }
        }
    }
    return result;
}

export function createSqlConfig(tables: TableSchema[], dialect: Dialect): SQLConfig {
    const sqlDialect = dialects[dialect];
    return {
        dialect: sqlDialect,
        schema: schemaNamespace(tables, sqlDialect),
        // CodeMirror exposes these alongside the schema at an empty expression,
        // which supports SELECT column completion before a FROM clause exists.
        tables: globalColumns(tables, sqlDialect),
        upperCaseKeywords: true,
    };
}

function sourceResultAt(result: CompletionResult, from: number): CompletionResult {
    return { ...result, from };
}

function escapeQuotedOptions(result: CompletionResult, context: CompletionContext): CompletionResult {
    const opening = context.state.sliceDoc(result.from, result.from + 1);
    const closing = opening === '[' ? ']' : opening;
    if (!['"', '`', '['].includes(opening)) return result;
    return {
        ...result,
        options: result.options.map(option => {
            if (option.label[0] !== opening || option.label.at(-1) !== closing) return option;
            const inner = option.label.slice(1, -1).replaceAll(closing, closing + closing);
            return { ...option, label: opening + inner + closing };
        }),
    };
}

function safeSchemaSource(config: SQLConfig): CompletionSource {
    const source = schemaCompletionSource(config);
    return context => {
        const result = source(context);
        return result instanceof Promise || !result ? result : escapeQuotedOptions(result, context);
    };
}

/**
 * Let CodeMirror parse one harmless synthetic character after a dangling dot.
 * Its SQL grammar otherwise leaves `u.` in an error node, even when the later
 * FROM clause already defines u. The same mechanism quotes a loaded schema
 * name when the grammar tokenizes it as a keyword (such as `public`).
 */
function incompletePathSource(config: SQLConfig, schemaNames: Set<string>): CompletionSource {
    const source = safeSchemaSource(config);
    const dialect = config.dialect!;
    const quote = dialect === MSSQL ? '[' : (dialect.spec.identifierQuotes?.[0] ?? '"');
    const close = quote === '[' ? ']' : quote;
    return context => {
        const text = context.state.doc.toString();
        const before = text.slice(0, context.pos);
        const path = /([A-Za-z_][A-Za-z_\d]*)\.(?:[A-Za-z_\d]*)$/.exec(before);
        const dangling = before.endsWith('.');
        if (!path && !dangling) return null;

        let synthetic = text;
        let syntheticPos = context.pos;
        let offset = 0;
        const schemaMatch = [...schemaNames]
            .map(name => ({ name, index: before.lastIndexOf(name + '.') }))
            .filter(match => match.index >= 0 && (match.index === 0 || !/\w/.test(before[match.index - 1])))
            .sort((a, b) => b.index - a.index)[0];
        if (schemaMatch) {
            const start = schemaMatch.index;
            synthetic = text.slice(0, start) + quote + schemaMatch.name + close + text.slice(start + schemaMatch.name.length);
            syntheticPos += 2;
            offset = 2;
        }
        if (dangling) {
            synthetic = synthetic.slice(0, syntheticPos) + 'x' + synthetic.slice(syntheticPos);
            const state = EditorState.create({ doc: synthetic, extensions: [dialect.language] });
            const result = source(new CompletionContext(state, syntheticPos + 1, context.explicit));
            return result instanceof Promise || !result ? result : sourceResultAt(result, context.pos);
        }
        if (!offset) return null;
        const state = EditorState.create({ doc: synthetic, extensions: [dialect.language] });
        const result = source(new CompletionContext(state, syntheticPos, context.explicit));
        return result instanceof Promise || !result ? result : sourceResultAt(result, result.from - offset);
    };
}

function routedSchemaSource(config: SQLConfig, schemaNames: Set<string>): CompletionSource {
    const normal = safeSchemaSource(config);
    const incomplete = incompletePathSource(config, schemaNames);
    return context => {
        const before = context.state.doc.sliceString(0, context.pos);
        const qualified = /[A-Za-z_][A-Za-z_\d]*\.(?:[A-Za-z_\d]*)$/.test(before);
        const attempted = qualified ? incomplete(context) : normal(context);
        // A complete qualified path is already parseable. The synthetic path
        // helper is only needed for dangling dots and keyword schema names.
        const result = qualified && !before.endsWith('.') && !attempted ? normal(context) : attempted;
        if (result instanceof Promise || !result) return result;
        // `tables` carries pre-FROM column candidates. Keep those out of a
        // table-source position while retaining schemas and table entries.
        if (/(?:\bfrom|\bjoin)\s+[A-Za-z_\d]*$/i.test(before)) {
            return { ...result, options: result.options.filter(option => option.type !== 'property') };
        }
        return result;
    };
}

export function createSqlLanguage(tables: TableSchema[], dialect: Dialect): LanguageSupport {
    const config = createSqlConfig(tables, dialect);
    const language = config.dialect!;
    const noCompletionsIn = ['String', 'LineComment', 'BlockComment'];
    const schemaNames = new Set(tables.flatMap(table => table.schema === null ? [] : [table.schema]));
    const keyword = keywordCompletionSource(language, true);
    return new LanguageSupport(language.language, [
        language.language.data.of({
            autocomplete: ifNotIn(noCompletionsIn, routedSchemaSource(config, schemaNames)),
        }),
        language.language.data.of({
            autocomplete: ifNotIn(noCompletionsIn, context => {
                const before = context.state.doc.sliceString(0, context.pos);
                return /[A-Za-z_][A-Za-z_\d]*\.[A-Za-z_\d]*$/.test(before) ? null : keyword(context);
            }),
        }),
    ]);
}
