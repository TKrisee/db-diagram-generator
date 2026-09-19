import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiagramPayload, Dialect } from '@shared/schema';
import type { QueryAnalysis, QueryResult } from '@shared/query';
import Diagram from './Diagram';
import SqlEditor from './SqlEditor';
import { displayValue, initialQuery, resolveQueryStage, resolveQueryTables } from './queryPresentation';

type Props = {
    payload: DiagramPayload;
    dialect: Dialect;
    sidebarOpen: boolean;
};
const QUERY_PREVIEW_DELAY_MS = 1500;

function errorMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export default function QueryWorkspace({ payload, dialect, sidebarOpen }: Props) {
    const [diagramControlsTarget, setDiagramControlsTarget] = useState<HTMLDivElement | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [sql, setSql] = useState(() => initialQuery(payload.tables, dialect));
    const [analysis, setAnalysis] = useState<QueryAnalysis | null>(null);
    const [analyzedSql, setAnalyzedSql] = useState<string | null>(null);
    const [result, setResult] = useState<QueryResult | null>(null);
    const [error, setError] = useState('');
    const [running, setRunning] = useState(false);
    const [onlyQueryTables, setOnlyQueryTables] = useState(true);
    const [step, setStep] = useState(-1);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [replay, setReplay] = useState(0);
    const [resultSearch, setResultSearch] = useState('');
    const execution = useRef(0);
    const inFlight = useRef(false);
    const reducedMotion = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    useEffect(() => () => { execution.current++; }, []);

    useEffect(() => {
        if (!editorOpen || !sql.trim()) return;
        let cancelled = false;
        const timer = window.setTimeout(async () => {
            try {
                const next = await window.db.analyzeQuery(sql);
                if (!cancelled) { setAnalysis(next); setAnalyzedSql(sql); }
            } catch {
                // Incomplete SQL is normal while editing. Keep the last valid preview;
                // execution below reports errors when the user explicitly runs the query.
            }
        }, QUERY_PREVIEW_DELAY_MS);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [sql, editorOpen]);

    const resolved = useMemo(() => resolveQueryTables(analysis?.tables ?? [], payload.tables), [analysis, payload.tables]);
    const queryKeysSignature = JSON.stringify([...resolved.keys].sort());
    // Keep node positions and the viewport when an edit uses the same source tables.
    const queryKeys = useMemo(() => new Set<string>(JSON.parse(queryKeysSignature)), [queryKeysSignature]);
    const previewIsCurrent = analyzedSql === sql;
    const stages = result?.analysis.stages ?? [];
    const currentStage = stages[step];
    const stageFocus = useMemo(() => resolveQueryStage(currentStage, payload.tables), [currentStage, payload.tables]);
    const resultFocused = currentStage?.focus === 'result';

    useEffect(() => {
        if (!playing || !editorOpen) return;
        if (step >= stages.length - 1) { setPlaying(false); return; }
        const timer = window.setTimeout(() => setStep(s => s + 1), 1800 / speed);
        return () => window.clearTimeout(timer);
    }, [playing, editorOpen, step, stages.length, speed]);

    const changeSql = (next: string) => {
        setSql(next);
        if (!next.trim()) { setAnalysis(null); setAnalyzedSql(null); }
        setResult(null);
        setError('');
        setPlaying(false);
        setStep(-1);
        setResultSearch('');
    };

    const runQuery = async () => {
        if (inFlight.current || !sql.trim()) return;
        inFlight.current = true;
        const id = ++execution.current;
        setRunning(true);
        setError('');
        setResult(null);
        setPlaying(false);
        setStep(-1);
        setResultSearch('');
        try {
            const next = await window.db.executeQuery(sql);
            if (execution.current !== id) return;
            setResult(next);
            setAnalysis(next.analysis);
            setAnalyzedSql(sql);
            setStep(reducedMotion.current ? next.analysis.stages.length - 1 : 0);
            setPlaying(!reducedMotion.current);
            setReplay(r => r + 1);
        } catch (err) {
            if (execution.current === id) setError(errorMessage(err));
        } finally {
            inFlight.current = false;
            if (execution.current === id) setRunning(false);
        }
    };

    const visibleRows = useMemo(() => {
        const search = resultSearch.toLowerCase().trim();
        return (result?.rows ?? []).map((cells, index) => ({ cells, index }))
            .filter(row => !search || row.cells.some(value => displayValue(value).toLowerCase().includes(search)));
    }, [result, resultSearch]);

    const warnings = result ? [...result.analysis.warnings, ...resolved.warnings] : [];
    const isMac = navigator.platform.toUpperCase().includes('MAC');

    return (
        <div className={`database-workspace ${sidebarOpen ? 'sidebar-open' : ''}`}>
            <aside className="workspace-sidebar" id="workspace-sidebar" aria-label="Workspace" hidden={!sidebarOpen}>
                <div className="sidebar-heading">
                    <h2>Workspace</h2>
                    <span className="workspace-caption">{dialect === 'demo' ? 'Demo · sample data' : dialect === 'postgres' ? 'PostgreSQL' : dialect === 'mssql' ? 'SQL Server' : dialect === 'sqlite' ? 'SQLite' : 'MySQL'}</span>
                </div>
                <div className="workspace-tabs" role="group" aria-label="Workspace view">
                    <button className={!editorOpen ? 'active' : ''} aria-pressed={!editorOpen}
                        onClick={() => { setEditorOpen(false); setPlaying(false); }}>Schema</button>
                    <button className={editorOpen ? 'active' : ''} aria-pressed={editorOpen}
                        onClick={() => setEditorOpen(true)}>SQL editor</button>
                </div>
                {editorOpen && (
                    <div className="query-diagram-options">
                        <label className="checkbox"><input type="checkbox" checked={onlyQueryTables}
                            onChange={event => setOnlyQueryTables(event.target.checked)} />Only tables in query</label>
                        <span className="muted">{analysis ? `${resolved.keys.size} referenced${previewIsCurrent ? '' : ' · last valid query'}` : 'Waiting for a complete SELECT'}</span>
                    </div>
                )}
                <div ref={setDiagramControlsTarget} />
            </aside>
            <div className={`query-workspace ${editorOpen ? 'editor-open' : ''} ${playing && editorOpen ? 'query-playing' : ''}`}
                data-query-stage={editorOpen ? currentStage?.kind : undefined}>
                <div className="query-diagram">
                    {editorOpen && currentStage && <div className="query-stage-summary" role="status" aria-live="polite">
                        <div className="query-stage-summary-heading">
                            <span className="query-stage-number">{step + 1}</span>
                            <strong>{currentStage.label}</strong>
                            <span className="query-stage-progress">{step + 1} of {stages.length}</span>
                        </div>
                        <p>{currentStage.detail}</p>
                        <div className="query-stage-targets">
                            {resultFocused ? <span>Result rows</span> : stageFocus.labels.length
                                ? stageFocus.labels.map(label => <span key={label}>{label}</span>)
                                : <span>No source columns highlighted</span>}
                        </div>
                        {stageFocus.warnings.map(warning => <p className="query-stage-warning" key={warning}>{warning}</p>)}
                    </div>}
                    <Diagram payload={payload}
                        controlsTarget={diagramControlsTarget}
                        queryKeys={editorOpen && analysis ? queryKeys : undefined}
                        onlyQueryTables={editorOpen && onlyQueryTables && Boolean(analysis)}
                        queryStage={editorOpen ? currentStage : undefined}
                        stageFocus={editorOpen ? stageFocus : undefined}
                        queryPlaying={playing && editorOpen} />
                    {editorOpen && <div className="query-diagram-caption">
                        <span>{currentStage ? 'Highlighted tables and columns belong to this step. ' : 'Referenced tables are highlighted. '}Lines show schema foreign keys.</span>
                    </div>}
                </div>
                {editorOpen && (
                    <section className="query-panel" aria-label="SQL query workspace">
                        <div className="sql-editor-section">
                            <div className="query-section-heading"><label htmlFor="sql-editor">SQL editor</label>
                                <span className="query-limit">500 rows max · 15s timeout</span></div>
                            <SqlEditor value={sql} onChange={changeSql} onRun={() => void runQuery()}
                                tables={payload.tables} dialect={dialect} disabled={running} />
                            <div className="query-run-row">
                                <span id="sql-editor-hint" className="muted">{isMac ? '⌘' : 'Ctrl'} + Enter to run</span>
                                <button onClick={() => void runQuery()} disabled={running || !sql.trim()}>{running ? 'Running…' : 'Run SELECT'}</button>
                            </div>
                            <div className="query-analysis-status" role="status">
                                {!sql.trim() ? 'Write a SELECT query to explore your data.' : previewIsCurrent && analysis
                                    ? `${analysis.tables.length} source table${analysis.tables.length === 1 ? '' : 's'} detected`
                                    : 'Diagram updates after you pause on a complete SELECT.'}
                            </div>
                            {warnings.length > 0 && <div className="query-warnings">{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
                            {error && <div className="query-error" role="alert">{error}</div>}
                        </div>
                        {result && (
                            <section className="query-walkthrough" aria-label="Query walkthrough">
                                <div className="query-section-heading"><strong>Query walkthrough</strong>
                                    <span className="muted">Logical stages</span></div>
                                <div className="query-steps">
                                    {stages.map((stage, index) => <button key={index}
                                        className={`query-step ${index === step ? 'current' : index < step ? 'complete' : ''}`}
                                        aria-current={index === step ? 'step' : undefined} title={stage.detail}
                                        onClick={() => { setStep(index); setPlaying(false); }}>
                                        <span>{index + 1}</span>{stage.label}
                                    </button>)}
                                </div>
                                <div className="query-playback">
                                    <button className="btn-secondary" onClick={() => {
                                        if (step >= stages.length - 1) { setStep(0); setReplay(r => r + 1); }
                                        setPlaying(p => !p);
                                    }}>{playing ? 'Pause' : step >= stages.length - 1 ? 'Replay' : 'Play'}</button>
                                    <button className="btn-secondary" disabled={step >= stages.length - 1}
                                        onClick={() => { setPlaying(false); setStep(s => Math.min(s + 1, stages.length - 1)); }}>Step →</button>
                                    <button className="btn-link" disabled={step >= stages.length - 1}
                                        onClick={() => { setPlaying(false); setStep(stages.length - 1); }}>Show result</button>
                                    <select aria-label="Animation speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
                                        <option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option>
                                    </select>
                                </div>
                                <p className="query-walkthrough-note">Illustrates SQL clauses; intermediate rows and database execution order are not measured.</p>
                            </section>
                        )}
                        <section className={`query-results ${resultFocused ? 'query-results-active' : ''}`} aria-label="Query results" aria-busy={running}>
                            <div className="query-section-heading"><strong>Results {resultFocused && <span className="query-result-stage">{currentStage.label}</span>}</strong>
                                {result && <span className="muted">{result.rows.length} row{result.rows.length === 1 ? '' : 's'} · {Math.round(result.durationMs)} ms</span>}</div>
                            {!result ? <div className="query-empty"><strong>{running ? 'Running your SELECT…' : 'See what your query returns'}</strong>
                                <p>{running ? 'The result will appear here when the database responds.' : 'Run a query to view rows and follow the animated walkthrough.'}</p></div> : <>
                                {result.truncated && <div className="query-truncated" role="status">Showing the first {result.rowLimit} rows. Add a WHERE clause or a smaller limit to narrow the result.</div>}
                                <input className="result-search" type="search" aria-label="Filter result rows" placeholder="Filter returned rows…"
                                    value={resultSearch} onChange={event => setResultSearch(event.target.value)} />
                                {resultSearch && <div className="result-filter-count">{visibleRows.length} of {result.rows.length} returned rows</div>}
                                <div className={`query-result-scroll ${currentStage?.kind === 'result' ? 'result-revealed' : ''}`} key={replay}>
                                    <table className="query-result-table"><thead><tr><th scope="col" className="row-number">#</th>
                                        {result.columns.map((column, index) => <th scope="col" key={index} title={column}>{column}</th>)}
                                    </tr></thead><tbody>
                                        {visibleRows.map(({ cells, index }, position) => <tr key={index} style={{ animationDelay: `${Math.min(position, 12) * 35}ms` }}>
                                            <td className="row-number">{index + 1}</td>
                                            {cells.map((value, cell) => <td key={cell} className={value === null ? 'null-value' : typeof value === 'number' ? 'numeric-value' : ''}
                                                title={displayValue(value)}>{displayValue(value)}</td>)}
                                        </tr>)}
                                    </tbody></table>
                                    {visibleRows.length === 0 && <div className="query-empty">{result.rows.length === 0 ? 'Query completed. No rows returned.' : 'No returned rows match your filter.'}</div>}
                                </div>
                            </>}
                        </section>
                    </section>
                )}
            </div>
        </div>
    );
}
