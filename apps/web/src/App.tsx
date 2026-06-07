import { useState, useRef, useCallback, useEffect } from 'react';
import type { CreateRunRequest, StreamEvent } from '@shopify-support/shared';

const API = '/api';

type Tab = 'run' | 'config' | 'runs' | 'memory';

// ── API helpers ──────────────────────────────────────────────────────

async function apiFetch<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, opts);
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<T>;
}

// ── Shared types ─────────────────────────────────────────────────────

type AppSummary = { appKey: string; name: string; createdAt?: string };

type RunRow = {
    runId: string;
    app: string;
    mode: string;
    status: string;
    reportedBy: string;
    issueText: string;
    createdAt: string;
    output?: { rootCause?: string; confidence?: string; caseType?: string };
};

type TestResult = { surface: string; key: string; ok: boolean; message: string };

// ── Config form state ────────────────────────────────────────────────

type RepoEntry = { name: string; url: string; gitlabProjectId: string; branch: string };
type DbEntry = { key: string; type: string; connectionString: string; mgmtUrl: string };
type GitLabRepoItem = { id: number; name: string; http_url_to_repo: string; web_url: string; default_branch: string };
type MemoryRow = { id: string; app: string; caseType: string; insight: string; confidence: string; pattern?: string | null; sourceRunId: string; createdAt: string };

type ConfigForm = {
    name: string;
    selectedRepos: RepoEntry[];
    gitlabBaseUrl: string;
    gitlabToken: string;
    gitlabGroupId: string;
    dbSources: DbEntry[];
    appStoreUrl: string;
    docUrls: string;
    homepage: string;
    appDescription: string;
    expectedConfig: string;
};

const emptyConfig = (): ConfigForm => ({
    name: '',
    selectedRepos: [],
    gitlabBaseUrl: '',
    gitlabToken: '',
    gitlabGroupId: '',
    dbSources: [],
    appStoreUrl: '',
    docUrls: '',
    homepage: '',
    appDescription: '',
    expectedConfig: '{}',
});

// ── Style helpers ────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
    completed: '#166534',
    failed: '#991b1b',
    skipped: '#92400e',
    running: '#1d4ed8',
    awaiting_input: '#6d28d9',
    awaiting_approval: '#b45309',
    partial: '#065f46',
};

const STATUS_BG: Record<string, string> = {
    completed: '#dcfce7',
    failed: '#fee2e2',
    skipped: '#fef3c7',
    running: '#dbeafe',
    awaiting_input: '#ede9fe',
    awaiting_approval: '#fef3c7',
    partial: '#d1fae5',
};

const inp: React.CSSProperties = {
    padding: '5px 8px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: 12,
    background: '#fff',
};

const btn = (color = '#1d4ed8'): React.CSSProperties => ({
    padding: '5px 14px',
    background: color,
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'monospace',
    fontSize: 12,
});

const sectionStyle: React.CSSProperties = {
    marginBottom: 20,
    padding: '12px 16px',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    background: '#fafafa',
};

function Label({ text }: { text: string }) {
    return <div style={{ color: '#374151', fontWeight: 600, fontSize: 11, marginBottom: 4 }}>{text}</div>;
}

function StatusBadge({ status }: { status: string }) {
    return (
        <span style={{
            background: STATUS_BG[status] ?? '#f3f4f6',
            color: STATUS_COLOR[status] ?? '#374151',
            padding: '1px 7px',
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 600,
        }}>
            {status}
        </span>
    );
}

// ── Root ─────────────────────────────────────────────────────────────

