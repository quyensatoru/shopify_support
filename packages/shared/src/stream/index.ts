import { z } from 'zod';
import { SupportRunOutputSchema } from '../state/index.js';

// ── SSE event types (GET /api/runs/:id/stream) ───────────────────────

export const StreamStepEventSchema = z.object({
  type: z.literal('step'),
  node: z.string(),
  status: z.enum(['started', 'completed', 'failed', 'skipped', 'interrupted']),
  summary: z.string().optional(),
  ts: z.string(),
});
export type StreamStepEvent = z.infer<typeof StreamStepEventSchema>;

export const StreamInterruptEventSchema = z.object({
  type: z.literal('interrupt'),
  reason: z.enum(['need_context', 'need_approval']),
  question: z.string(),
  value: z.unknown(),
  ts: z.string(),
});
export type StreamInterruptEvent = z.infer<typeof StreamInterruptEventSchema>;

export const StreamOutputEventSchema = z.object({
  type: z.literal('output'),
  output: SupportRunOutputSchema,
  ts: z.string(),
});
export type StreamOutputEvent = z.infer<typeof StreamOutputEventSchema>;

export const StreamErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  ts: z.string(),
});
export type StreamErrorEvent = z.infer<typeof StreamErrorEventSchema>;

export const StreamEventSchema = z.discriminatedUnion('type', [
  StreamStepEventSchema,
  StreamInterruptEventSchema,
  StreamOutputEventSchema,
  StreamErrorEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
