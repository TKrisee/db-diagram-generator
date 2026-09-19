import { useEffect, useState, useCallback } from 'react';
import type { ConnectionConfig, Dialect } from '@shared/schema';
import type { SavedConnectionMeta } from '@shared/ipc';

type Props = { onConnected: (dialect: Dialect) => void; busy: boolean };

const DIALECT_DEFAULT_PORT: Record<'postgres' | 'mysql' | 'mssql', string> = {
    postgres: '5432',
    mysql: '3306',
    mssql: '1433'
};

export default function ConnectionForm({ onConnected, busy }: Props) {
    const [dialect, setDialect] = useState<Dialect>('demo');
    const [host, setHost] = useState('localhost');
    const [port, setPort] = useState('5432');
    const [user, setUser] = useState('');
    const [password, setPassword] = useState('');
    const [database, setDatabase] = useState('');
    const [file, setFile] = useState('');
    const [ssl, setSsl] = useState(false);
    const [useSsh, setUseSsh] = useState(false);
    const [sshHost, setSshHost] = useState('');
    const [sshPort, setSshPort] = useState('22');
    const [sshUser, setSshUser] = useState('');
    const [sshPassword, setSshPassword] = useState('');
    const [saveAs, setSaveAs] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [saved, setSaved] = useState<SavedConnectionMeta[]>([]);

    const resetForm = () => {
        setDialect('demo');
        setHost('localhost');
        setPort('5432');
        setUser('');
        setPassword('');
        setDatabase('');
        setFile('');
        setSsl(false);
        setUseSsh(false);
        setSshHost('');
        setSshPort('22');
        setSshUser('');
        setSshPassword('');
        setSaveAs('');
        setEditingId(null);
        setError(null);
    };

    const refreshSaved = useCallback(async () => {
        setSaved(await window.db.listSaved());
    }, []);

    useEffect(() => {
        refreshSaved();
    }, [refreshSaved]);

    const buildCfg = (): ConnectionConfig => {
        if (dialect === 'demo') return { dialect: 'demo' };
        if (dialect === 'sqlite') return { dialect: 'sqlite', file };
        return {
            dialect,
            host,
            port: Number(port),
            user,
            password,
            database,
            ssl,
            ...(useSsh
                ? {
                    ssh: {
                        host: sshHost,
                        port: Number(sshPort),
                        user: sshUser,
                        password: sshPassword
                    }
                }
                : {})
        };
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        const cfg = buildCfg();
        setPending(true);
        try {
            const res = await window.db.connect(cfg);
            if (!res.ok) {
                setError(res.error);
                return;
            }
            if (saveAs.trim()) {
                const saveRes = await window.db.saveConnection(saveAs.trim(), cfg);
                if (!saveRes.ok) {
                    setError(`Connected, but save failed: ${saveRes.error}`);
                }
            }
            onConnected(cfg.dialect);
        } finally {
            setPending(false);
        }
    };

    const handleDialectChange = (d: Dialect) => {
        setDialect(d);
        if (d === 'postgres' || d === 'mysql' || d === 'mssql') setPort(DIALECT_DEFAULT_PORT[d]);
    };

    const loadSaved = async (id: string) => {
        setError(null);
        setEditingId(id);
        const cfg = await window.db.loadSaved(id);
        setDialect(cfg.dialect);
        if (cfg.dialect === 'sqlite') {
            setFile(cfg.file);
            setUseSsh(false);
        } else if (cfg.dialect !== 'demo') {
            setHost(cfg.host);
            setPort(String(cfg.port));
            setUser(cfg.user);
            setPassword(cfg.password);
            setDatabase(cfg.database);
            setSsl(cfg.ssl ?? false);
            if (cfg.ssh) {
                setUseSsh(true);
                setSshHost(cfg.ssh.host);
                setSshPort(String(cfg.ssh.port));
                setSshUser(cfg.ssh.user);
                setSshPassword(cfg.ssh.password);
            } else {
                setUseSsh(false);
            }
        }
        setSaveAs('');
    };

    const connectSaved = async (id: string) => {
        setError(null);
        setPending(true);
        try {
            const cfg = await window.db.loadSaved(id);
            const res = await window.db.connect(cfg);
            if (!res.ok) {
                setError(res.error);
                return;
            }
            onConnected(cfg.dialect);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(false);
        }
    };

    const deleteSaved = async (id: string, name: string) => {
        if (!confirm(`Delete saved connection "${name}"?`)) return;
        await window.db.deleteConnection(id);
        refreshSaved();
    };

    return (
        <div className="connect-page">
            {saved.length > 0 && (
                <div className="card">
                    <h2>Saved connections</h2>
                    <ul className="saved-list">
                        {saved.map((s) => (
                            <li key={s.id}>
                                <div className="saved-info">
                                    <span className="saved-name">{s.name}</span>
                                    <span className="saved-meta">
                                        {s.dialect}
                                        {s.dialect !== 'demo' && s.dialect !== 'sqlite' && s.host && ` · ${s.host}:${s.port}`}
                                        {s.database && ` · ${s.database}`}
                                        {s.file && ` · ${s.file}`}
                                        {s.ssh && ` · via ${s.ssh.user}@${s.ssh.host}:${s.ssh.port}`}
                                    </span>
                                </div>
                                <div className="saved-actions">
                                    <button disabled={busy || pending} onClick={() => connectSaved(s.id)}>Connect</button>
                                    <button className="btn-link" onClick={() => loadSaved(s.id)}>Edit</button>
                                    <button className="btn-link danger" onClick={() => deleteSaved(s.id, s.name)}>Delete</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <form className="card" onSubmit={submit}>
                <div className="card-header">
                    <h2>{editingId ? 'Edit saved connection' : 'Connect to database'}</h2>
                    {editingId && (
                        <button type="button" className="btn-link" onClick={resetForm}>
                            Cancel
                        </button>
                    )}
                </div>
                <label>
                    Dialect
                    <select value={dialect} onChange={(e) => handleDialectChange(e.target.value as Dialect)}>
                        <option value="demo">Demo (built-in sample schema)</option>
                        <option value="postgres">PostgreSQL</option>
                        <option value="mysql">MySQL / MariaDB</option>
                        <option value="sqlite">SQLite</option>
                        <option value="mssql">MS SQL Server</option>
                    </select>
                </label>

                {dialect === 'sqlite' && (
                    <label>
                        Database file path
                        <input value={file} onChange={(e) => setFile(e.target.value)} placeholder="/path/to/db.sqlite" required />
                    </label>
                )}

                {(dialect === 'postgres' || dialect === 'mysql' || dialect === 'mssql') && (
                    <>
                        <div className="row">
                            <label className="grow">
                                Host
                                <input value={host} onChange={(e) => setHost(e.target.value)} required />
                            </label>
                            <label>
                                Port
                                <input value={port} onChange={(e) => setPort(e.target.value)} required />
                            </label>
                        </div>
                        <label>
                            Database
                            <input value={database} onChange={(e) => setDatabase(e.target.value)} required />
                        </label>
                        <div className="row">
                            <label className="grow">
                                User
                                <input value={user} onChange={(e) => setUser(e.target.value)} />
                            </label>
                            <label className="grow">
                                Password
                                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                            </label>
                        </div>
                        <label className="checkbox">
                            <input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} />
                            Use SSL
                        </label>
                        <label className="checkbox">
                            <input
                                type="checkbox"
                                checked={useSsh}
                                onChange={(e) => setUseSsh(e.target.checked)}
                            />
                            Tunnel through SSH
                        </label>
                        {useSsh && (
                            <fieldset className="ssh-block">
                                <legend>SSH</legend>
                                <div className="row">
                                    <label className="grow">
                                        SSH host
                                        <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} required />
                                    </label>
                                    <label>
                                        Port
                                        <input value={sshPort} onChange={(e) => setSshPort(e.target.value)} required />
                                    </label>
                                </div>
                                <div className="row">
                                    <label className="grow">
                                        SSH user
                                        <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} required />
                                    </label>
                                    <label className="grow">
                                        SSH password
                                        <input
                                            type="password"
                                            value={sshPassword}
                                            onChange={(e) => setSshPassword(e.target.value)}
                                        />
                                    </label>
                                </div>
                                <div className="hint">
                                    DB host/port above target the destination as seen from the SSH bastion.
                                </div>
                            </fieldset>
                        )}
                    </>
                )}

                {dialect !== 'demo' && (
                    <label>
                        Save as <span className="muted">(optional — encrypted via OS keychain)</span>
                        <input
                            value={saveAs}
                            onChange={(e) => setSaveAs(e.target.value)}
                            placeholder="e.g. Production read-replica"
                        />
                    </label>
                )}

                {error && <div className="error">{error}</div>}
                <button type="submit" disabled={busy || pending}>
                    {pending ? 'Connecting…' : 'Connect'}
                </button>
            </form>
        </div>
    );
}
