import { useState } from 'react';
import type { DiagramPayload, Dialect } from '@shared/schema';
import ConnectionForm from './components/ConnectionForm';
import QueryWorkspace from './components/QueryWorkspace';

type Stage = 'connect' | 'diagram';

export default function App() {
    const [stage, setStage] = useState<Stage>('connect');
    const [diagram, setDiagram] = useState<DiagramPayload | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dialect, setDialect] = useState<Dialect>('demo');
    const [sidebarOpen, setSidebarOpen] = useState(true);

    const handleConnected = async (connectedDialect: Dialect) => {
        setBusy(true);
        setError(null);
        try {
            const d = await window.db.getDiagram();
            setDiagram(d);
            setDialect(connectedDialect);
            setStage('diagram');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const handleDisconnect = async () => {
        await window.db.disconnect();
        setDiagram(null);
        setStage('connect');
    };

    return (
        <div className="app">
            <header className="app-header">
                <div className="app-header-brand">
                    {stage === 'diagram' && <button type="button" className="sidebar-toggle"
                        aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                        title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                        aria-expanded={sidebarOpen} aria-controls="workspace-sidebar"
                        onClick={() => setSidebarOpen(open => !open)}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                            <rect x="3" y="4" width="18" height="16" rx="2" />
                            <path d="M9 4v16" />
                        </svg>
                        Sidebar
                    </button>}
                    <h1>DB Diagram Generator</h1>
                </div>
                {stage !== 'connect' && <div className="app-header-actions">
                    <button onClick={handleDisconnect} className="btn-link">Disconnect</button>
                </div>}
            </header>
            {error && <div className="error">{error}</div>}
            {stage === 'connect' && <ConnectionForm onConnected={handleConnected} busy={busy} />}
            {stage === 'diagram' && diagram && <QueryWorkspace payload={diagram} dialect={dialect}
                sidebarOpen={sidebarOpen} />}
        </div>
    );
}
