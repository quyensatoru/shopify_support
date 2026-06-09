import type { Probe, ProbeResult, ResolvedAppConfig } from '@shopify-support/shared';
import { getAdapter } from '../connectors/db/index.js';
import {
    discoverSnapshotPipeline,
    decompressSnapshot,
    analyzeSnapshotStructure,
    replaySnapshotHeadless,
} from '../connectors/snapshot.js';

/** Pull the compressed blob value out of a fetched DB row, normalizing to string|Buffer. */
function extractBlob(row: unknown, field: string): string | Buffer | null {
    if (!row || typeof row !== 'object') return null;
    const v = (row as Record<string, unknown>)[field];
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (Buffer.isBuffer(v)) return v;
    // BSON Binary (Mongo) exposes a `.buffer`
    const maybe = v as { buffer?: Buffer | Uint8Array };
    if (maybe.buffer) return Buffer.from(maybe.buffer);
    return null;
}

export async function investigateSnapshot(
    probe: Probe,
    appConfig: ResolvedAppConfig | undefined,
): Promise<ProbeResult> {
    const base = { probeId: probe.id, surface: probe.surface as 'snapshot', action: probe.action };

    // ── action: inspect_pipeline — how does the app compress/render snapshots? ──
    if (probe.action === 'inspect_pipeline') {
        const pipeline = await discoverSnapshotPipeline(appConfig);
        return {
            ...base,
            status: 'done',
            found: pipeline.hits.length > 0,
            data: pipeline,
            provenance: 'snapshot:inspect_pipeline',
        };
    }

    if (probe.action !== 'build_snapshot') {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: `Unknown snapshot action: ${probe.action}`,
            provenance: 'snapshot',
        };
    }

    // ── action: build_snapshot — fetch from DB → decompress → analyze → replay ──
    if (!appConfig?.dbSources?.length) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: 'No DB sources configured to read the recording from',
            provenance: 'snapshot:build',
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
            provenance: 'snapshot:build',
        };
    }

    const target = probe.target['table'] ?? probe.target['collection'] ?? '';
    const idField = probe.target['idField'] ?? 'id';
    const snapshotField = probe.target['snapshotField'] ?? 'snapshot';
    const recordingId = probe.target['recordingId'];
    if (!target || !recordingId) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: 'build_snapshot requires target.table/collection and target.recordingId',
            provenance: `snapshot:${source.key}`,
        };
    }

    // Discover the app's compression/render pipeline to pick a decompressor (grounded).
    const pipeline = await discoverSnapshotPipeline(appConfig).catch(() => null);

    const adapter = getAdapter(source);
    const provenance = `snapshot:${source.key}(${source.type})`;
    try {
        const safeId = String(recordingId).replace(/'/g, "''");
        const query =
            source.type === 'mongo'
                ? JSON.stringify({ [idField]: recordingId })
                : `${idField} = '${safeId}'`;
        const { exists, sample } = await adapter.checkExists(target, query);
        if (!exists || !Array.isArray(sample) || !sample.length) {
            return {
                ...base,
                status: 'done',
                found: false,
                data: { reason: 'recording not found', query },
                provenance,
            };
        }

        const blob = extractBlob(sample[0], snapshotField);
        if (!blob) {
            return {
                ...base,
                status: 'done',
                found: false,
                data: {
                    reason: `field "${snapshotField}" missing/empty on the record`,
                    availableFields: Object.keys(sample[0] as Record<string, unknown>),
                },
                provenance,
            };
        }

        const decompressed = await decompressSnapshot(blob, pipeline?.likelyAlgorithm);
        if (!decompressed.ok) {
            return {
                ...base,
                status: 'done',
                found: true,
                data: {
                    stage: 'decompress',
                    problem: 'Could not decompress the recording with any known strategy.',
                    pipeline,
                    error: decompressed.error,
                },
                provenance,
            };
        }

        const analysis = analyzeSnapshotStructure(decompressed.full);
        // Replay headless only when there is something renderable to rebuild.
        const replay =
            analysis.shape === 'rrweb-events' || analysis.shape === 'dom-tree'
                ? await replaySnapshotHeadless(decompressed.full)
                : { attempted: false, rendered: false, consoleErrors: [], networkErrors: [], reason: 'unsupported shape' };

        const problems = [
            ...analysis.issues,
            ...(replay.blank ? [replay.reason ?? 'blank render'] : []),
            ...replay.consoleErrors.slice(0, 5).map((e) => `console: ${e}`),
            ...replay.networkErrors.slice(0, 5).map((e) => `network: ${e}`),
        ];

        return {
            ...base,
            status: 'done',
            // "found" = we surfaced a concrete signal about where it breaks
            found: problems.length > 0,
            data: {
                pipeline,
                decompressStrategy: decompressed.strategy,
                analysis,
                replay,
                problems,
            },
            provenance,
        };
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
