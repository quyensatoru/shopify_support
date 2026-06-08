import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenRouter } from '@langchain/openrouter';
import { RunnableLambda } from '@langchain/core/runnables';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import OpenAI from 'openai';
import type { z } from 'zod';
import { getEnv } from '../env.js';
import { logger } from '../observability/logger.js';
import * as fs from 'fs'

// ── Anthropic (via @langchain/anthropic — stays at core 0.3.x) ────────

function buildAnthropic(fast: boolean): ChatAnthropic {
    const env = getEnv();
    return new ChatAnthropic({
        model: fast ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6',
        apiKey: env.ANTHROPIC_API_KEY!,
        temperature: fast ? 0 : 0.1,
        maxTokens: fast ? 1024 : 4096,
    });
}

function buildOpenRouter(fast: boolean): ChatOpenRouter {
    const env = getEnv();
    return new ChatOpenRouter({
        model: 'openai/gpt-oss-120b:free',
        apiKey: env.OPENROUTER_API_KEY!,
        temperature: 0
    });
}

// ── OpenAI-compatible direct caller (used for both OpenAI & DeepSeek) ─
// Uses openai SDK directly to avoid @langchain/openai version conflicts.

type DirectChain<T> = Runnable<BaseLanguageModelInput, T>;

// Sanitize LLM JSON output: strip markdown fences, escape literal control chars inside strings.
function sanitizeLlmJson(text: string): string {
    // Strip markdown code fences
    let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

    // Walk character-by-character, escaping unescaped control characters inside JSON strings
    let inString = false;
    let escaped = false;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            out += ch;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            out += ch;
            continue;
        }
        if (inString && ch.charCodeAt(0) < 0x20) {
            switch (ch) {
                case '\n': out += '\\n'; break;
                case '\r': out += '\\r'; break;
                case '\t': out += '\\t'; break;
                default: out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
            }
            continue;
        }
        out += ch;
    }
    return out;
}

// Parse with fallback: if model wraps output in a single container key, unwrap it.
function tryParseSchema<T>(schema: z.ZodType<T>, raw: unknown): T {
    const direct = schema.safeParse(raw);
    if (direct.success) return direct.data;

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const keys = Object.keys(raw as object);
        if (keys.length === 1) {
            const inner = (raw as Record<string, unknown>)[keys[0]!];
            const unwrapped = schema.safeParse(inner);
            if (unwrapped.success) return unwrapped.data;
        }
    }

    return schema.parse(raw); // throws ZodError with field-level detail
}

function buildDirectChain<T>(
    schema: z.ZodType<T>,
    cfg: {
        apiKey: string;
        baseURL?: string;
        model: string;
        maxTokens: number;
        temperature: number;
    },
): DirectChain<T> {
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    const jsonSchema = toJsonSchema(schema);
    const systemPrompt =
        'You must respond with valid JSON only — no markdown fences, no explanation.\n\n' +
        'Your response MUST exactly match this JSON Schema:\n' +
        JSON.stringify(jsonSchema, null, 2);

    return RunnableLambda.from(async (input: BaseLanguageModelInput): Promise<T> => {
        const content =
            typeof input === 'string'
                ? input
                : Array.isArray(input)
                  ? (input as Array<{ content?: string }>).map((m) => m.content ?? '').join('\n')
                  : JSON.stringify(input);

        const call = async (userContent: string) => {
            const response = await client.chat.completions.create({
                model: cfg.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent },
                ],
                response_format: { type: 'json_object' },
                max_tokens: cfg.maxTokens,
                temperature: cfg.temperature,
            });
            await fs.writeFileSync('response_output.txt', JSON.stringify(response.choices[0]?.message, null, 2) || '')
            return JSON.parse(sanitizeLlmJson(response.choices[0]?.message?.content ?? '{}')) as unknown;
        };

        const raw = await call(content);
        try {
            return tryParseSchema(schema, raw);
        } catch (firstErr) {
            // Retry once, feeding the validation error back so the model can self-correct
            const hint = firstErr instanceof Error ? firstErr.message : String(firstErr);
            const raw2 = await call(
                `${content}\n\nIMPORTANT: Your previous response did not match the required schema.\nValidation error: ${hint.slice(0, 400)}\nPlease return corrected JSON.`,
            );
            return tryParseSchema(schema, raw2);
        }
    }) as unknown as DirectChain<T>;
}

// ── getLlm (for non-structured callers, e.g. memory/index.ts) ─────────

export function getLlm(): BaseChatModel {
    const env = getEnv();
    if (env.ANTHROPIC_API_KEY) return buildAnthropic(false);
    // For non-structured use: return Anthropic only (no direct chain here)
    throw new Error('No Anthropic API key configured for getLlm()');
}

export function getLlmFast(): BaseChatModel {
    const env = getEnv();
    if (env.ANTHROPIC_API_KEY) return buildAnthropic(true);
    throw new Error('No Anthropic API key configured for getLlmFast()');
}

