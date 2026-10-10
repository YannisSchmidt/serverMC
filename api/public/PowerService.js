/**
 * PowerService - the one and only action a stranger may trigger from the internet.
 *
 * The public listener is read-only by design (status, health, page). This service
 * adds exactly one write route: "the server is off, wake it up", guarded by a
 * shared code that the host tells their friends. Everything else - console,
 * files, backups, players, stop, KILL - stays behind the admin panel on
 * 127.0.0.1, and this file has no way to reach any of it: it may only call
 * `minecraft.startServer()`, the same call the Dashboard START button makes.
 *
 * Threats it has to survive, and what it does about each:
 *   - guessing the code          → per-IP attempt counter with a window (429),
 *                                  constant-time comparison of fixed-length digests
 *   - the code leaking           → never logged, never echoed, never in a URL, a
 *                                  response, `details` or the served JS; and
 *                                  `redact.js` masks the key name itself
 *   - a cross-site form POST     → the route demands `Content-Type: application/json`,
 *                                  which an HTML form cannot set; a real fetch with
 *                                  that type triggers a CORS preflight, which this
 *                                  app never answers - so the browser blocks it
 *   - no credentials, so no CSRF → the code IS the credential; that is why a wrong
 *                                  attempt has to be expensive and rate limited
 *   - an unconfigured host       → an empty code closes the door (503) and the
 *                                  doctor says so instead of showing a dead button
 *   - a half-installed server    → the real preflight of MinecraftService runs; a
 *                                  blocker is logged in full *here* and reported to
 *                                  the visitor as one generic sentence, so no path,
 *                                  no Java version and no install detail leaves this
 *                                  process
 */

import crypto from 'node:crypto';
import { AppError } from '../util/errors.js';
import { STATES } from '../minecraft/MinecraftService.js';

/** Longest accepted code; longer input is refused instead of hashed. */
const MAX_CODE_LENGTH = 128;

export class PowerService {
  constructor({ config, logs, minecraft }) {
    this.config = config;
    this.log = logs.application.child('public');
    this.minecraft = minecraft;
    /** ip -> { count, firstAt } for wrong codes (and for blocked starts). */
    this.attempts = new Map();
    this.started = 0;
  }

  get settings() {
    return this.config.values.public || {};
  }

  /** The switch the host controls. */
  get enabled() {
    return this.settings.enabled !== false && this.settings.allow_power_on === true;
  }

  /** A code is only a door if somebody wrote one. */
  get configured() {
    return String(this.settings.wake_code || '').trim().length > 0;
  }

  /** What the public page is allowed to know: is there a button at all. */
  capabilities() {
    const reason = !this.settings.enabled
      ? 'public-disabled'
      : !this.settings.allow_power_on
        ? 'switched-off'
        : !this.configured
          ? 'no-code'
          : null;
    return { power_available: this.enabled && this.configured, reason };
  }

  /** State for the doctor and the panel card - no secret, no code length. */
  status() {
    return {
      ...this.capabilities(),
      enabled: this.enabled,
      configured: this.configured,
      max_attempts: this.maxAttempts,
      window_minutes: this.windowMinutes,
      blocked_ips: [...this.attempts.entries()].filter(([, v]) => v.count >= this.maxAttempts).length,
      wake_ups: this.started,
    };
  }

  get maxAttempts() {
    return Math.max(1, Number(this.settings.power_code_max_attempts) || 5);
  }

  get windowMinutes() {
    return Math.max(1, Number(this.settings.power_code_window_min) || 10);
  }

  // ------------------------------------------------------------------ attempts

  /** Drop old windows, then answer whether this IP may try again. */
  allowance(ip) {
    const now = Date.now();
    const windowMs = this.windowMinutes * 60 * 1000;
    const entry = this.attempts.get(ip);
    if (!entry) return { blocked: false, remaining: this.maxAttempts };
    if (now - entry.firstAt > windowMs) {
      this.attempts.delete(ip);
      return { blocked: false, remaining: this.maxAttempts };
    }
    return {
      blocked: entry.count >= this.maxAttempts,
      remaining: Math.max(0, this.maxAttempts - entry.count),
      retryMinutes: Math.max(1, Math.ceil((windowMs - (now - entry.firstAt)) / 60000)),
    };
  }

  recordAttempt(ip) {
    const entry = this.attempts.get(ip);
    if (!entry || Date.now() - entry.firstAt > this.windowMinutes * 60000) {
      this.attempts.set(ip, { count: 1, firstAt: Date.now() });
      return;
    }
    entry.count += 1;
  }

