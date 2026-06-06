import type { DbAdapter } from './base.adapter.js';

type RabbitMQQueueInfo = {
  name: string;
  messages: number;
  messages_ready: number;
  messages_unacknowledged: number;
  consumers: number;
  state: string;
};

export class RabbitMQAdapter implements DbAdapter {
  private mgmtUrl: string;
  private headers: Record<string, string>;

  constructor(connectionString: string, mgmtUrl?: string) {
    // mgmtUrl like http://user:pass@host:15672
    this.mgmtUrl = mgmtUrl ?? this.inferMgmtUrl(connectionString);
    const { username, password } = this.parseCredentials(this.mgmtUrl);
    this.headers = {
      'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
  }

  private inferMgmtUrl(amqpUrl: string): string {
    return amqpUrl.replace(/^amqps?:\/\//, 'http://').replace(/:5672/, ':15672').replace(/:5671/, ':15671');
  }

  private parseCredentials(url: string): { username: string; password: string } {
    try {
      const u = new URL(url);
      return { username: u.username || 'guest', password: u.password || 'guest' };
    } catch {
      return { username: 'guest', password: 'guest' };
    }
  }

  private mgmtApiUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return url;
    }
  }

  async readSchema(queue: string): Promise<unknown> {
    return this.queueInspect(queue);
  }

  async checkExists(_target: string, queue: string): Promise<{ exists: boolean; sample?: unknown }> {
    const info = await this.queueInspect(queue);
    return { exists: info !== null, sample: info };
  }

  async count(_target: string, queue: string): Promise<number> {
    const info = await this.queueInspect(queue) as RabbitMQQueueInfo | null;
    return info?.messages ?? 0;
  }

  async queueInspect(queue: string): Promise<unknown> {
    const base = this.mgmtApiUrl(this.mgmtUrl);
    const vhost = '%2F';
    const url = `${base}/api/queues/${vhost}/${encodeURIComponent(queue)}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return null;
    return res.json();
  }

  async peekMessages(queue: string, n: number): Promise<unknown[]> {
    const base = this.mgmtApiUrl(this.mgmtUrl);
    const vhost = '%2F';
    const url = `${base}/api/queues/${vhost}/${encodeURIComponent(queue)}/get`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ count: n, ackmode: 'ack_requeue_true', encoding: 'auto' }),
    });
    if (!res.ok) return [];
    return res.json() as Promise<unknown[]>;
  }

  async close(): Promise<void> {
    // No persistent connection for HTTP-based Management API
  }
}
