import { Router } from 'express';
import { AppConfigWriteSchema } from '@shopify-support/shared';
import { listApps, getApp, upsertAppConfig, getAppConfig } from '../../db/repo/index.js';
import { resolveAppConfig } from '../../config/index.js';
import { encrypt } from '../../config/crypto.js';

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
    // Return basic reachability check results (stub — real tests in investigators)
    const results = [
        {
            surface: 'repos',
            key: 'repos',
            ok: resolved.repos.length > 0,
            message: `${resolved.repos.length} repo(s) configured`,
        },
        {
            surface: 'database',
            key: 'dbSources',
            ok: resolved.dbSources.length > 0,
            message: `${resolved.dbSources.length} DB source(s) configured`,
        },
        {
            surface: 'logs',
            key: 'logSources',
            ok: (resolved.logSources?.length ?? 0) > 0,
            message: resolved.logSources
                ? `${resolved.logSources.length} log source(s)`
                : 'not configured (optional)',
        },
        {
            surface: 'shopify',
            key: 'shopify',
            ok: Boolean(resolved.shopify?.adminToken),
            message: resolved.shopify ? 'Shopify configured' : 'not configured',
        },
    ];
    res.json({ results });
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
