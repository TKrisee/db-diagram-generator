import { useEffect, useMemo, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, tooltips } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { acceptCompletion, autocompletion, closeCompletion, completionStatus, startCompletion } from '@codemirror/autocomplete';
import type { Dialect, TableSchema } from '@shared/schema';
import { createSqlLanguage } from './sqlLanguage';

type Props = {
    value: string;
    onChange: (sql: string) => void;
    onRun: () => void;
    tables: TableSchema[];
    dialect: Dialect;
    disabled: boolean;
};

function editability(disabled: boolean) {
    return [
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
        EditorView.contentAttributes.of({
            id: 'sql-editor',
            'aria-label': 'SQL editor',
            'aria-describedby': 'sql-editor-hint sql-completion-hint',
            'aria-disabled': String(disabled),
            spellcheck: 'false',
            autocapitalize: 'off',
            autocorrect: 'off',
        }),
    ];
}

export default function SqlEditor({ value, onChange, onRun, tables, dialect, disabled }: Props) {
    const host = useRef<HTMLDivElement>(null);
    const editor = useRef<EditorView | null>(null);
    const callbacks = useRef({ onChange, onRun });
    callbacks.current = { onChange, onRun };
    const compartments = useMemo(() => ({ language: new Compartment(), editable: new Compartment() }), []);
    const language = useMemo(() => createSqlLanguage(tables, dialect), [tables, dialect]);

    useEffect(() => {
        if (!host.current) return;
        const run = (view: EditorView) => {
            closeCompletion(view);
            if (!view.state.readOnly) callbacks.current.onRun();
            return true;
        };
        const view = new EditorView({
            parent: host.current,
            state: EditorState.create({
                doc: value,
                extensions: [
                    compartments.language.of(language),
                    compartments.editable.of(editability(disabled)),
                    history(),
                    syntaxHighlighting(defaultHighlightStyle),
                    Prec.highest(keymap.of([
                        { key: 'Mod-Enter', run },
                        { key: 'Ctrl-Enter', run },
                        {
                            key: 'Escape',
                            run: view => {
                                view.setTabFocusMode(2000);
                                return closeCompletion(view);
                            },
                        },
                        {
                            key: 'Tab',
                            run: view => {
                                if (completionStatus(view.state) === 'active') {
                                    acceptCompletion(view);
                                    return true;
                                }
                                return indentMore(view);
                            },
                            shift: view => { closeCompletion(view); return indentLess(view); },
                            preventDefault: true,
                        },
                    ])),
                    autocompletion({ activateOnTypingDelay: 150, maxRenderedOptions: 40 }),
                    tooltips({ parent: document.body }),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
                    }),
                ],
            }),
        });
        editor.current = view;
        return () => { editor.current = null; view.destroy(); };
        // Keep one editor instance and its undo history; props are synchronized below.
    }, []);

    useEffect(() => {
        editor.current?.dispatch({ effects: compartments.language.reconfigure(language) });
    }, [language, compartments]);

    useEffect(() => {
        const view = editor.current;
        if (!view) return;
        if (disabled) closeCompletion(view);
        view.dispatch({ effects: compartments.editable.reconfigure(editability(disabled)) });
    }, [disabled, compartments]);

    useEffect(() => {
        const view = editor.current;
        if (view && view.state.doc.toString() !== value) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
        }
    }, [value]);

    return (
        <>
            <div className={`sql-editor ${disabled ? 'sql-editor-disabled' : ''}`} ref={host} />
            <div className="sql-editor-help" id="sql-completion-hint">
                <button type="button" className="btn-link" disabled={disabled}
                    title="Show SQL suggestions (Ctrl+Space)"
                    onClick={() => {
                        if (editor.current) { editor.current.focus(); startCompletion(editor.current); }
                    }}>Suggestions <kbd>Ctrl+Space</kbd></button>
                <span>↑↓ choose · Enter/Tab accept · Tab / Shift+Tab indent · Esc, then Tab leaves editor</span>
            </div>
        </>
    );
}
