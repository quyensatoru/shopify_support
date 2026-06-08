import { Router } from 'express';
import { AppConfigWriteSchema } from '@shopify-support/shared';
import {
    listApps,
    getApp,
    upsertAppConfig,
    getAppConfig,
    countAppKnowledge,
} from '../../db/repo/index.js';
import { learnApp, type LearnStep } from '../../knowledge/index.js';
import { resolveAppConfig } from '../../config/index.js';
import { encrypt } from '../../config/crypto.js';
import { SqlAdapter } from '../../connectors/db/sql.adapter.js';
import { RedisAdapter } from '../../connectors/db/redis.adapter.js';
import { RabbitMQAdapter } from '../../connectors/db/rabbitmq.adapter.js';
import { shopifyAdminQuery } from '../../connectors/shopify.js';
import { MongoAdapter } from '../../connectors/db/mongo.adapter.js';

const router = Router();

router.get('/apps', async (_req, res) => {
    const rows = await listApps();
    res.json({ apps: rows });
});

router.post('/apps', async (req, res) => {
    try {
        const body = AppConfigWriteSchema.parse(req.body);
        if (!req.body.appKey) {
            res.status(400).json({ error: 'appKey required' });
            return;
        }
        const appKey: string = req.body.appKey;
        await upsertAppConfig(appKey, body.name, encryptConfigSecrets(body));
        res.status(201).json({ appKey });
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

router.get('/apps/:appKey/config', async (req, res) => {
    const row = await getAppConfig(req.params['appKey']!);
    if (!row) {
        res.status(404).json({ error: 'App not found' });
        return;
    }
    // Return config without exposing raw secrets (mask them)
    const cfg = row.config as Record<string, unknown>;
    res.json({ appKey: row.appKey, name: row.name, config: maskSecrets(cfg) });
});

router.put('/apps/:appKey/config', async (req, res) => {
    try {
        const body = AppConfigWriteSchema.parse(req.body);
        const appKey = req.params['appKey']!;
        await upsertAppConfig(appKey, body.name, encryptConfigSecrets(body));
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

router.post('/apps/:appKey/config/test', async (req, res) => {
    const appKey = req.params['appKey']!;
    const row = await getAppConfig(appKey);
    if (!row) {
        res.status(404).json({ error: 'App not found' });
        return;
    }
    const resolved = resolveAppConfig(row);
    const results: Array<{ surface: string; key: string; ok: boolean; message: string }> = [];
    // Test repos (HTTP HEAD)
    for (const repo of resolved.repos) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 5000);
            const r = await fetch(repo.url, { method: 'HEAD', signal: ctrl.signal }).catch(
                () => null,
            );
            clearTimeout(t);
            results.push({
                surface: 'repo',
                key: repo.name,
                ok: r !== null && r.status < 500,
                message: r ? `HTTP ${r.status}` : 'unreachable',
            });
        } catch {
            results.push({
                surface: 'repo',
                key: repo.name,
                ok: false,
                message: 'connection failed',
            });
        }
    }

    // Test DB sources
    for (const src of resolved.dbSources) {
        let ok = false;
        let message = '';
        try {
            if (src.type === 'sql') {
                const adapter = new SqlAdapter(src.connectionString);
                await adapter.count('information_schema.tables', 'true');
                await adapter.close();
                ok = true;
                message = 'connected';
            } else if (src.type === 'redis') {
                const adapter = new RedisAdapter(src.connectionString);
                await adapter.count('', '__health_check__');
                await adapter.close();
                ok = true;
                message = 'connected';
            } else if (src.type === 'rabbitmq') {
                const adapter = new RabbitMQAdapter(src.connectionString, src.mgmtUrl);
                const info = await (
                    adapter as unknown as { queueInspect: (q: string) => Promise<unknown> }
                ).queueInspect('');
                ok = info !== null;
                message = ok ? 'management API reachable' : 'management API unreachable';
            } else if (src.type === 'mongo') {
                const adapter = new MongoAdapter(src.connectionString);
                const health = await adapter.healthCheck()
                
                if(health){
                    await adapter.close();
                    ok = true;
                    message = 'connected';
                } else {
                    ok = false;
                    message = 'mongo test faild';
                }
            }
        } catch (err) {
            ok = false;
            message = String(err).slice(0, 100);
        }
        results.push({ surface: 'database', key: src.key, ok, message });
    }

    // Test Shopify
    if (resolved.shopify?.adminToken) {
        // Need a store domain from query param or skip
        const storeDomain = (req.query['storeDomain'] as string | undefined) ?? '';
        if (storeDomain) {
            try {
                await shopifyAdminQuery(
                    storeDomain,
                    resolved.shopify.adminToken,
                    resolved.shopify.apiVersion,
                    '{ shop { name } }',
                );
                results.push({
                    surface: 'shopify',
                    key: 'api',
                    ok: true,
                    message: 'API reachable',
                });
            } catch (err) {
                results.push({
                    surface: 'shopify',
                    key: 'api',
                    ok: false,
                    message: String(err).slice(0, 100),
                });
            }
        } else {
            results.push({
                surface: 'shopify',
                key: 'api',
                ok: true,
                message: 'configured (no storeDomain to test live)',
            });
        }
    }

    // Test log sources (HEAD on endpoint)
    for (const ls of resolved.logSources ?? []) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4000);
            const r = await fetch(ls.endpoint, { method: 'HEAD', signal: ctrl.signal }).catch(
                () => null,
            );
            clearTimeout(t);
            results.push({
                surface: 'logs',
                key: ls.key,
                ok: r !== null && r.status < 500,
                message: r ? `HTTP ${r.status}` : 'unreachable',
            });
        } catch {
            results.push({ surface: 'logs', key: ls.key, ok: false, message: 'connection failed' });
        }
    }

    if (results.length === 0) {
        results.push({
            surface: 'info',
            key: 'none',
            ok: true,
            message: 'No connections configured to test',
        });
    }

    res.json({ results });
});

