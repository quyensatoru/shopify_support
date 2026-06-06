import type { DbSource } from '@shopify-support/shared';
import type { DbAdapter } from './base.adapter.js';
import { SqlAdapter } from './sql.adapter.js';
import { MongoAdapter } from './mongo.adapter.js';
import { RedisAdapter } from './redis.adapter.js';
import { RabbitMQAdapter } from './rabbitmq.adapter.js';

export function getAdapter(source: DbSource): DbAdapter {
  switch (source.type) {
    case 'sql':
      return new SqlAdapter(source.connectionString);
    case 'mongo':
      return new MongoAdapter(source.connectionString);
    case 'redis':
      return new RedisAdapter(source.connectionString);
    case 'rabbitmq':
      return new RabbitMQAdapter(source.connectionString, source.mgmtUrl);
    default:
      throw new Error(`Unknown DB source type: ${(source as DbSource).type}`);
  }
}

export type { DbAdapter } from './base.adapter.js';
