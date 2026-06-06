import type { StepLog } from '@shopify-support/shared';

let _seq = 0;

export function stepLog(
    node: string,
    status: StepLog['status'],
    durationMs?: number,
    summary?: string,
): StepLog {
    return {
        seq: _seq++,
        node,
        status,
        summary,
        durationMs,
        ts: new Date().toISOString(),
    };
}