  clearAttempts(ip) {
    this.attempts.delete(ip);
  }

  /**
   * Constant-time check of a fixed-length digest, so neither the length nor a
   * differing prefix becomes a side channel.
   */
  codeMatches(submitted) {
    const expected = String(this.settings.wake_code || '');
    const a = crypto.createHash('sha256').update(normalizeCode(submitted)).digest();
    const b = crypto.createHash('sha256').update(normalizeCode(expected)).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // -------------------------------------------------------------------- request

  /**
   * @param {string} code   the code typed by the player
   * @param {string} ip      the requester's IP (trust_proxy already applied by the caller)
   * @returns {Promise<{started: boolean, state: string, message: string}>}
   */
  async request({ code, ip }) {
    if (this.settings.enabled === false) {
      throw new AppError('The public page is disabled on this server.', { code: 'PUBLIC_DISABLED', status: 503 });
    }
    if (!this.settings.allow_power_on) {
      throw new AppError('Starting the server from the public page is switched off.', {
        code: 'POWER_DISABLED', status: 403,
        hint: 'The host can turn it on in the admin panel (Public page -> Player wake-up).',
      });
    }
    if (!this.configured) {
      throw new AppError('No wake-up code has been chosen yet, so the door is closed.', {
        code: 'WAKE_NOT_CONFIGURED', status: 503,
        hint: 'The host must set [public].wake_code in config/config.toml before players can start the server.',
      });
    }

    const allowance = this.allowance(ip);
    if (allowance.blocked) {
      throw new AppError(`Too many wrong codes from this network. Try again in about ${allowance.retryMinutes} minute(s).`, {
        code: 'POWER_RATE_LIMITED', status: 429,
      });
    }

    if (typeof code !== 'string' || !code.trim()) {
      throw new AppError('Type the wake-up code you were given.', { code: 'POWER_CODE_MISSING', status: 400 });
    }
    if (code.length > MAX_CODE_LENGTH) {
      throw new AppError('That code is too long to be the one you were given.', { code: 'VALIDATION_ERROR', status: 400 });
    }

    if (!this.codeMatches(code)) {
      this.recordAttempt(ip);
      const left = this.allowance(ip).remaining;
      this.log.warn(`A wake-up request from ${ip} was refused (wrong code, ${left} attempt(s) left in this window).`);
      throw new AppError(left > 0 ? 'That is not the wake-up code.' : 'That is not the wake-up code, and this network is now paused.', {
        code: 'POWER_CODE_INVALID', status: 403,
      });
    }

    // Right code: from here on the attempt counter must not punish a legitimate
    // player whose friend typed the code a minute earlier.
    this.clearAttempts(ip);

    const state = this.minecraft.state;
    if (state === STATES.ONLINE) {
      return { started: false, state, message: 'The server is already online - just connect.' };
    }
    if (state === STATES.STARTING || state === STATES.STOPPING) {
      return { started: false, state, message: 'The server is already on its way. Give it a moment.' };
    }

    let status;
    try {
      // Exactly the panel's START: preflight (EULA, Java, install), then the
      // process, then e4mc because [e4mc].autostart_with_server says so.
      status = await this.minecraft.startServer({ reason: 'public wake-up code' });
    } catch (err) {
      // The cause is for the host, not for the visitor: a preflight blocker can
      // carry paths and version strings.
      this.log.error(`A wake-up request from ${ip} could not start the server: ${err?.message || err}`);
      throw new AppError('The server could not be started. The host has been notified in the panel and the logs.', {
        code: 'SERVER_START_FAILED', status: 502,
        hint: 'Ask whoever runs this server to open the admin panel (Dashboard) or run `node api/cli.js doctor`.',
      });
    }

    this.started += 1;
    this.log.info(`A wake-up request from ${ip} started the Minecraft server.`);
    return {
      started: true,
      state: status?.state || STATES.STARTING,
      message: 'The server is starting. It usually takes up to a minute, then the address below works.',
    };
  }

  /** Called by the panel's cleanup or on config change; keeps memory bounded. */
  prune() {
    const windowMs = this.windowMinutes * 60000;
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      if (now - entry.firstAt > windowMs) this.attempts.delete(ip);
    }
  }
}

/**
 * Codes are typed on phones: surrounding spaces and case differences are not
 * meaningful, so they are removed before hashing. Digits and hyphens stay.
 */
function normalizeCode(value) {
  return String(value ?? '').trim().toLowerCase();
}