export function App() {
    const [tab, setTab] = useState<Tab>('run');

    return (
        <div style={{ fontFamily: 'monospace', maxWidth: 980, margin: '24px auto', padding: '0 20px', fontSize: 13 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
                <h1 style={{ fontSize: 17, margin: 0 }}>Shopify Support Agent</h1>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>M2</span>
            </div>
            <nav style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1px solid #e5e7eb' }}>
                {(['run', 'config', 'runs', 'memory'] as Tab[]).map((t) => (
                    <button key={t} onClick={() => setTab(t)} style={{
                        padding: '7px 16px', border: 'none', background: 'none', cursor: 'pointer',
                        borderBottom: tab === t ? '2px solid #1d4ed8' : '2px solid transparent',
                        color: tab === t ? '#1d4ed8' : '#6b7280',
                        fontFamily: 'monospace', fontSize: 13,
                    }}>
                        {t === 'run' ? 'Run Console' : t === 'config' ? 'App Config' : t === 'runs' ? 'Runs' : 'Memory'}
                    </button>
                ))}
            </nav>
            {tab === 'run' && <RunTab />}
            {tab === 'config' && <AppConfigTab />}
            {tab === 'runs' && <RunsTab />}
            {tab === 'memory' && <MemoryTab />}
        </div>
    );
}

// ── Run Console tab ──────────────────────────────────────────────────

function RunTab() {
    const [apps, setApps] = useState<AppSummary[]>([]);
    const [app, setApp] = useState('');
    const [issueText, setIssueText] = useState('');
    const [storeDomain, setStoreDomain] = useState('');
    const [storeUrl, setStoreUrl] = useState('');
    const [reportedBy, setReportedBy] = useState('cse@example.com');
    const [mode, setMode] = useState<'diagnose' | 'fix'>('diagnose');
    const [severity, setSeverity] = useState('');
    const [interactive, setInteractive] = useState(false);
    const [loading, setLoading] = useState(false);
    const [runId, setRunId] = useState<string | null>(null);
    const [events, setEvents] = useState<StreamEvent[]>([]);
    const [interrupt, setInterrupt] = useState<{ question: string } | null>(null);
    const [contextAnswer, setContextAnswer] = useState('');
    const esRef = useRef<EventSource | null>(null);

    useEffect(() => {
        apiFetch<{ apps: AppSummary[] }>('/apps').then((d) => setApps(d.apps)).catch(() => {});
    }, []);

    const addEvent = useCallback((ev: StreamEvent) => {
        setEvents((prev) => [...prev, ev]);
    }, []);

    const openStream = useCallback((id: string) => {
        esRef.current?.close();
        const es = new EventSource(`${API}/runs/${id}/stream`);
        esRef.current = es;
        es.onmessage = (e) => {
            if (e.data === '[DONE]') { es.close(); return; }
            try {
                const ev: StreamEvent = JSON.parse(e.data);
                addEvent(ev);
                if (ev.type === 'output') { es.close(); setLoading(false); }
                if (ev.type === 'interrupt') {
                    es.close(); setLoading(false);
                    setInterrupt({ question: ev.question });
                }
                if (ev.type === 'error') { es.close(); setLoading(false); }
            } catch {}
        };
        es.onerror = () => { es.close(); setLoading(false); };
    }, [addEvent]);

    const submit = async () => {
        if (!issueText.trim() || !app.trim()) return;
        setLoading(true); setEvents([]); setInterrupt(null);
        try {
            const body: CreateRunRequest = {
                app,
                issueText,
                reportedBy,
                mode,
                ...(storeDomain ? { storeDomain } : {}),
                ...(storeUrl ? { storeUrl } : {}),
                ...(severity ? { severity: severity as 'low' | 'normal' | 'high' | 'urgent' } : {}),
                interactive,
            };
            const { runId: id } = await apiFetch<{ runId: string }>('/runs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            setRunId(id);
            openStream(id);
        } catch (err) {
            setLoading(false);
            addEvent({ type: 'error', message: String(err), ts: new Date().toISOString() });
        }
    };

    const submitContext = async () => {
        if (!runId || !contextAnswer.trim()) return;
        setLoading(true); setInterrupt(null);
        try {
            await fetch(`${API}/runs/${runId}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'context', value: { answer: contextAnswer } }),
            });
            setContextAnswer('');
            openStream(runId);
        } catch (err) {
            setLoading(false);
            addEvent({ type: 'error', message: String(err), ts: new Date().toISOString() });
        }
    };

    const output = events.find((e) => e.type === 'output' && 'output' in e);

    return (
        <div>
            {/* Form */}
            <div style={sectionStyle}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div>
                        <Label text="App" />
                        {apps.length > 0 ? (
                            <select value={app} onChange={(e) => setApp(e.target.value)} style={{ ...inp, width: '100%' }}>
                                <option value="">— select app —</option>
                                {apps.map((a) => <option key={a.appKey} value={a.appKey}>{a.name} ({a.appKey})</option>)}
                            </select>
                        ) : (
                            <input value={app} onChange={(e) => setApp(e.target.value)} placeholder="app key / name" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                        )}
                    </div>
                    <div>
                        <Label text="Reported by" />
                        <input value={reportedBy} onChange={(e) => setReportedBy(e.target.value)} style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                        <Label text="Store domain (optional)" />
                        <input value={storeDomain} onChange={(e) => setStoreDomain(e.target.value)} placeholder="my-store.myshopify.com" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                        <Label text="Store URL (optional)" />
                        <input value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} placeholder="https://my-store.myshopify.com" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                </div>
                <div style={{ marginBottom: 10 }}>
                    <Label text="Issue description" />
                    <textarea value={issueText} onChange={(e) => setIssueText(e.target.value)} rows={3}
                        placeholder="Describe the merchant issue in detail..."
                        style={{ ...inp, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select value={mode} onChange={(e) => setMode(e.target.value as 'diagnose' | 'fix')} style={inp}>
                        <option value="diagnose">diagnose</option>
                        <option value="fix">fix</option>
                    </select>
                    <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={inp}>
                        <option value="">severity (optional)</option>
                        <option value="low">low</option>
                        <option value="normal">normal</option>
                        <option value="high">high</option>
                        <option value="urgent">urgent</option>
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#374151', cursor: 'pointer' }}>
                        <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)} />
                        interactive (ask for missing context)
                    </label>
                    <button onClick={submit} disabled={loading || !issueText.trim() || !app.trim()} style={{
                        ...btn(loading ? '#9ca3af' : '#1d4ed8'), cursor: loading ? 'not-allowed' : 'pointer',
                    }}>
                        {loading ? 'Running...' : 'Start Investigation'}
                    </button>
                </div>
                {runId && <p style={{ margin: '8px 0 0', color: '#9ca3af', fontSize: 11 }}>Run: <code>{runId}</code></p>}
            </div>

            {/* Interrupt panel */}
            {interrupt && (
                <div style={{ marginBottom: 16, padding: 14, background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 6 }}>
                    <strong style={{ color: '#92400e' }}>Agent needs more info:</strong>
                    <p style={{ margin: '6px 0', color: '#78350f' }}>{interrupt.question}</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <input value={contextAnswer} onChange={(e) => setContextAnswer(e.target.value)}
                            placeholder="Your answer..." onKeyDown={(e) => e.key === 'Enter' && submitContext()}
                            style={{ ...inp, flex: 1 }} />
                        <button onClick={submitContext} disabled={!contextAnswer.trim()} style={btn('#d97706')}>Send</button>
                    </div>
                </div>
            )}

            {/* Timeline */}
            {events.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: '#374151', fontWeight: 600, marginBottom: 6 }}>Timeline</div>
                    <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 14px', maxHeight: 280, overflowY: 'auto' }}>
                        {events.map((ev, i) => (
                            <div key={i} style={{ marginBottom: 4, paddingBottom: 4, borderBottom: i < events.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                                {ev.type === 'step' && (
                                    <span>
                                        <span style={{ color: '#9ca3af', fontSize: 11 }}>{ev.ts?.slice(11, 19)} </span>
                                        <span style={{ color: STATUS_COLOR[ev.status] ?? '#374151', fontWeight: 600 }}>[{ev.node}]</span>
                                        {' '}<span style={{ color: STATUS_COLOR[ev.status] ?? '#374151' }}>{ev.status}</span>
                                        {ev.summary && <span style={{ color: '#6b7280' }}> — {ev.summary}</span>}
                                    </span>
                                )}
                                {ev.type === 'error' && <span style={{ color: '#dc2626' }}>✗ {ev.message}</span>}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Output */}
            {output && output.type === 'output' && (
                <div style={{ padding: 16, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6 }}>
                    <strong style={{ color: '#166534', fontSize: 14 }}>Investigation Complete</strong>
                    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
                        {[
                            ['Case Type', output.output.caseType ?? '—'],
                            ['Confidence', output.output.confidence ?? '—'],
                            ['Status', output.output.status],
                            ['Mode', output.output.mode],
                        ].map(([label, value]) => (
                            <div key={label}>
                                <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>{label}</div>
                                <div style={{ fontWeight: 600 }}>{value}</div>
                            </div>
                        ))}
                    </div>
                    {output.output.rootCause && (
                        <div style={{ marginTop: 12 }}>
                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Root Cause</div>
                            <div style={{ lineHeight: 1.5 }}>{output.output.rootCause}</div>
                        </div>
                    )}
                    {output.output.recommendedFix && (
                        <div style={{ marginTop: 12 }}>
                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Recommended Fix</div>
                            <div style={{ lineHeight: 1.5 }}>{output.output.recommendedFix}</div>
                        </div>
                    )}
                    {(output.output.nextSteps?.length ?? 0) > 0 && (
                        <div style={{ marginTop: 12 }}>
                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Next Steps</div>
                            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                                {output.output.nextSteps!.map((s, i) => <li key={i}>{s}</li>)}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── App Config tab ───────────────────────────────────────────────────

function AppConfigTab() {
    const [apps, setApps] = useState<AppSummary[]>([]);
    const [selectedKey, setSelectedKey] = useState<string>('');
    const [creating, setCreating] = useState(false);
    const [newAppKey, setNewAppKey] = useState('');
    const [form, setForm] = useState<ConfigForm>(emptyConfig());
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResults, setTestResults] = useState<TestResult[] | null>(null);
    const [saveMsg, setSaveMsg] = useState<string | null>(null);
    const [fetchedRepos, setFetchedRepos] = useState<GitLabRepoItem[]>([]);
    const [fetchingRepos, setFetchingRepos] = useState(false);
    const [repoFetchError, setRepoFetchError] = useState<string | null>(null);
    const [learning, setLearning] = useState(false);
    const [learnMsg, setLearnMsg] = useState<string | null>(null);

    const loadApps = useCallback(() => {
        apiFetch<{ apps: AppSummary[] }>('/apps').then((d) => setApps(d.apps)).catch(() => {});
    }, []);

    useEffect(() => { loadApps(); }, [loadApps]);

    useEffect(() => {
        if (!selectedKey || creating) return;
        apiFetch<{ appKey: string; name: string; config: Record<string, unknown> }>(`/apps/${selectedKey}/config`)
            .then((d) => {
                const c = d.config;
                const gl = (c['gitlab'] as Record<string, string> | undefined) ?? {};
                setForm({
                    name: d.name,
                    selectedRepos: ((c['repos'] as Array<Record<string, string>>) ?? []).map((r) => ({
                        name: r['name'] ?? '', url: r['url'] ?? '', gitlabProjectId: r['gitlabProjectId'] ?? '', branch: r['branch'] ?? 'main',
                    })),
                    gitlabBaseUrl: gl['baseUrl'] ?? '',
                    gitlabToken: '',
                    gitlabGroupId: gl['groupId'] ?? '',
                    dbSources: ((c['dbSources'] as Array<Record<string, string>>) ?? []).map((s) => ({
                        key: s['key'] ?? '', type: s['type'] ?? 'sql', connectionString: '', mgmtUrl: '',
                    })),
                    appStoreUrl: (c['appStoreUrl'] as string | undefined) ?? '',
                    docUrls: ((c['docUrls'] as string[] | undefined) ?? []).join('\n'),
                    homepage: (c['homepage'] as string | undefined) ?? '',
                    appDescription: (c['appDescription'] as string | undefined) ?? '',
                    expectedConfig: JSON.stringify(c['expectedConfig'] ?? {}, null, 2),
                });
                setFetchedRepos([]);
                setRepoFetchError(null);
                setLearnMsg(null);
            }).catch(() => {});
    }, [selectedKey, creating]);

    const buildBody = () => {
        let expectedConfigParsed: unknown = {};
        try { expectedConfigParsed = JSON.parse(form.expectedConfig || '{}'); } catch {}
        return {
            name: form.name,
            ...(form.selectedRepos.length > 0 ? {
                repos: form.selectedRepos.map((r) => ({ name: r.name, url: r.url, ...(r.gitlabProjectId ? { gitlabProjectId: r.gitlabProjectId } : {}), branch: r.branch || 'main' })),
            } : {}),
            ...(form.gitlabBaseUrl ? {
                gitlab: {
                    baseUrl: form.gitlabBaseUrl,
                    ...(form.gitlabToken ? { token: form.gitlabToken } : {}),
                    ...(form.gitlabGroupId ? { groupId: form.gitlabGroupId } : {}),
                },
            } : {}),
            ...(form.dbSources.length > 0 ? {
                dbSources: form.dbSources.map((s) => ({ key: s.key, type: s.type, connectionString: s.connectionString, ...(s.mgmtUrl ? { mgmtUrl: s.mgmtUrl } : {}) })),
            } : {}),
            ...(form.appStoreUrl ? { appStoreUrl: form.appStoreUrl } : {}),
            ...(form.docUrls.trim() ? { docUrls: form.docUrls.split('\n').map((s) => s.trim()).filter(Boolean) } : {}),
            ...(form.homepage ? { homepage: form.homepage } : {}),
            ...(form.appDescription ? { appDescription: form.appDescription } : {}),
            expectedConfig: expectedConfigParsed,
        };
    };

    const save = async () => {
        if (!form.name.trim()) return;
        setSaving(true); setSaveMsg(null);
        try {
            const body = buildBody();
            if (creating) {
                if (!newAppKey.trim()) { setSaveMsg('appKey required'); setSaving(false); return; }
                await apiFetch('/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appKey: newAppKey, ...body }) });
                setSelectedKey(newAppKey);
                setCreating(false);
                setNewAppKey('');
            } else {
                await apiFetch(`/apps/${selectedKey}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            }
            setSaveMsg('Saved');
            loadApps();
        } catch (err) {
            setSaveMsg(`Error: ${String(err)}`);
        }
        setSaving(false);
    };

    const testConnections = async () => {
        if (!selectedKey) return;
        setTesting(true); setTestResults(null);
        try {
            const d = await apiFetch<{ results: TestResult[] }>(`/apps/${selectedKey}/config/test`, { method: 'POST' });
            setTestResults(d.results);
        } catch (err) {
            setTestResults([{ surface: 'error', key: 'error', ok: false, message: String(err) }]);
        }
        setTesting(false);
    };

    const fetchRepos = async () => {
        if (!form.gitlabBaseUrl || !form.gitlabToken || !form.gitlabGroupId) {
            setRepoFetchError('Base URL, token, and group ID are required');
            return;
        }
        setFetchingRepos(true); setRepoFetchError(null);
        try {
            const params = new URLSearchParams({ baseUrl: form.gitlabBaseUrl, token: form.gitlabToken, groupId: form.gitlabGroupId });
            const d = await apiFetch<{ repos: GitLabRepoItem[] }>(`/gitlab/repos?${params}`);
            setFetchedRepos(d.repos);
        } catch (err) {
            setRepoFetchError(String(err));
        }
        setFetchingRepos(false);
    };

    const toggleRepo = (item: GitLabRepoItem) => {
        const id = String(item.id);
        const already = form.selectedRepos.some((r) => r.gitlabProjectId === id);
        if (already) {
            setFormField('selectedRepos', form.selectedRepos.filter((r) => r.gitlabProjectId !== id));
        } else {
            setFormField('selectedRepos', [...form.selectedRepos, {
                name: item.name,
                url: item.http_url_to_repo,
                gitlabProjectId: id,
                branch: item.default_branch || 'main',
            }]);
        }
    };

    const learnAppKnowledge = async () => {
        if (!selectedKey) return;
        setLearning(true); setLearnMsg(null);
        try {
            const d = await apiFetch<{ newChunks: number; totalChunks: number }>(`/apps/${selectedKey}/learn`, { method: 'POST' });
            setLearnMsg(`Learned ${d.newChunks} new chunks (${d.totalChunks} total)`);
        } catch (err) {
            setLearnMsg(`Error: ${String(err)}`);
        }
        setLearning(false);
    };

    const setFormField = <K extends keyof ConfigForm>(key: K, val: ConfigForm[K]) =>
        setForm((f) => ({ ...f, [key]: val }));

    const updateArr = <T,>(field: keyof ConfigForm, idx: number, patch: Partial<T>) =>
        setForm((f) => {
            const arr = [...(f[field] as T[])];
            arr[idx] = { ...arr[idx], ...patch };
            return { ...f, [field]: arr };
        });

    return (
        <div>
            {/* App selector */}
            <div style={{ ...sectionStyle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <select value={creating ? '__new__' : selectedKey} onChange={(e) => {
                    if (e.target.value === '__new__') { setCreating(true); setSelectedKey(''); setForm(emptyConfig()); setFetchedRepos([]); }
                    else { setCreating(false); setSelectedKey(e.target.value); setForm(emptyConfig()); setFetchedRepos([]); }
                }} style={{ ...inp, minWidth: 200 }}>
                    <option value="">— select app —</option>
                    {apps.map((a) => <option key={a.appKey} value={a.appKey}>{a.name} ({a.appKey})</option>)}
                    <option value="__new__">+ Create new app</option>
                </select>
                {!creating && selectedKey && (
                    <button onClick={testConnections} disabled={testing} style={btn('#0891b2')}>
                        {testing ? 'Testing...' : 'Test Connections'}
                    </button>
                )}
            </div>

            {/* Test results */}
            {testResults && (
                <div style={{ ...sectionStyle, marginBottom: 16 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>Connection Test Results</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                            <tr style={{ background: '#f3f4f6' }}>
                                {['Surface', 'Key', 'Status', 'Message'].map((h) => (
                                    <th key={h} style={{ padding: '4px 8px', textAlign: 'left', border: '1px solid #e5e7eb', fontWeight: 600 }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {testResults.map((r, i) => (
                                <tr key={i} style={{ background: r.ok ? '#f0fdf4' : '#fef2f2' }}>
                                    <td style={{ padding: '4px 8px', border: '1px solid #e5e7eb' }}>{r.surface}</td>
                                    <td style={{ padding: '4px 8px', border: '1px solid #e5e7eb' }}>{r.key}</td>
                                    <td style={{ padding: '4px 8px', border: '1px solid #e5e7eb', color: r.ok ? '#166534' : '#991b1b', fontWeight: 600 }}>{r.ok ? 'OK' : 'FAIL'}</td>
                                    <td style={{ padding: '4px 8px', border: '1px solid #e5e7eb', color: '#374151' }}>{r.message}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {(selectedKey || creating) && (
                <div>
                    {/* Basic */}
                    <div style={sectionStyle}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 10, color: '#374151' }}>Basic</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                            {creating && (
                                <div>
                                    <Label text="App Key (slug, unique)" />
                                    <input value={newAppKey} onChange={(e) => setNewAppKey(e.target.value)} placeholder="my-shopify-app" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                                </div>
                            )}
                            <div>
                                <Label text="App Name" />
                                <input value={form.name} onChange={(e) => setFormField('name', e.target.value)} placeholder="My Shopify App" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                            </div>
                        </div>
                    </div>

                    {/* GitLab Repos */}
                    <div style={sectionStyle}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 10, color: '#374151' }}>GitLab Repos</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                            <div>
                                <Label text="Base URL" />
                                <input value={form.gitlabBaseUrl} onChange={(e) => setFormField('gitlabBaseUrl', e.target.value)} placeholder="https://gitlab.com" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                            </div>
                            <div>
                                <Label text="Token (write to update)" />
                                <input type="password" value={form.gitlabToken} onChange={(e) => setFormField('gitlabToken', e.target.value)} placeholder="glpat-..." style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
                            <div style={{ flex: 1 }}>
                                <Label text="Group ID" />
                                <input value={form.gitlabGroupId} onChange={(e) => setFormField('gitlabGroupId', e.target.value)} placeholder="12345678" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                            </div>
                            <button onClick={fetchRepos} disabled={fetchingRepos} style={{ ...btn('#4b5563'), whiteSpace: 'nowrap' }}>
                                {fetchingRepos ? 'Fetching...' : 'Fetch Repos'}
                            </button>
                        </div>
                        {repoFetchError && <div style={{ color: '#dc2626', fontSize: 11, marginBottom: 8 }}>{repoFetchError}</div>}
                        {fetchedRepos.length > 0 && (
                            <div>
                                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>Select repos to include:</div>
                                <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 4, padding: '4px 8px', background: '#fff' }}>
                                    {fetchedRepos.map((item) => {
                                        const checked = form.selectedRepos.some((r) => r.gitlabProjectId === String(item.id));
                                        return (
                                            <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', fontSize: 12 }}>
                                                <input type="checkbox" checked={checked} onChange={() => toggleRepo(item)} />
                                                <span style={{ fontWeight: checked ? 600 : 400 }}>{item.name}</span>
                                                <span style={{ color: '#9ca3af', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.http_url_to_repo}</span>
                                                <span style={{ color: '#d1d5db', fontSize: 10 }}>{item.default_branch}</span>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {form.selectedRepos.length > 0 && fetchedRepos.length === 0 && (
                            <div style={{ fontSize: 11, color: '#6b7280' }}>
                                {form.selectedRepos.length} repo(s) configured. Fetch repos above to modify selection.
                            </div>
                        )}
                    </div>

                    {/* DB Sources */}
                    <ArraySection
                        title="DB Sources"
                        items={form.dbSources}
                        onAdd={() => setFormField('dbSources', [...form.dbSources, { key: '', type: 'sql', connectionString: '', mgmtUrl: '' }])}
                        onRemove={(i) => setFormField('dbSources', form.dbSources.filter((_, j) => j !== i))}
                        renderItem={(s, i) => (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 3fr 2fr', gap: 6 }}>
                                <input value={s.key} onChange={(e) => updateArr<DbEntry>('dbSources', i, { key: e.target.value })} placeholder="key (e.g. main-db)" style={inp} />
                                <select value={s.type} onChange={(e) => updateArr<DbEntry>('dbSources', i, { type: e.target.value })} style={inp}>
                                    {['sql', 'mongo', 'redis', 'rabbitmq'].map((t) => <option key={t}>{t}</option>)}
                                </select>
                                <input type="password" value={s.connectionString} onChange={(e) => updateArr<DbEntry>('dbSources', i, { connectionString: e.target.value })} placeholder="connection string" style={inp} />
                                <input value={s.mgmtUrl} onChange={(e) => updateArr<DbEntry>('dbSources', i, { mgmtUrl: e.target.value })} placeholder="mgmtUrl (rabbitmq)" style={inp} />
                            </div>
                        )}
                    />

                    {/* App Knowledge */}
                    <div style={sectionStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                            <div style={{ fontWeight: 600, fontSize: 12, color: '#374151' }}>App Knowledge</div>
                            {!creating && selectedKey && (
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <button onClick={learnAppKnowledge} disabled={learning} style={{ ...btn('#7c3aed'), padding: '3px 10px', fontSize: 11 }}>
                                        {learning ? 'Learning...' : 'Learn Now'}
                                    </button>
                                    {learnMsg && <span style={{ fontSize: 11, color: learnMsg.startsWith('Error') ? '#dc2626' : '#166534' }}>{learnMsg}</span>}
                                </div>
                            )}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                            <div>
                                <Label text="App Store URL" />
                                <input value={form.appStoreUrl} onChange={(e) => setFormField('appStoreUrl', e.target.value)} placeholder="https://apps.shopify.com/..." style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                            </div>
                            <div>
                                <Label text="Homepage" />
                                <input value={form.homepage} onChange={(e) => setFormField('homepage', e.target.value)} placeholder="https://example.com" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
                            </div>
                        </div>
                        <div style={{ marginBottom: 10 }}>
                            <Label text="App Description" />
                            <textarea value={form.appDescription} onChange={(e) => setFormField('appDescription', e.target.value)}
                                rows={2} placeholder="Brief description of what this app does..."
                                style={{ ...inp, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
                        </div>
                        <div>
                            <Label text="Documentation URLs (one per line)" />
                            <textarea value={form.docUrls} onChange={(e) => setFormField('docUrls', e.target.value)}
                                rows={3} placeholder={"https://docs.example.com/getting-started\nhttps://docs.example.com/api"}
                                style={{ ...inp, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
                        </div>
                    </div>

                    {/* Expected Config */}
                    <div style={sectionStyle}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: '#374151' }}>Expected Config (JSON)</div>
                        <textarea value={form.expectedConfig} onChange={(e) => setFormField('expectedConfig', e.target.value)}
                            rows={4} style={{ ...inp, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
                    </div>

                    {/* Save */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button onClick={save} disabled={saving || !form.name.trim()} style={btn(saving ? '#9ca3af' : '#166534')}>
                            {saving ? 'Saving...' : 'Save Config'}
                        </button>
                        {saveMsg && (
                            <span style={{ fontSize: 12, color: saveMsg.startsWith('Error') ? '#dc2626' : '#166534' }}>{saveMsg}</span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── ArraySection helper ──────────────────────────────────────────────

function ArraySection<T>({
    title, items, onAdd, onRemove, renderItem,
}: {
    title: string;
    items: T[];
    onAdd: () => void;
    onRemove: (i: number) => void;
    renderItem: (item: T, i: number) => React.ReactNode;
}) {
    return (
        <div style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: '#374151' }}>{title}</div>
                <button onClick={onAdd} style={{ ...btn('#374151'), padding: '3px 10px', fontSize: 11 }}>+ Add</button>
            </div>
            {items.length === 0 && <div style={{ color: '#9ca3af', fontSize: 11 }}>None configured</div>}
            {items.map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ flex: 1 }}>{renderItem(item, i)}</div>
                    <button onClick={() => onRemove(i)} style={{ ...btn('#dc2626'), padding: '3px 8px', fontSize: 11 }}>✕</button>
                </div>
            ))}
        </div>
    );
}

// ── Runs tab ─────────────────────────────────────────────────────────

function RunsTab() {
    const [runs, setRuns] = useState<RunRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [filterApp, setFilterApp] = useState('');
    const [filterStatus, setFilterStatus] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);
    const [offset, setOffset] = useState(0);
    const limit = 20;

    const load = useCallback(() => {
        setLoading(true);
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (filterApp) params.set('app', filterApp);
        if (filterStatus) params.set('status', filterStatus);
        apiFetch<{ runs: RunRow[] }>(`/runs?${params}`)
            .then((d) => setRuns(d.runs))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [filterApp, filterStatus, offset]);

    useEffect(() => { load(); }, [load]);

    return (
        <div>
            {/* Filters */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={filterApp} onChange={(e) => { setFilterApp(e.target.value); setOffset(0); }}
                    placeholder="filter by app" style={{ ...inp, width: 160 }} />
                <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setOffset(0); }} style={inp}>
                    <option value="">all statuses</option>
                    {['running', 'completed', 'failed', 'awaiting_input', 'awaiting_approval', 'partial'].map((s) => (
                        <option key={s} value={s}>{s}</option>
                    ))}
                </select>
                <button onClick={load} style={btn('#374151')}>Refresh</button>
                {loading && <span style={{ color: '#9ca3af', fontSize: 11 }}>loading...</span>}
            </div>

            {runs.length === 0 && !loading && (
                <div style={{ color: '#9ca3af', fontSize: 12, padding: '20px 0' }}>No runs found.</div>
            )}

            {runs.map((run) => (
                <div key={run.runId} style={{ border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 8, overflow: 'hidden' }}>
                    <div
                        onClick={() => setExpanded(expanded === run.runId ? null : run.runId)}
                        style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 14px', cursor: 'pointer', background: '#fafafa' }}
                    >
                        <StatusBadge status={run.status} />
                        <span style={{ fontWeight: 600 }}>{run.app}</span>
                        <span style={{ color: '#6b7280', fontSize: 11 }}>{run.mode}</span>
                        <span style={{ color: '#6b7280', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {run.issueText?.slice(0, 80)}
                        </span>
                        <span style={{ color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' }}>
                            {run.createdAt?.slice(0, 16).replace('T', ' ')}
                        </span>
                        <span style={{ color: '#9ca3af', fontSize: 10 }}>{expanded === run.runId ? '▲' : '▼'}</span>
                    </div>
                    {expanded === run.runId && (
                        <div style={{ padding: '10px 14px', borderTop: '1px solid #f3f4f6', background: '#fff', fontSize: 12 }}>
                            <div style={{ color: '#6b7280', marginBottom: 6 }}>
                                <strong>Run ID:</strong> <code>{run.runId}</code> · <strong>Reported by:</strong> {run.reportedBy}
                            </div>
                            {run.output && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 8 }}>
                                    {run.output.caseType && <MiniField label="Case Type" value={run.output.caseType} />}
                                    {run.output.confidence && <MiniField label="Confidence" value={run.output.confidence} />}
                                    {run.output.rootCause && (
                                        <div style={{ gridColumn: '1 / -1' }}>
                                            <div style={{ color: '#6b7280', fontSize: 11 }}>Root Cause</div>
                                            <div>{run.output.rootCause}</div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ))}

            {/* Pagination */}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} style={btn('#374151')}>← Prev</button>
                <button onClick={() => setOffset(offset + limit)} disabled={runs.length < limit} style={btn('#374151')}>Next →</button>
                <span style={{ color: '#9ca3af', fontSize: 11, alignSelf: 'center' }}>offset {offset}</span>
            </div>
        </div>
    );
}

function MiniField({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div style={{ color: '#9ca3af', fontSize: 10 }}>{label}</div>
            <div style={{ fontWeight: 600 }}>{value}</div>
        </div>
    );
}

// ── Memory tab ────────────────────────────────────────────────────────

function MemoryTab() {
    const [memories, setMemories] = useState<MemoryRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [filterApp, setFilterApp] = useState('');
    const [filterType, setFilterType] = useState('');
    const [filterQ, setFilterQ] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);

    const load = useCallback(() => {
        setLoading(true);
        const params = new URLSearchParams({ limit: '20' });
        if (filterApp) params.set('app', filterApp);
        if (filterType) params.set('caseType', filterType);
        if (filterQ) params.set('q', filterQ);
        apiFetch<{ memories: MemoryRow[] }>(`/memory?${params}`)
            .then((d) => setMemories(d.memories))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [filterApp, filterType, filterQ]);

    useEffect(() => { load(); }, [load]);

    const del = async (id: string) => {
        await apiFetch(`/memory/${id}`, { method: 'DELETE' }).catch(() => {});
        setMemories((prev) => prev.filter((m) => m.id !== id));
    };

    const CASE_TYPES = ['config_drift', 'auth_scope_missing', 'webhook_missing', 'theme_extension_missing', 'embedded_ui_broken', 'api_error', 'billing_issue', 'other'];

    return (
        <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={filterApp} onChange={(e) => { setFilterApp(e.target.value); }}
                    placeholder="filter by app" style={{ ...inp, width: 140 }} />
                <select value={filterType} onChange={(e) => { setFilterType(e.target.value); }} style={inp}>
                    <option value="">all types</option>
                    {CASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input value={filterQ} onChange={(e) => { setFilterQ(e.target.value); }}
                    placeholder="search insight..." style={{ ...inp, width: 200 }} />
                <button onClick={load} style={btn('#374151')}>Refresh</button>
                {loading && <span style={{ color: '#9ca3af', fontSize: 11 }}>loading...</span>}
            </div>

            {memories.length === 0 && !loading && (
                <div style={{ color: '#9ca3af', fontSize: 12, padding: '20px 0' }}>
                    No memories found. Complete some investigations to build up case memory.
                </div>
            )}

            {memories.map((m) => (
                <div key={m.id} style={{ border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 8, overflow: 'hidden' }}>
                    <div
                        onClick={() => setExpanded(expanded === m.id ? null : m.id)}
                        style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 14px', cursor: 'pointer', background: '#fafafa' }}
                    >
                        <StatusBadge status={m.caseType} />
                        <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{m.app}</span>
                        <span style={{ color: '#6b7280', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                            {m.insight?.slice(0, 100)}
                        </span>
                        <span style={{ color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' }}>{m.confidence}</span>
                        <span style={{ color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' }}>{m.createdAt?.slice(0, 10)}</span>
                        <button
                            onClick={(e) => { e.stopPropagation(); del(m.id); }}
                            style={{ ...btn('#dc2626'), padding: '2px 8px', fontSize: 10 }}
                        >✕</button>
                        <span style={{ color: '#9ca3af', fontSize: 10 }}>{expanded === m.id ? '▲' : '▼'}</span>
                    </div>
                    {expanded === m.id && (
                        <div style={{ padding: '10px 14px', borderTop: '1px solid #f3f4f6', background: '#fff', fontSize: 12 }}>
                            <div style={{ marginBottom: 6, color: '#6b7280' }}>
                                <strong>Run:</strong> <code>{m.sourceRunId}</code>
                            </div>
                            <div style={{ marginBottom: 8 }}>
                                <strong>Insight:</strong>
                                <div style={{ marginTop: 4, lineHeight: 1.5 }}>{m.insight}</div>
                            </div>
                            {m.pattern && (
                                <div>
                                    <strong>Pattern:</strong>
                                    <div style={{ marginTop: 4, color: '#4b5563' }}>{m.pattern}</div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
