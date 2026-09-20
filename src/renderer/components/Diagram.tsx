import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    ReactFlow,
    ReactFlowProvider,
    Background,
    Controls,
    ControlButton,
    MiniMap,
    useNodesState,
    useEdgesState,
    useReactFlow,
    getNodesBounds,
} from '@xyflow/react';
import type { Edge, NodeChange, NodePositionChange, OnNodeDrag } from '@xyflow/react';
import { toPng } from 'html-to-image';
import type { DiagramPayload } from '@shared/schema';
import type { QueryStage } from '@shared/query';
import type { QueryStageFocus } from './queryPresentation';
import TableNode, { type TableNodeType } from './TableNode';
import CrowsFootEdge, { CrossingsCtx } from './CrowsFootEdge';
import { buildGraph, tableKey } from './diagramLayout';
import { computeCrossings, resolveCollisions, routeEdgesInGraph } from './edgeRouting';

const nodeTypes = { table: TableNode };
const edgeTypes = { crowsfoot: CrowsFootEdge };

type Props = {
    payload: DiagramPayload;
    controlsTarget?: HTMLDivElement | null;
    showMinimap?: boolean;
    queryKeys?: Set<string>;
    onlyQueryTables?: boolean;
    queryStage?: QueryStage;
    stageFocus?: QueryStageFocus;
    queryPlaying?: boolean;
};

export default function Diagram(props: Props) {
    return (
        <ReactFlowProvider>
            <DiagramInner {...props} />
        </ReactFlowProvider>
    );
}

