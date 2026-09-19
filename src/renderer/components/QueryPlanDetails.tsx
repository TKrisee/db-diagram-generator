import type { QueryPlanNode, QueryPlanResult } from '@shared/queryPlan';
import { planNumber, planRelationLabel } from './planPresentation';

type Props = {
    plan: QueryPlanResult | null;
    node?: QueryPlanNode;
    step: number;
    count: number;
    playing: boolean;
    speed: number;
    canShowSchema: boolean;
    onPlay: () => void;
    onStep: (step: number) => void;
    onSpeed: (speed: number) => void;
    onShowSchema: () => void;
};

export default function QueryPlanDetails({ plan, node, step, count, playing, speed, canShowSchema, onPlay, onStep, onSpeed, onShowSchema }: Props) {
    if (!plan) return <div className="query-empty plan-empty-details"><strong>Explore the database’s chosen plan</strong>
        <p>Explain shows scans, indexes, joins, and other operations without running your SELECT.</p></div>;
    return <section className="query-plan-details" aria-label="Execution plan details">
        <div className="query-section-heading"><strong>{plan.engine === 'demo' ? 'SQLite demo plan' : 'Estimated execution plan'}</strong>
            <span className="muted">Fetched in {Math.round(plan.durationMs)} ms</span></div>
        {count > 0 && <div className="query-playback">
            <button className="btn-secondary" onClick={onPlay}>{playing ? 'Pause plan' : step >= count - 1 ? 'Replay plan' : 'Play plan'}</button>
            <button className="btn-secondary" disabled={step <= 0} onClick={() => onStep(step - 1)} aria-label="Previous operator">←</button>
            <button className="btn-secondary" disabled={step >= count - 1} onClick={() => onStep(step + 1)}>Next operator →</button>
            <select aria-label="Plan animation speed" value={speed} onChange={event => onSpeed(Number(event.target.value))}>
                <option value={.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option>
            </select>
        </div>}
        <p className="query-walkthrough-note">Walks through plan dependencies, not exact execution timing. Row counts and costs are estimates; cost is not milliseconds.</p>
        {node && <div className="plan-node-details" aria-live="polite">
            <div className="plan-detail-heading"><span className="plan-step-count">{step + 1} / {count}</span><strong>{node.label}</strong></div>
            <dl>
                {planRelationLabel(node) && <><dt>Source</dt><dd>{planRelationLabel(node)}</dd></>}
                {node.index && <><dt>Index</dt><dd>{node.index}</dd></>}
                {node.estimatedRows !== undefined && <><dt>Estimated rows</dt><dd>{planNumber(node.estimatedRows)}</dd></>}
                {node.cost !== undefined && <><dt>Estimated cost</dt><dd>{planNumber(node.cost)}</dd></>}
                {node.details.map((detail, index) => <div className="plan-detail-pair" key={index}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}
            </dl>
            {canShowSchema ? <button className="btn-link" onClick={onShowSchema}>Show source tables in schema →</button>
                : <p className="query-walkthrough-note">No physical source table could be linked to this operator.</p>}
        </div>}
        {plan.warnings.length > 0 && <div className="query-warnings">{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        <details className="plan-raw"><summary>Native {plan.format.toUpperCase()} plan</summary><pre>{plan.raw}</pre></details>
    </section>;
}
