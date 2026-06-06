import type { Response } from 'express';
import type { StreamEvent } from '@shopify-support/shared';

export function sseStart(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx
    res.flushHeaders();
}

export function sseSend(res: Response, event: StreamEvent): void {
    const data = JSON.stringify(event);
    res.write(`data: ${data}\n\n`);
    // @ts-expect-error flush exists on compressed responses
    if (typeof res.flush === 'function') res.flush();
}

export function sseEnd(res: Response): void {
    res.write('data: [DONE]\n\n');
    res.end();
}
