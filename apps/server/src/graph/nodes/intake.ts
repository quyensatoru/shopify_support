import type { SupportStateType } from '../state.js';
import { getAppConfig } from '../../db/repo/index.js';
import { resolveAppConfig } from '../../config/index.js';
import { retrieveMemories } from '../../memory/index.js';
import { stepLog } from '../utils.js';

export async function intakeNode(state: SupportStateType) {
    const t0 = Date.now();
    const { request } = state;

    // 1. Resolve app config
    const configRow = await getAppConfig(request.appKey ?? request.app).catch(() => null);
    const appConfig = configRow ? resolveAppConfig(configRow) : undefined;

    // 2. Retrieve relevant memories (RAG)
    const retrievedMemories = await retrieveMemories(request.app, request.issueText, 5);

    return {
        appConfig,
        retrievedMemories,
        timeline: [
            stepLog(
                'intake',
                'completed',
                Date.now() - t0,
                `App config loaded (${configRow ? 'found' : 'not configured'}), ${retrievedMemories.length} memories retrieved`,
            ),
        ],
    };
}
