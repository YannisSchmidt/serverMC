/**
 * DiscordService - webhook notifications for what happens on the server.
 *
 * Everything is real: a message is a genuine HTTP POST to the Discord webhook
 * configured by the user, and a failure (bad URL, deleted webhook, rate limit,
 * no internet) is reported as such instead of being swallowed.
 *
 * Security rules that this service enforces:
 *   - the webhook URL is a secret: it is masked by the API layer, never logged,
 *     never included in an error message and never sent back to the browser;
 *   - nothing that a player typed is ever forwarded verbatim to Discord:
 *     player names, block ids and messages are length-capped and stripped of
 *     the characters that could forge a mention or a link;
 *   - the service only talks to discord.com (and its canary/ptb hosts): a
 *     webhook URL pointing anywhere else is refused at load time.
 *
 * Rate limits: Discord allows ~5 requests per second per webhook and answers
 * 429 with a `retry_after`. The service keeps a small queue, spaces the posts
 * and honours retry_after, so a burst of events can never get the webhook
 * banned.
 */

import { EVENTS } from '../core/events.js';
import { AppError } from '../util/errors.js';
import { redactString } from '../util/redact.js';

/** Hosts that may receive a webhook POST. */
export const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com', 'discord.gg'];

/**
 * A Discord webhook URL, verified against the documented shape:
 *   https://discord.com/api/webhooks/<id>/<token>
 * The token part is deliberately not matched: it must never be echoed.
 */
export const DISCORD_WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/i;

/** Every event the service can post, and whether it is enabled by default. */
export const EVENT_LABELS = {
  server_start: 'Minecraft server started',
  server_stop: 'Minecraft server stopped',
  server_crash: 'Minecraft server crashed',
  player_join: 'A player joined',
  player_leave: 'A player left',
  backup: 'A backup was created',
  restore: 'A backup was restored',
  mod: 'A mod was installed or removed',
  e4mc: 'The e4mc public address changed',
  cloudflare: 'The Cloudflare tunnel changed state',
  performance: 'Performance alert (MSPT above the threshold)',
};

export const DISCORD_EVENT_NAMES = Object.keys(EVENT_LABELS);

/** Discord embed limits (https://discord.com/developers/docs/resources/channel#embed-object). */
const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  fields: 25,
  total: 6000,
};

const COLOURS = {
  ok: 0x2ecc71,       // green
  info: 0x3498db,     // blue
  warn: 0xf1c40f,     // yellow
  error: 0xe74c3c,    // red
};

/**
 * Sanitize a value that comes from the outside world (a player name, a log
 * line) before it is embedded in a Discord message.
 *
 * Discord renders @everyone, @here, <#id> channels and https:// links, so a
 * player called "everyone" or a log line containing a webhook URL must not be
 * able to mention or to leak anything. Mentions are neutralised, control
 * characters and zero-width characters are removed, and the text is capped.
 */
