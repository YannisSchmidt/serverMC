/**
 * AuthService - admin authentication for the local panel.
 *
 * Design
 *   - one admin account, password stored as scrypt hash (config/auth.json, 0600)
 *   - a strong random password is generated on first run and printed once in
 *     the terminal (the file never contains the clear-text password)
 *   - sessions live in memory only: restarting the panel logs everybody out
 *   - session cookie: HttpOnly, SameSite=Strict, Secure when HTTPS is detected
 *   - CSRF: double submit token (cookie readable by the JS app + header)
 *   - login rate limiting with a sliding window per IP
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { AppError, UnauthorizedError, ForbiddenError, RateLimitError } from '../util/errors.js';
import { readJson, writeFileAtomic, ensureDir } from '../util/fsx.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'mcpanel_session';
export const CSRF_COOKIE = 'mcpanel_csrf';

export function hashPassword(password, { username = 'admin' } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalize(username, password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored, { username = 'admin' } = {}) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(normalize(username, password), salt, expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * Number(N) * Number(r) * 2 });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function normalize(username, password) {
  return `${username}:${password}`;
}

export function generatePassword(length = 20) {
  // Avoid ambiguous characters so the password can be typed from the terminal.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i += 1) {
    const value = bytes[i];
    if (value < 256 - (256 % alphabet.length)) out += alphabet[value % alphabet.length];
  }
  if (!/[A-Z]/.test(out)) out = `A${out.slice(1)}`;
  if (!/[a-z]/.test(out)) out = `${out.slice(0, 1)}a${out.slice(2)}`;
  if (!/[0-9]/.test(out)) out = `${out.slice(0, 2)}7${out.slice(3)}`;
  return out;
}

export function isWeakPassword(password) {
  if (typeof password !== 'string') return 'Password must be a string.';
  if (password.length < 12) return 'The password must be at least 12 characters long.';
  if (password.length > 256) return 'The password must be at most 256 characters long.';
  const common = ['password', 'admin', 'minecraft', 'letmein', 'changeme', '123456', 'qwerty', 'panel'];
  const lower = password.toLowerCase();
  if (common.some((c) => lower.includes(c))) return 'The password contains a well known word; choose something less predictable.';
  if (/^(.)\1+$/.test(password)) return 'The password is a single repeated character.';
  return null;
}

/** Sliding window rate limiter (per key, in memory). */
export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, list);
    if (list.length >= this.max) {
      const retryAfterMs = this.windowMs - (now - list[0]);
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs), attempts: list.length, max: this.max };
    }
    return { allowed: true, remaining: this.max - list.length, attempts: list.length, max: this.max };
  }

  hit(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    return list.length;
  }

  reset(key) {
    this.hits.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [key, list] of this.hits) {
      const fresh = list.filter((t) => now - t < this.windowMs);
      if (fresh.length) this.hits.set(key, fresh);
      else this.hits.delete(key);
    }
  }

  get size() {
    return this.hits.size;
  }
}

export class AuthService {
  constructor({ config, logs, events }) {
    this.config = config;
    this.log = logs.application.child('auth');
    this.events = events;
    this.sessions = new Map();
    this.loginLimiter = new RateLimiter({
      max: config.values.security.login_max_attempts,
      windowMs: config.values.security.login_window_min * 60 * 1000,
    });
    this.generalLimiter = new RateLimiter({ max: 240, windowMs: 60 * 1000 });
    this.account = null;
    this.generatedPassword = null;
    this.failedLogins = 0;
    this.lastLoginAt = null;
    this.sessionTtlMs = config.values.security.session_ttl_h * 3600 * 1000;
    this.idleTtlMs = config.values.security.session_idle_min * 60 * 1000;
  }

  get authEnabled() {
    return this.config.values.admin.auth_enabled !== false;
  }

  async start() {
    await this.loadAccount();
    this.pruneTimer = setInterval(() => {
      this.pruneSessions();
      this.loginLimiter.prune();
    }, 60_000);
    this.pruneTimer.unref?.();
    if (!this.authEnabled) {
      this.log.warn('Admin authentication is DISABLED ([admin].auth_enabled = false). Anyone who can reach this port has full control.');
    }
    return this;
  }

