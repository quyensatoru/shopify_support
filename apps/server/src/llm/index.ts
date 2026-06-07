import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenRouter } from '@langchain/openrouter';
import { RunnableLambda } from '@langchain/core/runnables';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import OpenAI from 'openai';
import type { z } from 'zod';
import { getEnv } from '../env.js';
import { logger } from '../observability/logger.js';

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
        temperature: 0,
        maxTokens: fast ? 1000 : 4096,
    });
}

// ── OpenAI-compatible direct caller (used for both OpenAI & DeepSeek) ─
// Uses openai SDK directly to avoid @langchain/openai version conflicts.

type DirectChain<T> = Runnable<BaseLanguageModelInput, T>;

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
    return RunnableLambda.from(async (input: BaseLanguageModelInput): Promise<T> => {
        const content =
            typeof input === 'string'
                ? input
                : Array.isArray(input)
                  ? (input as Array<{ content?: string }>).map((m) => m.content ?? '').join('\n')
                  : JSON.stringify(input);

        const response = await client.chat.completions.create({
            model: cfg.model,
            messages: [
                {
                    role: 'system',
                    content:
                        'You must respond with valid JSON only — no markdown fences, no explanation. ' +
                        'The JSON must satisfy the schema exactly as described in the user message.',
                },
                { role: 'user', content },
            ],
            response_format: { type: 'json_object' },
            max_tokens: cfg.maxTokens,
            temperature: cfg.temperature,
        });

        const raw = JSON.parse(response.choices[0]?.message?.content ?? '{}');
        return schema.parse(raw);
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
        const openrouter = buildOpenRouter(fast);
        providers.push({
            chain: openrouter.withStructuredOutput(schema, { name }) as StructuredChain<T>,
            label: 'Openrouter',
        });
    }

    if (env.ANTHROPIC_API_KEY) {
        const anthropic = buildAnthropic(fast);
        providers.push({
            chain: anthropic.withStructuredOutput(schema, { name }) as StructuredChain<T>,
            label: 'Anthropic',
        });
    }

    if (env.DEEPSEEK_API_KEY) {
        providers.push({
            chain: buildDirectChain(schema, {
                apiKey: env.DEEPSEEK_API_KEY,
                baseURL: 'https://api.deepseek.com/v1',
                model: fast ? 'deepseek-chat' : 'deepseek-chat',
                maxTokens: fast ? 1024 : 4096,
                temperature: fast ? 0 : 0.1,
            }),
            label: 'DeepSeek',
        });
    }

    if (env.OPENAI_API_KEY) {
        providers.push({
            chain: buildDirectChain(schema, {
                apiKey: env.OPENAI_API_KEY,
                model: fast ? 'gpt-4.1-mini' : 'gpt-4.1',
                maxTokens: fast ? 1024 : 4096,
                temperature: fast ? 0 : 0.1,
            }),
            label: 'OpenAI',
        });
    }

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