export function sanitizeText(value, max = 1024) {
  let text = String(value ?? '');
  // Control characters (newlines included) collapse into spaces.
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Zero-width and bidi-override characters can hide a mention.
  text = text.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
  // A literal @ would be rendered as a mention when the name happens to match.
  text = text.replace(/@/g, '@\u200b');
  // Strip anything that looks like a URL, so a log line cannot leak an address.
  text = text.replace(/https?:\/\/\S+/gi, '[link removed]');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Clamp a string to a Discord limit. */
function clamp(value, max) {
  const text = sanitizeText(value, max);
  return text;
}

/** Build the webhook payload of one notification. */
export function buildPayload({ title, description, fields = [], colour = 'info', footer = null, url = null, mentionRoleId = '' }) {
  const embed = {
    title: clamp(title, LIMITS.title),
    description: clamp(description, LIMITS.description),
    color: COLOURS[colour] ?? COLOURS.info,
    fields: fields.slice(0, LIMITS.fields).map((field) => ({
      name: clamp(field.name, LIMITS.fieldName),
      value: clamp(field.value, LIMITS.fieldValue),
      inline: Boolean(field.inline),
    })),
    timestamp: new Date().toISOString(),
  };
  if (footer) embed.footer = { text: clamp(footer, LIMITS.footer) };
  if (url) embed.url = url;
  const payload = { embeds: [embed] };
  const mention = String(mentionRoleId || '').trim();
  if (mention) payload.content = `<@&${mention}>`;
  return payload;
}

/** How long the queue keeps a message when Discord refuses it. */
const QUEUE_LIMIT = 100;
const SPACING_MS = 1200;

export class DiscordService {
  constructor({ config, logs, events = null, fetchImpl = null, spacingMs = SPACING_MS }) {
    this.config = config;
    this.logs = logs;
    this.log = logs?.application?.child('discord');
    this.events = events;
    this.fetchImpl = fetchImpl || ((url, options) => fetch(url, options));
    this.queue = [];
    this.timer = null;
    this.busy = false;
    this.stopped = false;
    // Space between two posts: Discord allows about five per second per
    // webhook. Configurable so a test does not have to wait two minutes.
    this.spacingMs = Math.max(0, Number(spacingMs) || 0);
    this.stats = {
      queued: 0,
      sent: 0,
      failed: 0,
      dropped: 0,
      lastDeliveryAt: null,
      lastError: null,
      lastRetryAfterMs: null,
    };
    this.unsubscribes = [];
  }

  // ------------------------------------------------------------------ config

  get values() {
    return this.config.values.discord;
  }

  get enabled() {
    return Boolean(this.values.enabled && String(this.values.webhook_url || '').trim());
  }

  /** The webhook host, which is safe to display (never the path/token). */
  webhookHost() {
    const url = String(this.values.webhook_url || '').trim();
    if (!url) return null;
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  /** Status for the API: never contains the webhook URL or its token. */
  status() {
    const v = this.values;
    return {
      enabled: Boolean(v.enabled),
      configured: Boolean(String(v.webhook_url || '').trim()),
      host: this.webhookHost(),
      events: [...(v.events || [])],
      availableEvents: DISCORD_EVENT_NAMES,
      mentionRoleId: String(v.mention_role_id || '').trim() || null,
      username: v.username || '',
      queue: this.queue.length,
      ...this.stats,
      lastError: this.stats.lastError ? { message: this.stats.lastError, at: this.stats.lastErrorAt } : null,
    };
  }

  // ----------------------------------------------------------------- lifecycle

  /**
   * Subscribe to the event hub. Everything the panel already publishes is
   * translated into a Discord message, so no service has to know about Discord.
   */
  start() {
    if (!this.events) return;
    const on = (type, handler) => this.unsubscribes.push(this.events.subscribe(type, handler));
    on(EVENTS.STATUS, (payload) => {
      if (payload?.state === 'online' && payload?.reason !== 'already running') {
        // The first "online" of a start is published with a reason by the
        // Minecraft service; a plain state change (crash recovery, restore)
        // is reported too, without spamming on every re-emit.
        this.notify('server_start', {
          title: 'Server online',
          description: `The Minecraft server is now online (${payload.state}).`,
          fields: this.versionFields(payload),
          colour: 'ok',
        });
      }
      if (payload?.state === 'stopped') {
        this.notify('server_stop', {
          title: 'Server stopped',
          description: `The Minecraft server stopped (${payload.reason || 'no reason given'}).`,
          colour: 'info',
        });
      }
      if (payload?.state === 'error') {
        this.notify('server_crash', {
          title: 'Server error',
          description: sanitizeText(payload?.reason || payload?.error?.message || 'The Minecraft server reported a failure.', 500),
          colour: 'error',
        });
      }
    });
    on(EVENTS.PLAYERS, (payload) => {
      if (payload?.action === 'join') {
        this.notify('player_join', {
          title: 'Player joined',
          description: `${sanitizeText(payload.player, 32)} joined the server.`,
          fields: [{ name: 'Players online', value: String(payload.players?.length ?? '?'), inline: true }],
          colour: 'ok',
        });
      }
      if (payload?.action === 'leave') {
        this.notify('player_leave', {
          title: 'Player left',
          description: `${sanitizeText(payload.player, 32)} left the server${payload.reason ? ` (${sanitizeText(payload.reason, 120)})` : ''}.`,
          fields: [{ name: 'Players online', value: String(payload.players?.length ?? '?'), inline: true }],
          colour: 'info',
        });
      }
    });
    on(EVENTS.JOB, (payload) => {
      if (payload?.job === 'backup' && payload?.state === 'done') {
        this.notify('backup', {
          title: 'Backup created',
          description: sanitizeText(payload.file || payload.name || 'A backup was created.', 200),
          colour: 'ok',
        });
      }
      if (payload?.job === 'restore' && payload?.state === 'done') {
        this.notify('restore', {
          title: 'Backup restored',
          description: `${sanitizeText(payload.file || payload.name || 'A backup was restored.', 200)} was restored.`,
          colour: 'warn',
        });
      }
      if (payload?.job === 'mods' && payload?.state === 'changed') {
        this.notify('mod', {
          title: 'Mods changed',
          description: `${sanitizeText(payload.file, 200)} was ${sanitizeText(payload.action, 40)}.`,
          colour: payload.action === 'deleted' ? 'warn' : 'ok',
        });
      }
    });
    on(EVENTS.E4MC, (payload) => {
      if (payload?.state === undefined) return;
      if (payload.state === 'online' && payload.address) {
        this.notify('e4mc', {
          title: 'e4mc address ready',
          description: `Players can join with \`${sanitizeText(payload.address, 120)}\`.`,
          colour: 'ok',
        });
      } else if (payload.state === 'error' || payload.state === 'stopped') {
        this.notify('e4mc', {
          title: 'e4mc relay stopped',
          description: sanitizeText(payload.error?.message || payload.reason || 'The e4mc relay is not running.', 300),
          colour: 'warn',
        });
      }
    });
    on(EVENTS.CLOUDFLARE, (payload) => {
      if (payload?.state === undefined) return;
      this.notify('cloudflare', {
        title: 'Cloudflare tunnel',
        description: sanitizeText(`State: ${payload.state}${payload.url ? ` (${payload.url})` : ''}${payload.error?.message ? ` - ${payload.error.message}` : ''}`, 400),
        colour: payload.state === 'error' ? 'error' : 'info',
      });
    });
    on(EVENTS.MONITOR_ALERT, (payload) => {
      if (payload?.kind !== 'performance') return;
      this.notify('performance', {
        title: payload.state === 'recovered' ? 'Performance back to normal' : 'Performance alert',
        description: sanitizeText(payload.message || '', 500),
        fields: payload.fields || [],
        colour: payload.state === 'recovered' ? 'ok' : 'error',
        mention: payload.state !== 'recovered',
      });
    });
    this.log?.debug?.('Discord notifications subscribed to the event hub.');
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.queue = [];
  }

  versionFields(payload) {
    const versions = payload?.versions || {};
    const fields = [];
    if (versions.minecraft) fields.push({ name: 'Minecraft', value: versions.minecraft, inline: true });
    if (versions.neoforge) fields.push({ name: 'NeoForge', value: versions.neoforge, inline: true });
    return fields;
  }

  // ----------------------------------------------------------------- delivery

  /** Queue a notification. Returns false when the event is not enabled. */
  notify(event, { title, description, fields = [], colour = 'info', mention = false, url = null }) {
    if (!this.enabled) return false;
    const events = this.values.events || [];
    if (!events.includes(event)) return false;
    const payload = buildPayload({
      title,
      description,
      fields,
      colour,
      url,
      mentionRoleId: mention ? this.values.mention_role_id : '',
    });
    if (this.queue.length >= QUEUE_LIMIT) {
      // Discord is down or rate limited: keep the newest, drop the oldest.
      this.queue.shift();
      this.stats.dropped += 1;
    }
    this.queue.push({ event, payload });
    this.stats.queued += 1;
    this.schedule();
    return true;
  }

  schedule() {
    if (this.timer || this.busy || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, 50);
  }

  /** Send the queued messages, one at a time, honouring the Discord limits. */
  async drain() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.stopped) {
        const item = this.queue[0];
        const result = await this.post(item.payload);
        if (result.retryAfterMs) {
          // Rate limited: wait and try the same message again.
          this.stats.lastRetryAfterMs = result.retryAfterMs;
          await new Promise((resolve) => setTimeout(resolve, Math.min(result.retryAfterMs, 60_000)));
          continue;
        }
        this.queue.shift();
        if (result.ok) {
          this.stats.sent += 1;
          this.stats.lastDeliveryAt = new Date().toISOString();
          this.stats.lastError = null;
          this.stats.lastErrorAt = null;
        } else {
          this.stats.failed += 1;
          this.stats.lastError = result.error;
          this.stats.lastErrorAt = new Date().toISOString();
          this.log?.warn?.(`Discord notification "${item.event}" failed: ${result.error}`);
        }
        if (this.queue.length && this.spacingMs) await new Promise((resolve) => setTimeout(resolve, this.spacingMs));
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * One webhook POST. Returns {ok} or {error, retryAfterMs}.
   *
   * The webhook URL is never put in the error message: `redactString` would
   * mask the token part anyway, but the error only ever carries the HTTP
   * status and the Discord error text, which is what the admin needs.
   */
  async post(payload) {
    const url = String(this.values.webhook_url || '').trim();
    if (!DISCORD_WEBHOOK_RE.test(url)) {
      return { ok: false, error: 'The Discord webhook URL is missing or invalid.' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'minecraft-neoforge-panel/1.0' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.('retry-after') || 1);
        const retryMs = Number.isFinite(retryAfter) ? Math.max(250, retryAfter * 1000) : 1000;
        return { ok: false, error: `Discord rate limited the webhook (HTTP 429, retry after ${retryMs} ms).`, retryAfterMs: retryMs };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { ok: false, error: this.explainStatus(response.status, body) };
      }
      return { ok: true };
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      return {
        ok: false,
        error: aborted
          ? 'Discord did not answer within 10 seconds (the webhook is unreachable or blocked).'
          : `The webhook request failed: ${err?.message || 'unknown network error'}.`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Turn a Discord HTTP error into something an admin can act on. */
  explainStatus(status, body) {
    const text = String(body || '').slice(0, 300);
    if (status === 401 || status === 404) {
      return `Discord refused the webhook (HTTP ${status}): the webhook was deleted or its URL is wrong. Recreate it in the channel settings (Integrations -> Webhooks).`;
    }
    if (status === 400) {
      return `Discord rejected the message (HTTP 400): ${text || 'the payload is invalid.'}`;
    }
    if (status === 403) {
      return `Discord forbade the message (HTTP 403): the webhook is not allowed to post in that channel.`;
    }
    if (status >= 500) {
      return `Discord is having problems (HTTP ${status}). The message was dropped; the next event will try again.`;
    }
    return `Discord answered HTTP ${status}: ${text || 'unexpected answer.'}`;
  }

  /**
   * Send a real test message. Used by the Settings page button and by the CLI:
   * it proves the webhook works instead of claiming it does.
   */
  async sendTest() {
    if (!this.enabled) {
      throw new AppError('Discord notifications are disabled: enable [discord] and set a webhook_url first.', {
        code: 'DISCORD_DISABLED',
        status: 409,
        hint: 'Settings -> Discord, or DISCORD_ENABLED=true + DISCORD_WEBHOOK_URL=... in .env.',
      });
    }
    const result = await this.post(buildPayload({
      title: 'Test message',
      description: 'If you can read this in Discord, the notifications of your Minecraft panel work.',
      fields: [
        { name: 'Server', value: this.config.values.server.name || 'Minecraft Server', inline: true },
        { name: 'Sent by', value: 'the local admin panel', inline: true },
      ],
      colour: 'ok',
      footer: 'Sent by the Minecraft server panel (localhost)',
    }));
    if (!result.ok) {
      throw new AppError(`The test message could not be delivered: ${result.error}`, {
        code: 'DISCORD_TEST_FAILED',
        status: 502,
        hint: 'Check the webhook URL, that the channel still exists, and that this machine can reach discord.com.',
      });
    }
    this.stats.sent += 1;
    this.stats.lastDeliveryAt = new Date().toISOString();
    this.stats.lastError = null;
    return { ok: true, message: `Test message delivered to Discord (${this.webhookHost()}).` };
  }

  /** Never log a value that could contain the webhook URL. */
  static redact(text) {
    return redactString(String(text ?? ''));
  }
}

export default DiscordService;
