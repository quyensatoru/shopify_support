import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { getEnv } from '../env.js';
import { logger } from '../observability/logger.js';

let _checkpointer: PostgresSaver | undefined;

export async function getCheckpointer(): Promise<PostgresSaver> {
    if (_checkpointer) return _checkpointer;

    const env = getEnv();
    const connStr = env.LANGGRAPH_CHECKPOINT_DB_URL ?? env.DATABASE_URL;
    const pool = new pg.Pool({ connectionString: connStr });

    const saver = PostgresSaver.fromConnString(connStr);
    await saver.setup();

    logger.info('LangGraph PostgresSaver ready');
    _checkpointer = saver;
    return saver;
}
