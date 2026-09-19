import type { QueryPlan, QueryPlanNode } from '@shared/queryPlan';
import type { QueryStage } from '@shared/query';

/** A dependency walkthrough, not a wall-clock execution trace. */
export function planWalkOrder(plan: QueryPlan): QueryPlanNode[] {
    const byId = new Map(plan.nodes.map(node => [node.id, node]));
    const seen = new Set<string>();
    const ordered: QueryPlanNode[] = [];
    const visit = (id: string) => {
        const node = byId.get(id);
        if (!node || seen.has(id)) return;
        seen.add(id);
        node.children.forEach(visit);
        ordered.push(node);
    };
    plan.roots.forEach(visit);
    plan.nodes.forEach(node => visit(node.id));
    return ordered;
}

/** Highlight known input tables without inferring column lineage from plan text. */
export function planNodeStage(node: QueryPlanNode | undefined, plan: QueryPlan | null): QueryStage | undefined {
    if (!node || !plan) return undefined;
    const byId = new Map(plan.nodes.map(item => [item.id, item]));
    const seen = new Set<string>();
    const references: QueryStage['references'] = [];
    const visit = (item: QueryPlanNode) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        if (item.relation) references.push({ table: item.relation, column: null });
        item.children.forEach(id => { const child = byId.get(id); if (child) visit(child); });
    };
    visit(node);
    return {
        kind: node.kind === 'scan' ? 'source' : node.kind === 'aggregate' ? 'group' : node.kind === 'other' ? 'project' : node.kind,
        label: node.label,
        detail: 'Known source tables feeding this operator.',
        focus: 'tables',
        references,
    };
}

export function planNumber(value: number) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function planRelationLabel(node: QueryPlanNode) {
    return node.relation
        ? `${node.relation.schema ? `${node.relation.schema}.` : ''}${node.relation.name}${node.alias && node.alias !== node.relation.name ? ` (${node.alias})` : ''}`
        : node.alias ?? '';
}
