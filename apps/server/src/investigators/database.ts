import type { Probe, ProbeResult, ResolvedAppConfig } from '@shopify-support/shared';
import { getAdapter } from '../connectors/db/index.js';

export async function investigateDatabase(
    probe: Probe,
    appConfig: ResolvedAppConfig | undefined,
): Promise<ProbeResult> {
    const base = { probeId: probe.id, surface: probe.surface as 'database', action: probe.action };

    if (!appConfig?.dbSources?.length) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: 'No DB sources configured',
            provenance: 'db:none',
        };
    }

    const sourceKey = probe.target['source'];
    const source = sourceKey
        ? appConfig.dbSources.find((s) => s.key === sourceKey)
        : appConfig.dbSources[0];

    if (!source) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: `DB source "${sourceKey}" not found`,
            provenance: 'db:sources',
        };
    }

    const adapter = getAdapter(source);
    const provenance = `db:${source.key}(${source.type})`;

    try {
        switch (probe.action) {
            case 'read_schema': {
                const schema = await adapter.readSchema(
                    probe.target['collection'] ?? probe.target['table'] ?? '',
                );
                return { ...base, status: 'done', found: true, data: schema, provenance };
            }
            case 'check_record_exists': {
                const result = await adapter.checkExists(
                    probe.target['collection'] ?? probe.target['table'] ?? '',
                    probe.target['query'] ?? '',
                );
                return { ...base, status: 'done', found: result.exists, data: result, provenance };
            }
            case 'count_check': {
                const count = await adapter.count(
                    probe.target['collection'] ?? probe.target['table'] ?? '',
                    probe.target['query'] ?? '',
                );
                return { ...base, status: 'done', found: count > 0, data: { count }, provenance };
            }
            case 'key_inspect': {
                if (source.type !== 'redis')
                    return {
                        ...base,
                        status: 'skipped',
                        found: false,
                        data: null,
                        reason: 'key_inspect is redis-only',
                        provenance,
                    };
                const info = await adapter.keyInspect!(
                    probe.target['key'] ?? probe.target['pattern'] ?? '',
                );
                return { ...base, status: 'done', found: info !== null, data: info, provenance };
            }
            case 'queue_inspect': {
                if (source.type !== 'rabbitmq')
                    return {
                        ...base,
                        status: 'skipped',
                        found: false,
                        data: null,
                        reason: 'queue_inspect is rabbitmq-only',
                        provenance,
                    };
                const queueInfo = await adapter.queueInspect!(probe.target['queue'] ?? '');
                return { ...base, status: 'done', found: true, data: queueInfo, provenance };
            }
            case 'peek_messages': {
                if (source.type !== 'rabbitmq')
                    return {
                        ...base,
                        status: 'skipped',
                        found: false,
                        data: null,
                        reason: 'peek_messages is rabbitmq-only',
                        provenance,
                    };
                const msgs = await adapter.peekMessages!(
                    probe.target['queue'] ?? '',
                    Number(probe.target['n'] ?? 5),
                );
                return { ...base, status: 'done', found: msgs.length > 0, data: msgs, provenance };
            }
            default:
                return {
                    ...base,
                    status: 'skipped',
                    found: false,
                    data: null,
                    reason: `Unknown db action: ${probe.action}`,
                    provenance,
                };
        }
    } catch (err) {
        return {
            ...base,
            status: 'failed',
            found: false,
            data: null,
            reason: String(err),
            provenance,
        };
    } finally {
        await adapter.close().catch(() => {});
    }
}
