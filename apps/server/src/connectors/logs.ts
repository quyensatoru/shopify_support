import type { LogSource } from '@shopify-support/shared';

type LogQuery = {
    keyword?: string;
    level?: string;
    timeWindowMinutes?: number;
};

export async function queryLogs(source: LogSource, query: LogQuery): Promise<string[]> {
    switch (source.type) {
        case 'loki':
            return queryLoki(source, query);
        case 'elasticsearch':
        case 'elk':
            return queryElastic(source, query);
        default:
            // Generic: try HTTP fetch with basic auth
            return queryGeneric(source, query);
    }
}

async function queryLoki(source: LogSource, query: LogQuery): Promise<string[]> {
    const since = `${(query.timeWindowMinutes ?? 60) * 60}s`;
    const logql = query.keyword ? `{app=~".+"} |= "${query.keyword}"` : `{app=~".+"}`;
    const url = `${source.endpoint}/loki/api/v1/query_range?query=${encodeURIComponent(logql)}&start=${Date.now() - (query.timeWindowMinutes ?? 60) * 60000}&end=${Date.now()}&limit=50`;

    const headers: Record<string, string> = {};
    if (source.token) headers['Authorization'] = `Bearer ${source.token}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as {
        data?: { result?: Array<{ values?: Array<[string, string]> }> };
    };
    return (data.data?.result ?? [])
        .flatMap((r) => (r.values ?? []).map(([, line]) => line))
        .slice(0, 50);
}

async function queryElastic(source: LogSource, query: LogQuery): Promise<string[]> {
    const body = {
        query: {
            bool: {
                filter: [
                    { range: { '@timestamp': { gte: `now-${query.timeWindowMinutes ?? 60}m` } } },
                    ...(query.keyword ? [{ match: { message: query.keyword } }] : []),
                    ...(query.level ? [{ term: { level: query.level } }] : []),
                ],
            },
        },
        size: 50,
        sort: [{ '@timestamp': { order: 'desc' } }],
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (source.token) headers['Authorization'] = `Bearer ${source.token}`;

    const res = await fetch(`${source.endpoint}/_search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
        hits?: { hits?: Array<{ _source?: { message?: string } }> };
    };
    return (data.hits?.hits ?? []).map((h) => h._source?.message ?? '').filter(Boolean);
}

async function queryGeneric(source: LogSource, query: LogQuery): Promise<string[]> {
    // Fallback: return empty and note that source type is unsupported
    return [
        `[logs:${source.type}] unsupported connector — no logs retrieved for keyword="${query.keyword ?? ''}"`,
    ];
}
