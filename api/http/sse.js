/**
 * Server-Sent Events helpers.
 *
 * The panel streams console lines, server status, metrics, e4mc and Cloudflare
 * state over one SSE connection per client - no aggressive polling, and a
 * reconnect resumes from the last event id the browser received.
 */

export class SseHub {
  constructor({ events, heartbeatMs = 25000 }) {
    this.events = events;
    this.clients = new Set();
    this.heartbeatMs = heartbeatMs;
    this.startedAt = Date.now();
    this.totals = { connections: 0, events: 0 };
    this.lastPayloads = new Map();
  }

  /**
   * Attach a client and stream events.
   * @param {object} options
   * @param {import('node:http').ServerResponse} options.res
   * @param {number} options.lastEventId
   * @param {string[]} options.types event types to forward
   */
  handle({ req, res, lastEventId = 0, types = null }) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`retry: 3000\n\n`);

    const client = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, res, types, connectedAt: Date.now() };
    this.clients.add(client);
    this.totals.connections += 1;

    // Replay what the client missed (console lines and status changes).
    for (const event of this.events.since(Number(lastEventId) || 0, { types })) {
      this.write(client, event);
    }
    // Then send the current known state so a fresh page renders immediately.
    for (const [type, payload] of this.lastPayloads) {
      if (!types || types.includes(type)) this.write(client, { id: 0, type, ts: Date.now(), payload });
    }

    const onEvent = (event) => {
      if (!types || types.includes(event.type)) this.write(client, event);
    };
    this.events.on('*', onEvent);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        cleanup();
      }
    }, this.heartbeatMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.events.off('*', onEvent);
      this.clients.delete(client);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('close', cleanup);
    return client;
  }

  /** Remember the latest payload per type so new clients get the state at once. */
  remember(type, payload) {
    this.lastPayloads.set(type, payload);
  }

  write(client, event) {
    if (client.res.writableEnded) return false;
    const data = JSON.stringify({
      type: event.type,
      ts: event.ts,
      payload: event.payload,
    });
    try {
      client.res.write(`id: ${event.id || 0}\nevent: ${event.type}\ndata: ${data}\n\n`);
      this.totals.events += 1;
      return true;
    } catch {
      this.clients.delete(client);
      return false;
    }
  }

  broadcastLocal(type, payload) {
    const event = { id: 0, type, ts: Date.now(), payload };
    for (const client of this.clients) {
      if (!client.types || client.types.includes(type)) this.write(client, event);
    }
  }

  stats() {
    return {
      clients: this.clients.size,
      totalConnections: this.totals.connections,
      totalEvents: this.totals.events,
      uptimeMs: Date.now() - this.startedAt,
      clientDetails: [...this.clients].map((c) => ({ id: c.id, types: c.types, connectedAt: new Date(c.connectedAt).toISOString(), sinceId: c.lastEventId || 0 })),
    };
  }

  closeAll() {
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
