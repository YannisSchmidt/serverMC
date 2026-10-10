/** HTTP helpers: responses, cookies, body parsing, client IP. */

import { AppError, toAppError } from '../util/errors.js';
import { redact, redactString } from '../util/redact.js';

export const JSON_LIMIT = 2 * 1024 * 1024;

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
  return true;
}

export function sendText(res, status, text, headers = {}) {
  const body = String(text ?? '');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
  return true;
}

export function sendError(res, error) {
  const app = toAppError(error);
  const status = app.status && app.status >= 400 && app.status < 600 ? app.status : 500;
  const payload = {
    error: true,
    code: app.code,
    message: redactString(app.message),
    hint: app.hint ? redactString(app.hint) : undefined,
    details: app.details ? redact(app.details) : undefined,
  };
  return sendJson(res, status, payload);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value ?? '')}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ? options.sameSite[0].toUpperCase() + options.sameSite.slice(1).toLowerCase() : 'Strict'}`);
  return parts.join('; ');
}

export function appendSetCookie(res, cookie) {
  const current = res.getHeader('set-cookie');
  if (!current) res.setHeader('set-cookie', [cookie]);
  else res.setHeader('set-cookie', Array.isArray(current) ? [...current, cookie] : [current, cookie]);
  return cookie;
}

/** Read the request body as text with a hard size limit. */
export function readBody(req, { limit = JSON_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new AppError(`The request body exceeds the ${Math.round(limit / 1024)} KB limit.`, {
          code: 'PAYLOAD_TOO_LARGE', status: 413, hint: 'Send less data per request.',
        }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new AppError('The request was aborted by the client.', { code: 'REQUEST_ABORTED', status: 499 })));
  });
}

export async function readJson(req, options = {}) {
  const buffer = await readBody(req, options);
  if (buffer.length === 0) return {};
  const text = buffer.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      if (Array.isArray(parsed)) return parsed;
      return { value: parsed };
    }
    return parsed;
  } catch {
    throw new AppError('The request body is not valid JSON.', {
      code: 'INVALID_JSON', status: 400,
      details: { received: text.slice(0, 120) },
    });
  }
}

/** Client IP, honouring X-Forwarded-For only when the config allows it. */
export function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (first) return first;
    }
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function isSecureRequest(req, { trustProxy = false } = {}) {
  if (req.socket?.encrypted) return true;
  if (trustProxy) {
    const proto = req.headers['x-forwarded-proto'];
    if (proto && String(proto).split(',')[0].trim() === 'https') return true;
  }
  return false;
}

export function originHost(origin) {
  try {
    return new URL(String(origin)).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Lightweight same-origin check used in addition to the CSRF token.
 * Both the browser's Origin/Referer host and the request Host must match; a
 * same-origin request makes this transparent for any deployment (localhost,
 * LAN, tunnel or an embedded preview).
 */
export function assertSameOrigin(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return true;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  for (const value of [origin, referer]) {
    if (!value) continue;
    const candidate = originHost(value);
    if (!candidate) continue;
    if (candidate !== host) {
      throw new AppError(`Cross-origin request refused (${candidate} != ${host}).`, {
        code: 'CROSS_ORIGIN_BLOCKED', status: 403,
        hint: 'Open the panel directly (same host/port) instead of embedding it in another site.',
      });
    }
  }
  return true;
}
