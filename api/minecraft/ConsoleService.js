/**
 * Console ring buffer + live subscribers.
 *
 * The Minecraft console is streamed to the panel over SSE. Lines are kept in
 * a bounded ring buffer so the Console page can render history instantly and
 * so a reconnecting client can resume with the last sequence number it saw.
 */

import { EventEmitter } from 'node:events';
import { stripFormatting } from './LogParser.js';

export const MAX_LINES_DEFAULT = 5000;

export class ConsoleService extends EventEmitter {
  constructor({ maxLines = MAX_LINES_DEFAULT, logs = null, channel = 'minecraft' } = {}) {
    super();
    this.setMaxListeners(0);
    this.maxLines = maxLines;
    this.lines = [];
    this.seq = 0;
    this.logs = logs;
    this.channel = channel;
    this.dropped = 0;
    this.clearedAt = null;
  }

  /**
   * Append a line.
   * @param {string} text raw line
   * @param {{stream?: 'stdout'|'stderr'|'system'|'input', level?: string, at?: Date}} meta
   */
  append(text, { stream = 'stdout', level = null, at = new Date(), source = null } = {}) {
    const clean = stripFormatting(text).replace(/\r$/, '');
    if (clean.trim() === '' && stream === 'stdout') return null;
    this.seq += 1;
    const entry = {
      seq: this.seq,
      ts: at.toISOString(),
      stream,
      level,
      text: clean,
      source: source || this.channel,
    };
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) {
      this.dropped += this.lines.length - this.maxLines;
      this.lines.splice(0, this.lines.length - this.maxLines);
    }

    // Persist the Minecraft console to logs/minecraft.log (never the other way
    // around: the log file must not be able to inject console lines).
    if (this.logs && stream !== 'input') {
      const logger = this.logs.minecraft;
      const method = level === 'ERROR' || level === 'FATAL' || stream === 'stderr' ? 'warn' : 'info';
      logger[method](clean);
    }
    this.emit('line', entry);
    return entry;
  }

  /** Lines newer than `sinceSeq` (used for SSE resume). */
  since(sinceSeq = 0, { limit = 2000 } = {}) {
    const out = [];
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      if (this.lines[i].seq <= sinceSeq) break;
      out.push(this.lines[i]);
      if (out.length >= limit) break;
    }
    return out.reverse();
  }

  tail(limit = 300) {
    return this.lines.slice(-Math.max(1, Math.min(limit, this.maxLines)));
  }

  subscribe(handler, { sinceSeq = 0 } = {}) {
    for (const entry of this.since(sinceSeq)) handler(entry);
    this.on('line', handler);
    return () => this.off('line', handler);
  }

  search(query, { limit = 500, caseSensitive = false } = {}) {
    const needle = caseSensitive ? String(query) : String(query).toLowerCase();
    if (!needle) return [];
    const results = [];
    for (let i = this.lines.length - 1; i >= 0 && results.length < limit; i -= 1) {
      const line = this.lines[i];
      const haystack = caseSensitive ? line.text : line.text.toLowerCase();
      if (haystack.includes(needle)) results.push(line);
    }
    return results.reverse();
  }

  /** "Clear" only affects the in-memory view; logs on disk stay untouched. */
  clear() {
    this.clearedAt = new Date().toISOString();
    this.lines = [];
    this.emit('cleared', { at: this.clearedAt });
    return { clearedAt: this.clearedAt };
  }

  toText({ lines = this.maxLines } = {}) {
    return this.tail(lines).map((l) => `[${l.ts}] ${l.stream === 'input' ? '> ' : ''}${l.text}`).join('\n');
  }

  stats() {
    return {
      lines: this.lines.length,
      maxLines: this.maxLines,
      seq: this.seq,
      dropped: this.dropped,
      subscribers: this.listenerCount('line'),
      clearedAt: this.clearedAt,
    };
  }
}
