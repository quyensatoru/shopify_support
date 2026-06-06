import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
    CreateRunRequestSchema,
    ListRunsQuerySchema,
    ResumeRunRequestSchema,
} from '@shopify-support/shared';
import type { RunRequest } from '@shopify-support/shared';
import { createRun, getRun, listRuns, updateRunStatus } from '../../db/repo/index.js';
import { streamSupportGraph } from '../../graph/graph.js';
import { sseStart, sseSend, sseEnd } from '../sse.js';
import { logger } from '../../observability/logger.js';

const router = Router();

// POST /api/runs — create a run record and return immediately
router.post('/runs', async (req, res) => {
    try {
        const body = CreateRunRequestSchema.parse(req.body);
        const runId = `run-${randomUUID()}`;
        const threadId = `thread-${randomUUID()}`;

        const requestPayload: Omit<RunRequest, 'runId' | 'threadId'> & {
            runId: string;
            threadId: string;
        } = {
            runId,
            threadId,
            app: body.app,
            appKey: body.appKey,
            issueText: body.issueText,
            mode: body.mode ?? 'diagnose',
            reportedBy: body.reportedBy,
            severity: body.severity,
            identifiers: body.identifiers ?? [],
            interactive: body.interactive ?? false,
            maxIterations: 3,
            metadata: body.metadata ?? {},
        };

        await createRun({
            runId,
            threadId,
            app: body.app,
            appKey: body.appKey,
            issueText: body.issueText,
            mode: body.mode ?? 'diagnose',
            reportedBy: body.reportedBy,
            requestPayload,
        });

        res.status(202).json({ runId, threadId, status: 'running' });
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

// GET /api/runs/:id/stream — SSE: run the graph and stream events
router.get('/runs/:id/stream', async (req, res) => {
    const { id: runId } = req.params;
    const run = await getRun(runId).catch(() => null);
    if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
    }

    const request = run.requestPayload as RunRequest | null;
    if (!request) {
        res.status(400).json({ error: 'Run has no stored request payload' });
        return;
    }

    sseStart(res);
    const now = () => new Date().toISOString();

    try {
        for await (const event of streamSupportGraph({ threadId: run.threadId, runId, request })) {
            sseSend(res, event);
            if (event.type === 'output' || event.type === 'interrupt') break;
        }
    } catch (err) {
        logger.error({ runId, err }, 'Stream error');
        sseSend(res, { type: 'error', message: String(err), ts: now() });
        await updateRunStatus(runId, 'failed').catch(() => {});
    }
    sseEnd(res);
});

// POST /api/runs/:id/resume — resume after interrupt
router.post('/runs/:id/resume', async (req, res) => {
    const { id: runId } = req.params;
    try {
        const body = ResumeRunRequestSchema.parse(req.body);
        const run = await getRun(runId);
        if (!run) {
            res.status(404).json({ error: 'Run not found' });
            return;
        }

        const resumeValue =
            body.type === 'approval' ? { decision: body.decision, note: body.note } : body.value;

        sseStart(res);
        const now = () => new Date().toISOString();

        try {
            for await (const event of streamSupportGraph({
                threadId: run.threadId,
                runId,
                resume: resumeValue,
            })) {
                sseSend(res, event);
                if (event.type === 'output' || event.type === 'interrupt') break;
            }
        } catch (err) {
            logger.error({ runId, err }, 'Resume stream error');
            sseSend(res, { type: 'error', message: String(err), ts: now() });
            await updateRunStatus(runId, 'failed').catch(() => {});
        }
        sseEnd(res);
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

// GET /api/runs/:id
router.get('/runs/:id', async (req, res) => {
    const row = await getRun(req.params['id']!);
    if (!row) {
        res.status(404).json({ error: 'Run not found' });
        return;
    }
    res.json(row);
});

// GET /api/runs
router.get('/runs', async (req, res) => {
    try {
        const query = ListRunsQuerySchema.parse(req.query);
        const rows = await listRuns(query);
        res.json({ runs: rows, limit: query.limit, offset: query.offset });
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

export { router as runsRouter };
