import { useState } from 'react';
import type { CreateRunRequest, RunDetail, StreamEvent } from '@shopify-support/shared';

const API = '/api';

async function createRun(body: CreateRunRequest): Promise<{ runId: string; threadId: string }> {
  const res = await fetch(`${API}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function useStream(runId: string | null) {
  const [events, setEvents] = useState<StreamEvent[]>([]);

  const startStream = (id: string) => {
    const es = new EventSource(`${API}/runs/${id}/stream`);
    es.onmessage = (e) => {
      if (e.data === '[DONE]') { es.close(); return; }
      try {
        const ev: StreamEvent = JSON.parse(e.data);
        setEvents((prev) => [...prev, ev]);
        if (ev.type === 'output' || ev.type === 'interrupt') es.close();
      } catch {}
    };
    return () => es.close();
  };

  return { events, startStream };
}

export function App() {
  const [issueText, setIssueText] = useState('');
  const [app, setApp] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { events, startStream } = useStream(runId);

  const submit = async () => {
    if (!issueText.trim() || !app.trim()) return;
    setLoading(true);
    const { runId: id } = await createRun({ app, issueText, reportedBy: 'cse@example.com', mode: 'diagnose' });
    setRunId(id);
    startStream(id);
    setLoading(false);
  };

  return (
    <div style={{ fontFamily: 'monospace', maxWidth: 900, margin: '40px auto', padding: '0 20px' }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Shopify Support Agent</h1>

      <div style={{ marginBottom: 12 }}>
        <input
          placeholder="App name (e.g. my-shopify-app)"
          value={app}
          onChange={(e) => setApp(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 8, boxSizing: 'border-box' }}
        />
        <textarea
          placeholder="Describe the merchant issue..."
          value={issueText}
          onChange={(e) => setIssueText(e.target.value)}
          rows={4}
          style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
        />
      </div>

      <button onClick={submit} disabled={loading || !issueText || !app} style={{ padding: '8px 24px' }}>
        {loading ? 'Starting...' : 'Start Investigation'}
      </button>

      {runId && (
        <p style={{ marginTop: 8, color: '#555', fontSize: 13 }}>
          Run ID: <code>{runId}</code>
        </p>
      )}

      {events.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Timeline</h2>
          <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, maxHeight: 400, overflowY: 'auto' }}>
            {events.map((ev, i) => (
              <div key={i} style={{ marginBottom: 6, fontSize: 13 }}>
                {ev.type === 'step' && (
                  <span>
                    <span style={{ color: '#888' }}>[{ev.ts}]</span>{' '}
                    <strong>{ev.node}</strong>{' '}
                    <span style={{ color: ev.status === 'failed' ? 'red' : '#333' }}>{ev.status}</span>
                    {ev.summary ? ` — ${ev.summary}` : ''}
                  </span>
                )}
                {ev.type === 'interrupt' && (
                  <span style={{ color: '#b45309' }}>
                    ⚠ <strong>Interrupted:</strong> {ev.question}
                  </span>
                )}
                {ev.type === 'output' && (
                  <div>
                    <strong style={{ color: '#166534' }}>✓ Completed</strong>
                    <pre style={{ marginTop: 4, fontSize: 12, background: '#e8f5e9', padding: 8, borderRadius: 4, overflowX: 'auto' }}>
                      {JSON.stringify(ev.output, null, 2)}
                    </pre>
                  </div>
                )}
                {ev.type === 'error' && (
                  <span style={{ color: 'red' }}>✗ {ev.message}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