function DiagramInner({ payload, controlsTarget, showMinimap = true, queryKeys, onlyQueryTables, queryStage, stageFocus, queryPlaying }: Props) {
    const flowRef = useRef<HTMLDivElement>(null);
    const { fitView, getNodes, getViewport, setViewport } = useReactFlow();
    const [snap, setSnap] = useState(true);
    const [showHelp, setShowHelp] = useState(false);
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [filterSearch, setFilterSearch] = useState('');

    const isMac = navigator.platform.toUpperCase().includes('MAC');

    const filteredPayload = useMemo<DiagramPayload>(() => {
        if (queryKeys !== undefined) {
            return onlyQueryTables ? { ...payload, tables: payload.tables.filter(t => queryKeys.has(tableKey(t))) } : payload;
        }
        if (selectedKeys.size === 0) return payload;
        const tables = payload.tables.filter((t) => selectedKeys.has(tableKey(t)));
        return { tables, rootKey: payload.rootKey };
    }, [payload, selectedKeys, queryKeys, onlyQueryTables]);

    const { initialNodes, initialEdges } = useMemo(
        () => buildGraph(filteredPayload),
        [filteredPayload]
    );
    const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);

    // Keep walkthrough emphasis separate from layout state, so stepping never
    // moves tables or resets the user's viewport.
    const visibleNodes = useMemo<TableNodeType[]>(() => nodes.map(node => {
        const active = Boolean(queryStage && stageFocus?.keys.has(node.id));
        const inQuery = queryKeys?.has(node.id);
        return {
            ...node,
            className: queryKeys === undefined ? undefined : [
                inQuery ? 'query-table' : 'query-table-muted',
                active ? 'query-stage-active' : queryStage && inQuery ? 'query-stage-inactive' : '',
            ].join(' '),
            data: {
                ...node.data,
                queryFocus: active ? { label: queryStage!.label, columns: stageFocus!.columns.get(node.id) ?? new Set<string>() } : undefined,
            },
        };
    }), [nodes, queryKeys, queryStage, stageFocus]);
    const visibleEdges = useMemo(() => edges.map(edge => {
        const sourceColumn = edge.sourceHandle?.replace(/-s[lr]$/, '');
        const targetColumn = edge.targetHandle?.replace(/-t[lr]$/, '');
        const active = queryStage?.kind === 'join' && sourceColumn && targetColumn
            && stageFocus?.columns.get(edge.source)?.has(sourceColumn)
            && stageFocus.columns.get(edge.target)?.has(targetColumn);
        return { ...edge, className: active ? 'query-relationship-active' : queryStage ? 'query-relationship-muted' : undefined };
    }), [edges, queryStage, stageFocus]);

    const crossings = useMemo(
        () => computeCrossings(nodes, edges),
        [nodes, edges],
    );

    useEffect(() => {
        setNodes(initialNodes);
        setEdges(initialEdges);
        const id = requestAnimationFrame(() => fitView({ padding: 0.2 }));
        return () => cancelAnimationFrame(id);
    }, [initialNodes, initialEdges, setNodes, setEdges, fitView]);

    const onNodesChangeWithEdgeFlip = useCallback((changes: NodeChange<TableNodeType>[]) => {
        onNodesChange(changes);

        const posChanges = changes.filter(
            (c): c is NodePositionChange => c.type === 'position' && (c as NodePositionChange).position != null,
        );
        if (!posChanges.length) return;

        const posMap = new Map(nodes.map(n => [n.id, n.position]));
        for (const c of posChanges) {
            if (c.position) posMap.set(c.id, c.position);
        }

        const updatedNodes = nodes.map(n => {
            const newPos = posMap.get(n.id);
            return newPos ? { ...n, position: newPos } : n;
        });

        setEdges(eds => {
            const flipped = eds.map(edge => {
                if (!edge.sourceHandle || !edge.targetHandle) return edge;
                const srcPos = posMap.get(edge.source);
                const tgtPos = posMap.get(edge.target);
                if (!srcPos || !tgtPos) return edge;
                const srcIsLeft = srcPos.x < tgtPos.x;
                const srcCol = edge.sourceHandle.replace(/-s[lr]$/, '');
                const tgtCol = edge.targetHandle.replace(/-t[lr]$/, '');
                const newSrc = `${srcCol}-s${srcIsLeft ? 'r' : 'l'}`;
                const newTgt = `${tgtCol}-t${srcIsLeft ? 'l' : 'r'}`;
                if (newSrc === edge.sourceHandle && newTgt === edge.targetHandle) return edge;
                const { vx: _v, vxManual: _m, ...restData } = (edge.data ?? {}) as Record<string, unknown>;
                return { ...edge, sourceHandle: newSrc, targetHandle: newTgt, data: restData };
            });
            return routeEdgesInGraph(updatedNodes, flipped);
        });
    }, [onNodesChange, nodes, setEdges]);

    const onNodeDragStop = useCallback<OnNodeDrag<TableNodeType>>((_, _node, draggedNodes) => {
        const dragMap = new Map(draggedNodes.map(n => [n.id, n]));
        const merged = nodes.map(n => dragMap.has(n.id) ? { ...n, position: dragMap.get(n.id)!.position } : n);
        const resolved = resolveCollisions(merged);
        setNodes(resolved);
        setEdges(eds => routeEdgesInGraph(resolved, eds));
    }, [nodes, setNodes, setEdges]);

    const exportPng = useCallback(async (mode: 'viewport' | 'full') => {
        if (!flowRef.current) return;
        const container = flowRef.current.querySelector('.react-flow') as HTMLElement | null;
        if (!container) return;

        const filter = (n: Node) => {
            if (!(n instanceof HTMLElement)) return true;
            const cls = n.classList;
            return (
                !cls.contains('react-flow__minimap') &&
                !cls.contains('react-flow__controls') &&
                !cls.contains('react-flow__panel') &&
                !cls.contains('react-flow__attribution')
            );
        };

        let dataUrl: string;

        if (mode === 'viewport') {
            fitView({ padding: 0.1, duration: 0 });
            await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
            dataUrl = await toPng(container, { backgroundColor: '#ffffff', pixelRatio: 2, filter });
        } else {
            const allNodes = getNodes();
            if (allNodes.length === 0) return;
            const bounds = getNodesBounds(allNodes);
            const padding = 40;
            const imgWidth = Math.ceil(bounds.width + padding * 2);
            const imgHeight = Math.ceil(bounds.height + padding * 2);

            const savedViewport = getViewport();
            const savedWidth = container.style.width;
            const savedHeight = container.style.height;
            const savedOverflow = container.style.overflow;

            container.style.width = `${imgWidth}px`;
            container.style.height = `${imgHeight}px`;
            container.style.overflow = 'visible';
            setViewport({ x: -bounds.x + padding, y: -bounds.y + padding, zoom: 1 }, { duration: 0 });

            await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

            dataUrl = await toPng(container, {
                backgroundColor: '#ffffff',
                pixelRatio: 2,
                width: imgWidth,
                height: imgHeight,
                filter,
            });

            container.style.width = savedWidth;
            container.style.height = savedHeight;
            container.style.overflow = savedOverflow;
            setViewport(savedViewport, { duration: 0 });
        }

        const link = document.createElement('a');
        link.download = 'schema.png';
        link.href = dataUrl;
        link.click();
    }, [fitView, getNodes, getViewport, setViewport]);

    const allTables = payload.tables;
    const filterMatches = useMemo(() => {
        const q = filterSearch.trim().toLowerCase();
        if (!q) return allTables;
        return allTables.filter((t) => tableKey(t).toLowerCase().includes(q));
    }, [allTables, filterSearch]);

    const toggleKey = (k: string) => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            return next;
        });
    };

    return (
        <CrossingsCtx.Provider value={crossings}>
            <div className={`diagram-wrap ${queryPlaying ? 'query-animating' : ''}`} data-query-stage={queryStage?.kind}>
                {controlsTarget && createPortal(<div className="diagram-sidebar-controls">
                    <section className="sidebar-section" aria-labelledby="diagram-tables-heading">
                        <div className="sidebar-section-heading">
                            <h3 id="diagram-tables-heading">Tables</h3>
                            <span className="sidebar-table-count">
                                {filteredPayload.tables.length} of {allTables.length}
                            </span>
                        </div>
                    {queryKeys === undefined ? <>
                        <span className="sidebar-filter-summary">
                            {selectedKeys.size === 0 ? 'All tables' : `${selectedKeys.size} selected`}
                        </span>
                        <div className="filter-panel">
                            <input
                                type="search"
                                aria-label="Filter tables"
                                placeholder="Search tables…"
                                value={filterSearch}
                                onChange={(e) => setFilterSearch(e.target.value)}
                            />
                            <div className="filter-actions">
                                <button
                                    type="button"
                                    className="btn-link"
                                    onClick={() => setSelectedKeys(new Set(allTables.map(tableKey)))}
                                >
                                    Select all
                                </button>
                                <button
                                    type="button"
                                    className="btn-link"
                                    onClick={() => setSelectedKeys(new Set())}
                                >
                                    Clear
                                </button>
                            </div>
                            <ul className="filter-list">
                                {filterMatches.map((t) => {
                                    const k = tableKey(t);
                                    return (
                                        <li key={k}>
                                            <label>
                                                <input
                                                    type="checkbox"
                                                    checked={selectedKeys.has(k)}
                                                    onChange={() => toggleKey(k)}
                                                />
                                                <span className="filter-table-name" title={k}>
                                                    {t.schema && <span className="schema">{t.schema}.</span>}
                                                    {t.name}
                                                </span>
                                            </label>
                                        </li>
                                    );
                                })}
                                {filterMatches.length === 0 && <li className="empty">No tables match.</li>}
                            </ul>
                        </div>
                    </> : <span className="query-filter-label">{onlyQueryTables ? 'Query tables' : 'All tables'}</span>}
                    </section>
                    <section className="sidebar-section" aria-labelledby="diagram-export-heading">
                        <h3 id="diagram-export-heading">Export PNG</h3>
                        <div className="sidebar-export-actions">
                            <button type="button" onClick={() => void exportPng('viewport')}>Viewport</button>
                            <button type="button" onClick={() => void exportPng('full')}>Full diagram</button>
                        </div>
                    </section>
                </div>, controlsTarget)}
                <div ref={flowRef} className="diagram">
                    <ReactFlow
                        nodes={visibleNodes}
                        edges={visibleEdges}
                        onNodesChange={onNodesChangeWithEdgeFlip}
                        onEdgesChange={onEdgesChange}
                        onNodeDragStop={onNodeDragStop}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        fitView
                        snapToGrid={snap}
                        snapGrid={[20, 20]}
                        elevateEdgesOnSelect
                        onEdgeClick={(e) => e.stopPropagation()}
                        proOptions={{ hideAttribution: true }}
                    >
                        <Background />
                        {filteredPayload.tables.length === 0 && <div className="diagram-empty">No source tables to show for this query.</div>}
                        <Controls>
                            <ControlButton
                                onClick={() => setSnap((s) => !s)}
                                title={snap ? 'Snap to grid: on' : 'Snap to grid: off'}
                                className={snap ? 'snap-on' : ''}
                            >
                                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M2 6h12M2 10h12M6 2v12M10 2v12" />
                                </svg>
                            </ControlButton>
                            <ControlButton
                                onClick={() => setShowHelp((s) => !s)}
                                title="Keyboard shortcuts"
                                className={showHelp ? 'snap-on' : ''}
                            >
                                ?
                            </ControlButton>
                        </Controls>
                        {showHelp && (
                            <div className="hotkeys-panel">
                                <div className="hotkeys-title">Shortcuts</div>
                                <table className="hotkeys-table">
                                    <tbody>
                                        <tr><td><kbd>{isMac ? '⌘' : 'Ctrl'}</kbd> + click</td><td>Multi-select edges / nodes</td></tr>
                                        <tr><td><kbd>Shift</kbd> + drag</td><td>Selection box</td></tr>
                                        <tr><td>Scroll</td><td>Zoom</td></tr>
                                        <tr><td>Drag canvas</td><td>Pan</td></tr>
                                        <tr><td><kbd>Esc</kbd></td><td>Deselect all</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {showMinimap && <MiniMap pannable zoomable nodeColor="#4a6fa5" nodeStrokeWidth={0} maskColor="rgba(100,120,160,0.35)" style={{ border: '1px solid #000', borderRadius: 8, backgroundColor: '#e8ecf2' }} />}
                    </ReactFlow>
                </div>
            </div>
        </CrossingsCtx.Provider>
    );
}