  async stop() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  async loadAccount() {
    const file = this.config.paths.authFile;
    const existing = await readJson(file, null);
    if (existing?.passwordHash) {
      this.account = existing;
      return this.account;
    }
    await ensureDir(this.config.paths.configDir);
    const password = generatePassword(this.config.values.security.generated_password_length);
    const account = {
      username: existing?.username || 'admin',
      passwordHash: hashPassword(password, { username: existing?.username || 'admin' }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(file, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(file, 0o600).catch(() => {});
    this.account = account;
    this.generatedPassword = password;
    return account;
  }

  /** One-time password for the banner (only available right after creation). */
  takeGeneratedPassword() {
    const password = this.generatedPassword;
    this.generatedPassword = null;
    return password;
  }

  async setPassword(newPassword, { username = this.account?.username || 'admin', keepSessions = false } = {}) {
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      throw new AppError('Username must contain 3 to 32 letters, digits or underscores.', { code: 'INVALID_USERNAME', status: 400 });
    }
    const weak = isWeakPassword(newPassword);
    if (weak) throw new AppError(weak, { code: 'WEAK_PASSWORD', status: 400 });
    const account = {
      username,
      passwordHash: hashPassword(newPassword, { username }),
      createdAt: this.account?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(this.config.paths.authFile, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(this.config.paths.authFile, 0o600).catch(() => {});
    this.account = account;
    if (!keepSessions) this.invalidateAllSessions();
    this.log.warn(`The admin password was changed (${keepSessions ? 'sessions kept' : 'all sessions invalidated'}).`);
    return { username, changedAt: account.updatedAt };
  }

  async changePassword(currentPassword, newPassword, { session } = {}) {
    if (!this.account) throw new AppError('No admin account is configured.', { code: 'NO_ACCOUNT', status: 500 });
    if (!verifyPassword(currentPassword, this.account.passwordHash, { username: this.account.username })) {
      throw new UnauthorizedError('The current password is incorrect.');
    }
    const result = await this.setPassword(newPassword, { username: this.account.username, keepSessions: true });
    // keep only the session that performed the change
    for (const [sid, entry] of this.sessions) {
      if (sid !== session?.sid) this.sessions.delete(sid);
    }
    return result;
  }

  // ------------------------------------------------------------- sessions

  login({ username, password, ip, userAgent = '' }) {
    if (!this.authEnabled) {
      return { session: this.createSession({ ip, userAgent, bypassAuth: true }), skipped: true };
    }
    const limit = this.loginLimiter.check(ip || 'unknown');
    if (!limit.allowed) {
      const retryMinutes = Math.ceil(limit.retryAfterMs / 60000);
      throw new RateLimitError(`Too many failed login attempts from ${ip}.`, {
        hint: `Try again in ${retryMinutes} minute(s).`,
        details: { retryAfterMs: limit.retryAfterMs },
      });
    }
    const expectedUser = this.account?.username || 'admin';
    const suppliedUser = Buffer.from(typeof username === 'string' ? username : '');
    const expectedUserBytes = Buffer.from(expectedUser);
    const usernameOk = suppliedUser.length === expectedUserBytes.length
      && crypto.timingSafeEqual(suppliedUser, expectedUserBytes);
    // Always run the hash comparison to keep the timing identical.
    const passwordOk = verifyPassword(String(password ?? ''), this.account?.passwordHash || '', { username: expectedUser });
    if (!usernameOk || !passwordOk) {
      const attempts = this.loginLimiter.hit(ip || 'unknown');
      this.failedLogins += 1;
      this.log.warn(`Failed login attempt from ${ip} (attempt ${attempts}/${this.loginLimiter.max}).`);
      throw new UnauthorizedError('Invalid username or password.', {
        hint: attempts >= this.loginLimiter.max - 1 ? 'The next failed attempt will lock this address for a while.' : undefined,
        details: { attempts, max: this.loginLimiter.max },
      });
    }
    this.loginLimiter.reset(ip || 'unknown');
    this.failedLogins = 0;
    this.lastLoginAt = new Date().toISOString();
    const session = this.createSession({ ip, userAgent });
    this.log.info(`Admin logged in from ${ip}.`);
    return { session };
  }

  createSession({ ip, userAgent = '', bypassAuth = false }) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const session = {
      sid,
      csrfToken: crypto.randomBytes(24).toString('base64url'),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      ip,
      userAgent: String(userAgent).slice(0, 200),
      bypassAuth,
    };
    this.sessions.set(sid, session);
    this.events?.publish('auth', { action: 'login', ip, at: new Date().toISOString() });
    return session;
  }

  getSession(sid) {
    if (!sid) return null;
    const session = this.sessions.get(sid);
    if (!session) return null;
    const now = Date.now();
    if (now - session.createdAt > this.sessionTtlMs || now - session.lastSeen > this.idleTtlMs) {
      this.sessions.delete(sid);
      return null;
    }
    session.lastSeen = now;
    return session;
  }

  logout(sid) {
    if (!sid) return false;
    const removed = this.sessions.delete(sid);
    if (removed) this.events?.publish('auth', { action: 'logout', at: new Date().toISOString() });
    return removed;
  }

  invalidateAllSessions() {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  pruneSessions() {
    const now = Date.now();
    for (const [sid, session] of this.sessions) {
      if (now - session.createdAt > this.sessionTtlMs || now - session.lastSeen > this.idleTtlMs) this.sessions.delete(sid);
    }
  }

  /** CSRF token validation (double submit cookie + header). */
  assertCsrf(session, providedToken) {
    if (!this.authEnabled) return true;
    if (!session) throw new UnauthorizedError();
    if (!providedToken || typeof providedToken !== 'string') {
      throw new ForbiddenError('Missing CSRF token.', { code: 'CSRF_MISSING', hint: 'Reload the panel; the page may have been open in another tab for too long.' });
    }
    const a = Buffer.from(providedToken);
    const b = Buffer.from(session.csrfToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new ForbiddenError('Invalid CSRF token.', { code: 'CSRF_INVALID', hint: 'Reload the panel and try again.' });
    }
    return true;
  }

  cookieOptions({ secure = false } = {}) {
    const mode = this.config.values.security.cookie_secure;
    const useSecure = mode === 'always' || (mode === 'auto' && secure);
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: useSecure,
      path: '/',
      maxAge: Math.floor(this.sessionTtlMs / 1000),
    };
  }

  status() {
    return {
      authEnabled: this.authEnabled,
      username: this.account?.username || null,
      accountCreatedAt: this.account?.createdAt || null,
      passwordUpdatedAt: this.account?.updatedAt || null,
      activeSessions: this.sessions.size,
      sessions: [...this.sessions.values()].map((s) => ({ createdAt: new Date(s.createdAt).toISOString(), lastSeen: new Date(s.lastSeen).toISOString(), ip: s.ip })),
      failedLogins: this.failedLogins,
      lastLoginAt: this.lastLoginAt,
      rateLimitedIps: this.loginLimiter.size,
      ttlHours: this.config.values.security.session_ttl_h,
      idleMinutes: this.config.values.security.idle_min ?? this.config.values.security.session_idle_min,
    };
  }
}
