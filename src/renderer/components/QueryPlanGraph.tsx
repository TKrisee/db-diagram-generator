import { useEffect, useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import dagre from 'dagre';
import type { QueryPlan, QueryPlanNode } from '@shared/queryPlan';
import { planNumber, planRelationLabel, planWalkOrder } from './planPresentation';

type OperatorNode = Node<{ operator: QueryPlanNode; ordinal: number; active: boolean; visited: boolean }, 'operator'>;

function PlanOperator({ data }: NodeProps<OperatorNode>) {
    const { operator, ordinal, active, visited } = data;
    const relation = planRelationLabel(operator);
    return <div className={`plan-operator ${active ? 'plan-operator-active' : ''} ${visited ? 'plan-operator-visited' : ''}`} data-kind={operator.kind}>
        <Handle type="target" position={Position.Bottom} isConnectable={false} />
        <div className="plan-operator-heading"><span>{ordinal}</span><strong title={operator.label}>{operator.label}</strong></div>
        <div className="plan-operator-body">
            <div className="plan-operator-relation" title={relation || operator.label}>{relation || 'Intermediate operation'}</div>
            {operator.index && <div className="plan-operator-index" title={operator.index}>Index · {operator.index}</div>}
            <div className="plan-operator-estimate">{operator.estimatedRows !== undefined ? `≈ ${planNumber(operator.estimatedRows)} rows` : 'Row estimate unavailable'}
                {operator.cost !== undefined && <span>Cost {planNumber(operator.cost)}</span>}</div>
        </div>
        <Handle type="source" position={Position.Top} isConnectable={false} />
    </div>;
}

const nodeTypes = { operator: PlanOperator };
type Props = { plan: QueryPlan; activeId?: string; playing: boolean; onSelect: (id: string) => void };

export default function QueryPlanGraph(props: Props) {
    return <ReactFlowProvider><PlanGraphInner {...props} /></ReactFlowProvider>;
}

function PlanGraphInner({ plan, activeId, playing, onSelect }: Props) {
    const { fitView } = useReactFlow();
    const order = useMemo(() => planWalkOrder(plan), [plan]);
    const layout = useMemo(() => {
        const graph = new dagre.graphlib.Graph();
        graph.setGraph({ rankdir: 'BT', nodesep: 42, ranksep: 85 });
        graph.setDefaultEdgeLabel(() => ({}));
        plan.nodes.forEach(node => graph.setNode(node.id, { width: 246, height: 126 }));
        plan.nodes.forEach(node => node.children.forEach(child => graph.setEdge(child, node.id)));
        dagre.layout(graph);
        return graph;
    }, [plan]);
    const activeIndex = order.findIndex(node => node.id === activeId);
    const visited = new Set(order.slice(0, activeIndex).map(node => node.id));
    const nodes: OperatorNode[] = order.map((operator, index) => ({
        id: operator.id,
        type: 'operator',
        position: { x: layout.node(operator.id).x - 123, y: layout.node(operator.id).y - 63 },
        data: { operator, ordinal: index + 1, active: operator.id === activeId, visited: visited.has(operator.id) },
        ariaLabel: `${operator.label}, ${planRelationLabel(operator) || 'intermediate operation'}. Select to inspect.`,
        selected: operator.id === activeId,
    }));
    const edges: Edge[] = plan.nodes.flatMap(node => node.children.map(child => {
        const active = node.id === activeId;
        return {
            id: `${child}-${node.id}`, source: child, target: node.id, type: 'smoothstep',
            className: active ? 'plan-edge-active' : visited.has(node.id) ? 'plan-edge-visited' : '',
            style: { stroke: active ? '#7c3aed' : visited.has(node.id) ? '#0d9488' : '#94a3b8', strokeWidth: active ? 3.5 : 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: active ? '#7c3aed' : '#94a3b8' },
        };
    }));

    useEffect(() => {
        const timer = window.setTimeout(() => void fitView({ padding: .22, duration: 0 }), 60);
        return () => window.clearTimeout(timer);
    }, [plan, fitView]);

    return <div className={`query-plan-graph ${playing ? 'plan-playing' : ''}`} aria-label="Database execution plan"
        onKeyDownCapture={event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const id = (event.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id');
            if (id) { event.preventDefault(); event.stopPropagation(); onSelect(id); }
        }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: .22 }}
            minZoom={.08} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
            deleteKeyCode={null} onNodeClick={(_, node) => onSelect(node.id)}>
            <Background gap={22} size={1} color="#cbd5e1" />
            <Controls showInteractive={false} />
        </ReactFlow>
    </div>;
}