router.get('/gitlab/repos', async (req, res) => {
    const baseUrl = ((req.query['baseUrl'] as string) || '').replace(/\/$/, '');
    const token = req.query['token'] as string;
    const groupId = req.query['groupId'] as string;
    if (!baseUrl || !token || !groupId) {
        res.status(400).json({ error: 'baseUrl, token, groupId required' });
        return;
    }
    try {
        const url = `${baseUrl}/api/v4/groups/${encodeURIComponent(groupId)}/projects?per_page=50&simple=true`;
        const r = await fetch(url, { headers: { 'PRIVATE-TOKEN': token } });
        if (!r.ok) {
            res.status(r.status).json({ error: `GitLab API error: ${r.status}` });
            return;
        }
        const repos = await r.json();
        res.json({ repos });
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

router.post('/apps/:appKey/learn', async (req, res) => {
    const appKey = req.params['appKey']!;
    const row = await getAppConfig(appKey);
    if (!row) {
        res.status(404).json({ error: 'App not found' });
        return;
    }
    const config = resolveAppConfig(row);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (ev: LearnStep | { type: 'final'; newChunks: number; totalChunks: number } | { type: 'error'; message: string }) => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        // @ts-expect-error flush exists on compressed responses
        if (typeof res.flush === 'function') res.flush();
    };

    try {
        const newChunks = await learnApp(appKey, config, send);
        const totalChunks = await countAppKnowledge(appKey);
        send({ type: 'final', newChunks, totalChunks });
    } catch (err) {
        send({ type: 'error', message: String(err) });
    }

    res.write('data: [DONE]\n\n');
    res.end();
});

function encryptConfigSecrets(body: Record<string, unknown>): Record<string, unknown> {
    const cfg = structuredClone(body) as Record<string, unknown>;
    if (cfg['gitlab'] && typeof cfg['gitlab'] === 'object') {
        const gl = cfg['gitlab'] as Record<string, string>;
        if (gl['token']) gl['token'] = encrypt(gl['token']);
    }
    if (Array.isArray(cfg['dbSources'])) {
        cfg['dbSources'] = (cfg['dbSources'] as Array<Record<string, string>>).map((s) => ({
            ...s,
            connectionString: encrypt(s['connectionString'] ?? ''),
            ...(s['mgmtUrl'] ? { mgmtUrl: encrypt(s['mgmtUrl']) } : {}),
        }));
    }
    if (Array.isArray(cfg['logSources'])) {
        cfg['logSources'] = (cfg['logSources'] as Array<Record<string, string>>).map((s) => ({
            ...s,
            endpoint: encrypt(s['endpoint'] ?? ''),
            ...(s['token'] ? { token: encrypt(s['token']) } : {}),
        }));
    }
    if (cfg['shopify'] && typeof cfg['shopify'] === 'object') {
        const sh = cfg['shopify'] as Record<string, string>;
        if (sh['adminToken']) sh['adminToken'] = encrypt(sh['adminToken']);
    }
    if (Array.isArray(cfg['services'])) {
        cfg['services'] = (cfg['services'] as Array<Record<string, string>>).map((s) => ({
            ...s,
            ...(s['token'] ? { token: encrypt(s['token']) } : {}),
        }));
    }
    return cfg;
}

function maskSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
    const out = structuredClone(cfg);
    const mask = (obj: Record<string, unknown>, keys: string[]) => {
        for (const key of keys) {
            if (obj[key]) obj[key] = '***';
        }
    };
    if (out['gitlab'] && typeof out['gitlab'] === 'object')
        mask(out['gitlab'] as Record<string, unknown>, ['token']);
    if (Array.isArray(out['dbSources'])) {
        (out['dbSources'] as Array<Record<string, unknown>>).forEach((s) =>
            mask(s, ['connectionString', 'mgmtUrl']),
        );
    }
    if (Array.isArray(out['logSources'])) {
        (out['logSources'] as Array<Record<string, unknown>>).forEach((s) =>
            mask(s, ['endpoint', 'token']),
        );
    }
    if (out['shopify'] && typeof out['shopify'] === 'object')
        mask(out['shopify'] as Record<string, unknown>, ['adminToken']);
    if (Array.isArray(out['services'])) {
        (out['services'] as Array<Record<string, unknown>>).forEach((s) => mask(s, ['token']));
    }
    return out;
}

export { router as appsRouter };
