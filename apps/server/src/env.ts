import { z } from 'zod';

const schema = z
    .object({
        PORT: z.coerce.number().int().positive().default(3000),
        NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
        DATABASE_URL: z.string().min(1),
        LANGGRAPH_CHECKPOINT_DB_URL: z.string().optional(),
        DATABASE_MIGRATE_ON_START: z
            .string()
            .transform((v) => v === 'true')
            .default('false'),
        ANTHROPIC_API_KEY: z.string().min(1).optional(),
        OPENAI_API_KEY: z.string().min(1).optional(),
        DEEPSEEK_API_KEY: z.string().min(1).optional(),
        OPENROUTER_API_KEY: z.string().min(1).optional(),
        LANGCHAIN_TRACING_V2: z
            .string()
            .transform((v) => v === 'true')
            .default('false'),
        LANGCHAIN_API_KEY: z.string().optional(),
        LANGCHAIN_PROJECT: z.string().default('shopify-support-agent'),
        ENCRYPTION_KEY: z.string().length(64),
        PLAYWRIGHT_HEADLESS: z
            .string()
            .transform((v) => v !== 'false')
            .default('true'),
        WORKSPACE_DIR: z.string().default('./workspace'),
        TAVILY_API_KEY: z.string().min(1).optional(),
        FIRECRAWL_API_KEY: z.string().min(1).optional(),
        EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    })
    .refine((d) => Boolean(d.ANTHROPIC_API_KEY ?? d.OPENAI_API_KEY), {
        message: 'At least one of ANTHROPIC_API_KEY or OPENAI_API_KEY must be set',
    });

let _env: z.infer<typeof schema> | undefined;

export function getEnv(): z.infer<typeof schema> {
    if (_env) return _env;
    const result = schema.safeParse(process.env);
    if (!result.success) {
        throw new Error(`Invalid environment:\n${result.error.toString()}`);
    }
    _env = result.data;
    return _env;
}

export type Env = z.infer<typeof schema>;