// ── Fallback chain: Anthropic → DeepSeek → OpenAI ─────────────────────

type StructuredChain<T> = Runnable<BaseLanguageModelInput, T>;

/**
 * Tries each chain in order. On error, logs and moves to the next provider.
 */
function makeChain<T>(
    chains: Array<{ chain: StructuredChain<T>; label: string }>,
): StructuredChain<T> {
    return RunnableLambda.from(async (input: BaseLanguageModelInput): Promise<T> => {
        let lastErr: unknown;
        for (let i = 0; i < chains.length; i++) {
            const { chain, label } = chains[i]!;
            try {
                const result = await chain.invoke(input);
                // withStructuredOutput can return null when model omits tool_call/function_call
                if (result == null)
                    throw new Error(`Provider ${label} returned null — no structured output`);
                return result;
            } catch (err) {
                lastErr = err;
                const next = chains[i + 1]?.label;
                if (next) {
                    logger.warn(
                        { provider: label, err: String(err).slice(0, 300) },
                        `LLM provider failed — switching to ${next}`,
                    );
                } else {
                    logger.error(
                        { provider: label, err: String(err).slice(0, 300) },
                        'All LLM providers failed',
                    );
                }
            }
        }
        throw lastErr;
    }) as unknown as StructuredChain<T>;
}

function buildProviders<T>(schema: z.ZodType<T>, name: string, fast: boolean) {
    const env = getEnv();
    const providers: Array<{ chain: StructuredChain<T>; label: string }> = [];

    if (env.OPENROUTER_API_KEY) {
        providers.push({
            chain: buildDirectChain(schema, {
                apiKey: env.OPENROUTER_API_KEY,
                baseURL: 'https://openrouter.ai/api/v1',
                model: 'openai/gpt-oss-120b:free',
                maxTokens: fast ? 4096 : 8192,
                temperature: 0,
            }),
            label: 'Openrouter',
        })
        // const openrouter = buildOpenRouter(fast);
        // providers.push({
        //     chain: openrouter.withStructuredOutput(schema, { name, method: 'jsonMode' }) as StructuredChain<T>,
        //     label: 'Openrouter',
        // });
    }

    // if (env.ANTHROPIC_API_KEY) {
    //     const anthropic = buildAnthropic(fast);
    //     providers.push({
    //         chain: anthropic.withStructuredOutput(schema, { name }) as StructuredChain<T>,
    //         label: 'Anthropic',
    //     });
    // }

    // if (env.DEEPSEEK_API_KEY) {
    //     providers.push({
    //         chain: buildDirectChain(schema, {
    //             apiKey: env.DEEPSEEK_API_KEY,
    //             baseURL: 'https://api.deepseek.com/v1',
    //             model: fast ? 'deepseek-chat' : 'deepseek-chat',
    //             maxTokens: fast ? 1024 : 4096,
    //             temperature: fast ? 0 : 0.1,
    //         }),
    //         label: 'DeepSeek',
    //     });
    // }

    // if (env.OPENAI_API_KEY) {
    //     providers.push({
    //         chain: buildDirectChain(schema, {
    //             apiKey: env.OPENAI_API_KEY,
    //             model: fast ? 'gpt-4.1-mini' : 'gpt-4.1',
    //             maxTokens: fast ? 1024 : 4096,
    //             temperature: fast ? 0 : 0.1,
    //         }),
    //         label: 'OpenAI',
    //     });
    // }

    if (providers.length === 0) {
        throw new Error(
            'No LLM provider configured — set at least one of ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY',
        );
    }
    return providers;
}

/**
 * Returns a typed structured-output chain with automatic provider fallback.
 * Order: Anthropic → DeepSeek → OpenAI (whichever keys are configured).
 */
function wrapNullGuard<T>(chain: StructuredChain<T>, label: string): StructuredChain<T> {
    return RunnableLambda.from(async (input: BaseLanguageModelInput): Promise<T> => {
        const result = await chain.invoke(input);
        if (result == null)
            throw new Error(`Provider ${label} returned null — no structured output`);
        return result;
    }) as unknown as StructuredChain<T>;
}

export function getStructuredLlm<T extends z.ZodType>(
    schema: T,
    name: string,
): StructuredChain<z.infer<T>> {
    const providers = buildProviders(schema as z.ZodType<z.infer<T>>, name, false);
    if (providers.length === 1) return wrapNullGuard(providers[0]!.chain, providers[0]!.label);
    return makeChain(providers);
}

export function getStructuredLlmFast<T extends z.ZodType>(
    schema: T,
    name: string,
): StructuredChain<z.infer<T>> {
    const providers = buildProviders(schema as z.ZodType<z.infer<T>>, name, true);
    if (providers.length === 1) return wrapNullGuard(providers[0]!.chain, providers[0]!.label);
    return makeChain(providers);
}
