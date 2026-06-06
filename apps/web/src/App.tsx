import { useState, useRef, useCallback } from 'react';
import type { CreateRunRequest, StreamEvent } from '@shopify-support/shared';

const API = '/api';

async function createRun(body: CreateRunRequest): Promise<{ runId: string; threadId: string }> {
    const res = await fetch(`${API}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

async function resumeRun(runId: string, value: unknown) {
    const res = await fetch(`${API}/runs/${runId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'context', value }),
    });
    if (!res.ok) throw new Error(await res.text());
}

const STATUS_COLOR: Record<string, string> = {
    completed: '#166534',
    failed: '#991b1b',
    skipped: '#92400e',
    running: '#1d4ed8',
};

export function App() {
    const [issueText, setIssueText] = useState('');
    const [app, setApp] = useState('');
    const [mode, setMode] = useState<'diagnose' | 'fix'>('diagnose');
    const [loading, setLoading] = useState(false);
    const [runId, setRunId] = useState<string | null>(null);
    const [events, setEvents] = useState<StreamEvent[]>([]);
    const [interrupt, setInterrupt] = useState<{ question: string; value: unknown } | null>(null);
    const [contextAnswer, setContextAnswer] = useState('');
    const esRef = useRef<EventSource | null>(null);

    const addEvent = useCallback((ev: StreamEvent) => {
        setEvents((prev) => [...prev, ev]);
    }, []);

    const openStream = useCallback(
        (id: string) => {
            esRef.current?.close();
            const es = new EventSource(`${API}/runs/${id}/stream`);
            esRef.current = es;
            es.onmessage = (e) => {
                if (e.data === '[DONE]') {
                    es.close();
                    return;
                }
                try {
                    const ev: StreamEvent = JSON.parse(e.data);
                    addEvent(ev);
                    if (ev.type === 'output') {
                        es.close();
                        setLoading(false);
                    }
                    if (ev.type === 'interrupt') {
                        es.close();
                        setLoading(false);
                        setInterrupt({ question: ev.question, value: ev.value });
                    }
                    if (ev.type === 'error') {
                        es.close();
                        setLoading(false);
                    }
                } catch {}
            };
            es.onerror = () => {
                es.close();
                setLoading(false);
            };
        },
        [addEvent],
    );

    const submit = async () => {
        if (!issueText.trim() || !app.trim()) return;
        setLoading(true);
        setEvents([]);
        setInterrupt(null);
        try {
            const { runId: id } = await createRun({
                app,
                issueText,
                reportedBy: 'cse@example.com',
                mode,
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
        setLoading(true);
        setInterrupt(null);
        try {
            await resumeRun(runId, { answer: contextAnswer });
            setContextAnswer('');
            openStream(runId);
        } catch (err) {
            setLoading(false);
            addEvent({ type: 'error', message: String(err), ts: new Date().toISOString() });
        }
    };

    const output = events.find((e) => e.type === 'output' && 'output' in e);

    return (
        <div
            style={{
                fontFamily: 'monospace',
                maxWidth: 960,
                margin: '32px auto',
                padding: '0 20px',
                fontSize: 13,
            }}
        >
            <h1
                style={{
                    fontSize: 18,
                    marginBottom: 20,
                    borderBottom: '1px solid #e5e7eb',
                    paddingBottom: 12,
                }}
            >
                Shopify Support Agent
            </h1>

            {/* Input form */}
            <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                    placeholder="App name (e.g. my-shopify-app)"
                    value={app}
                    onChange={(e) => setApp(e.target.value)}
                    style={{
                        flex: '0 0 220px',
                        padding: '6px 10px',
                        border: '1px solid #d1d5db',
                        borderRadius: 4,
                    }}
                />
                <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'diagnose' | 'fix')}
                    style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 4 }}
                >
                    <option value="diagnose">diagnose</option>
                    <option value="fix">fix</option>
                </select>
            </div>
            <div style={{ marginBottom: 12 }}>
                <textarea
                    placeholder="Describe the merchant issue in detail..."
                    value={issueText}
                    onChange={(e) => setIssueText(e.target.value)}
                    rows={3}
                    style={{
                        width: '100%',
                        padding: '8px 10px',
                        border: '1px solid #d1d5db',
                        borderRadius: 4,
                        boxSizing: 'border-box',
                        resize: 'vertical',
                    }}
                />
            </div>
            <button
                onClick={submit}
                disabled={loading || !issueText.trim() || !app.trim()}
                style={{
                    padding: '7px 20px',
                    background: loading ? '#9ca3af' : '#1d4ed8',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    cursor: loading ? 'not-allowed' : 'pointer',
                }}
            >
                {loading ? 'Running...' : 'Start Investigation'}
            </button>

            {runId && (
                <p style={{ marginTop: 8, color: '#6b7280', fontSize: 11 }}>
                    Run: <code>{runId}</code>
                </p>
            )}

            {/* Interrupt / context ask */}
            {interrupt && (
                <div
                    style={{
                        marginTop: 20,
                        padding: 16,
                        background: '#fffbeb',
                        border: '1px solid #f59e0b',
                        borderRadius: 6,
                    }}
                >
                    <strong style={{ color: '#92400e' }}>Agent needs more info:</strong>
                    <p style={{ margin: '8px 0', color: '#78350f' }}>{interrupt.question}</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <input
                            value={contextAnswer}
                            onChange={(e) => setContextAnswer(e.target.value)}
                            placeholder="Your answer..."
                            style={{
                                flex: 1,
                                padding: '6px 10px',
                                border: '1px solid #f59e0b',
                                borderRadius: 4,
                            }}
                            onKeyDown={(e) => e.key === 'Enter' && submitContext()}
                        />
                        <button
                            onClick={submitContext}
                            disabled={!contextAnswer.trim()}
                            style={{
                                padding: '6px 16px',
                                background: '#d97706',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 4,
                                cursor: 'pointer',
                            }}
                        >
                            Send
                        </button>
                    </div>
                </div>
            )}

            {/* Timeline */}
            {events.length > 0 && (
                <div style={{ marginTop: 24 }}>
                    <h2 style={{ fontSize: 14, marginBottom: 10, color: '#374151' }}>Timeline</h2>
                    <div
                        style={{
                            background: '#f9fafb',
                            border: '1px solid #e5e7eb',
                            borderRadius: 6,
                            padding: '12px 16px',
                            maxHeight: 320,
                            overflowY: 'auto',
                        }}
                    >
                        {events.map((ev, i) => (
                            <div
                                key={i}
                                style={{
                                    marginBottom: 6,
                                    paddingBottom: 6,
                                    borderBottom:
                                        i < events.length - 1 ? '1px solid #f3f4f6' : 'none',
                                }}
                            >
                                {ev.type === 'step' && (
                                    <span>
                                        <span style={{ color: '#9ca3af', fontSize: 11 }}>
                                            {ev.ts?.slice(11, 19)}
                                        </span>{' '}
                                        <span
                                            style={{
                                                color: STATUS_COLOR[ev.status] ?? '#374151',
                                                fontWeight: 600,
                                            }}
                                        >
                                            [{ev.node}]
                                        </span>{' '}
                                        <span
                                            style={{
                                                color: STATUS_COLOR[ev.status] ?? '#374151',
                                            }}
                                        >
                                            {ev.status}
                                        </span>
                                        {ev.summary ? (
                                            <span style={{ color: '#6b7280' }}>
                                                {' '}
                                                — {ev.summary}
                                            </span>
                                        ) : null}
                                    </span>
                                )}
                                {ev.type === 'error' && (
                                    <span style={{ color: '#dc2626' }}>x {ev.message}</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Final output */}
            {output && output.type === 'output' && (
                <div
                    style={{
                        marginTop: 20,
                        padding: 16,
                        background: '#f0fdf4',
                        border: '1px solid #86efac',
                        borderRadius: 6,
                    }}
                >
                    <strong style={{ color: '#166534', fontSize: 14 }}>
                        Investigation Complete
                    </strong>
                    <div
                        style={{
                            marginTop: 12,
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: 12,
                        }}
                    >
                        <Field label="Case Type" value={output.output.caseType ?? '—'} />
                        <Field label="Confidence" value={output.output.confidence ?? '—'} />
                        <Field label="Status" value={output.output.status} />
                        <Field label="Mode" value={output.output.mode} />
                    </div>
                    {output.output.rootCause && (
                        <div style={{ marginTop: 12 }}>
                            <div
                                style={{
                                    color: '#374151',
                                    fontWeight: 600,
                                    fontSize: 12,
                                    marginBottom: 4,
                                }}
                            >
                                Root Cause
                            </div>
                            <div style={{ color: '#374151', lineHeight: 1.5 }}>
                                {output.output.rootCause}
                            </div>
                        </div>
                    )}
                    {output.output.recommendedFix && (
                        <div style={{ marginTop: 12 }}>
                            <div
                                style={{
                                    color: '#374151',
                                    fontWeight: 600,
                                    fontSize: 12,
                                    marginBottom: 4,
                                }}
                            >
                                Recommended Fix
                            </div>
                            <div style={{ color: '#374151', lineHeight: 1.5 }}>
                                {output.output.recommendedFix}
                            </div>
                        </div>
                    )}
                    {(output.output.nextSteps?.length ?? 0) > 0 && (
                        <div style={{ marginTop: 12 }}>
                            <div
                                style={{
                                    color: '#374151',
                                    fontWeight: 600,
                                    fontSize: 12,
                                    marginBottom: 4,
                                }}
                            >
                                Next Steps
                            </div>
                            <ul
                                style={{
                                    margin: 0,
                                    paddingLeft: 20,
                                    color: '#374151',
                                    lineHeight: 1.6,
                                }}
                            >
                                {output.output.nextSteps!.map((s, i) => (
                                    <li key={i}>{s}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function Field({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>{label}</div>
            <div style={{ color: '#111827', fontWeight: 500 }}>{value}</div>
        </div>
    );
}
