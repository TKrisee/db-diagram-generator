import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import type { ColumnMeta, IndexMeta } from '@shared/schema';

export type TableNodeData = {
    schema: string | null;
    name: string;
    columns: ColumnMeta[];
    fkColumns: Set<string>;
    connectedFkColumns: Set<string>;
    referencedColumns: Set<string>;
    isRoot: boolean;
    width: number;
    uqLabels: Map<string, string>;
    uqGroups: Map<string, string[]>;
    indexes: IndexMeta[];
    queryFocus?: { label: string; columns: Set<string> };
};

export type TableNodeType = Node<TableNodeData, 'table'>;

export default function TableNode({ data }: NodeProps<TableNodeType>) {
    return (
        <div className={`table-node ${data.isRoot ? 'root' : ''}`} style={{ width: data.width }}>
            {data.queryFocus && <div className="query-stage-badge">{data.queryFocus.label}</div>}
            <div className="table-header">
                {data.schema && <span className="schema">{data.schema}.</span>}
                <span className="name">{data.name}</span>
            </div>
            <ul className="columns">
                {data.columns.map((c) => (
                    <li key={c.name} className={`column ${data.queryFocus?.columns.has(c.name) ? 'query-stage-column' : ''}`}
                        data-column={c.name}>
                        <Handle
                            type="target"
                            position={Position.Left}
                            id={`${c.name}-tl`}
                            className={`col-handle${data.referencedColumns.has(c.name) ? '' : ' col-handle--hidden'}`}
                        />
                        <Handle
                            type="source"
                            position={Position.Left}
                            id={`${c.name}-sl`}
                            className={`col-handle${data.connectedFkColumns.has(c.name) ? '' : ' col-handle--hidden'}`}
                        />
                        <span className="col-name">
                            {c.isPrimaryKey && <span className="badge pk" title="Primary key">PK</span>}
                            {data.fkColumns.has(c.name) && <span className="badge fk" title="Foreign key">FK</span>}
                            {(() => {
                                const uqLabel = data.uqLabels.get(c.name);
                                if (!uqLabel || c.isPrimaryKey) return null;
                                const group = data.uqGroups.get(uqLabel);
                                const title = group ? `Composite unique key: (${group.join(', ')})` : 'Unique';
                                return <span className="badge uq" title={title}>{uqLabel}</span>;
                            })()}
                            {c.name}
                        </span>
                        <span className="col-type">
                            {c.dataType}
                            {c.nullable ? '' : ' NOT NULL'}
                        </span>
                        <Handle
                            type="source"
                            position={Position.Right}
                            id={`${c.name}-sr`}
                            className={`col-handle${data.connectedFkColumns.has(c.name) ? '' : ' col-handle--hidden'}`}
                        />
                        <Handle
                            type="target"
                            position={Position.Right}
                            id={`${c.name}-tr`}
                            className={`col-handle${data.referencedColumns.has(c.name) ? '' : ' col-handle--hidden'}`}
                        />
                    </li>
                ))}
            </ul>
            {data.indexes.length > 0 && (
                <>
                    <div className="node-index-header">Indexes</div>
                    {data.indexes.map((idx) => (
                        <div key={idx.name} className="node-index-row">
                            <span className="node-index-name">
                                {idx.type && <span className="badge idx-type">{idx.type}</span>}
                                {idx.name}
                            </span>
                            <span className="node-index-cols">[{idx.columns.join(', ')}]</span>
                        </div>
                    ))}
                </>
            )}
        </div>
    );
}
