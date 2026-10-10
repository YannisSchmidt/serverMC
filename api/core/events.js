/**
 * Central event hub.
 *
 * Every service publishes state changes here; the HTTP layer (SSE) and the CLI
 * subscribe. This is what keeps the UI real-time without polling: console
 * lines, server status, metrics, e4mc/cloudflare state and long running job
 * progress all travel through this bus.
 */

import { EventEmitter } from 'node:events';

export const EVENTS = {
  STATUS: 'status',              // Minecraft server state changed
  CONSOLE: 'console',            // a console line (log or command echo)
  METRICS: 'metrics',            // periodic TPS/RAM/CPU/players sample
  PLAYERS: 'players',            // player list changed
  E4MC: 'e4mc',                  // e4mc relay state/address changed
  CLOUDFLARE: 'cloudflare',      // Cloudflare/tunnel state changed
  JOB: 'job',                    // install/backup/restore progress
  LOG: 'log',                    // application log record
  SETTINGS: 'settings',          // configuration changed
  MONITOR_ALERT: 'monitor',      // MSPT monitor raised or cleared an alert
  RESTART: 'restart',            // a scheduled restart progressed
  READY: 'ready',                // panel finished booting
};

const RING_SIZE = 200;

export class EventHub extends EventEmitter {
  constructor({ ringSize = RING_SIZE } = {}) {
    super();
    this.setMaxListeners(0);
    this.ring = [];
    this.ringSize = ringSize;
    this.seq = 0;
  }

  /**
   * Publish an event. Every payload gets a monotonically increasing id so SSE
   * clients can resume with Last-Event-ID after a reconnect.
   */
  publish(type, payload = {}) {
    this.seq += 1;
    const event = { id: this.seq, type, ts: Date.now(), payload };
    this.ring.push(event);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.emit(type, payload, event);
    this.emit('*', event);
    return event;
  }

  /** Replay events newer than `lastId` (used by SSE reconnect). */
  since(lastId = 0, { types = null } = {}) {
    return this.ring.filter((e) => e.id > lastId && (!types || types.includes(e.type)));
  }

  subscribe(types, handler) {
    const list = Array.isArray(types) ? types : [types];
    for (const type of list) this.on(type, handler);
    return () => {
      for (const type of list) this.off(type, handler);
    };
  }
}
