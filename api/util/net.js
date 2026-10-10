/**
 * Network helpers: downloads with checksum verification, port probing and
 * small JSON HTTP clients (Mojang meta, Cloudflare API, GitHub API).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './fsx.js';
import { AppError } from './errors.js';

export const USER_AGENT = 'minecraft-neoforge-panel/1.0 (+local admin panel)';

/** The host of a URL, for messages that say *which* server could not be reached. */
function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url);
  }
}

/** Node wraps low-level failures in `cause`; sometimes in an AggregateError. */
function causeCode(err) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (typeof node.code === 'string') return node.code;
    if (Array.isArray(node.errors)) {
      for (const inner of node.errors) {
        const code = walk(inner);
        if (code) return code;
      }
    }
    return walk(node.cause);
  };
  return walk(err?.cause) || (typeof err?.code === 'string' ? err.code : null);
}

const NETWORK_REASONS = {
  ENOTFOUND: 'the host name could not be resolved (DNS)',
  EAI_AGAIN: 'the name server did not answer (DNS)',
  ECONNREFUSED: 'the connection was refused',
  ECONNRESET: 'the connection was reset by the peer',
  EPIPE: 'the connection was closed unexpectedly',
  EHOSTUNREACH: 'the host is unreachable',
  ENETUNREACH: 'the network is unreachable',
  ETIMEDOUT: 'the connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
  CERT_HAS_EXPIRED: 'the TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'the TLS certificate is self-signed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate could not be verified',
};

/**
 * Turn a low-level fetch failure into an AppError that names the host and the
 * reason, instead of the bare `TypeError: fetch failed` Node throws.
 */
// `drain` or an error on the file: whichever comes first. A destroyed stream
// stops the read loop instead of hanging on a full disk.
function onceWrite(stream, received) {
  return new Promise((resolve) => {
    const done = (value) => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      resolve(value);
    };
    const onDrain = () => done(true);
    const onError = () => done(false);
    stream.once('drain', onDrain);
    stream.once('error', onError);
    if (stream.destroyed || stream.writableEnded) done(false);
  });
}

export function networkError(err, url, { code = 'NETWORK_ERROR', timeoutMs = null, hint = null } = {}) {
  if (err instanceof AppError) return err;
  const host = hostOf(url);
  const safeUrl = redactUrl(url);
  const text = `${err?.message || err} ${err?.cause?.message || ''}`;
  const timedOut = err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timeout|timed out/i.test(text);
  if (timedOut) {
    const within = !timeoutMs ? '' : ` within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
    return new AppError(
      `${host} did not answer${within} (${safeUrl}).`,
      {
        code: 'NETWORK_TIMEOUT',
        status: 504,
        hint: hint || `Check the Internet connection, a proxy/firewall, and whether ${host} is reachable from this machine.`,
        details: { url: safeUrl, host, timeoutMs: timeoutMs ?? null },
        cause: err,
      },
    );
  }
  const cause = causeCode(err);
  // A TypeError with no system error code behind it is a bug in this file or a
  // server that answered with something unexpected - not a dead connection.
  // Sending the user to their firewall for that would be a lie.
  if (!cause && err instanceof TypeError && !/timeout|timed out/i.test(text)) {
    return new AppError(`Downloading ${safeUrl} did not finish as expected: ${err.message}`, {
      code: 'DOWNLOAD_ERROR',
      status: 502,
      hint: `The host ${host} answered, so the connection is fine - the response was not. Check the URL/version in config/config.toml, then retry.`,
      details: { url: safeUrl, host, reason: err.message },
      cause: err,
    });
  }
  const reason = NETWORK_REASONS[cause]
    || (/bad port/i.test(text) ? 'the port is a reserved port the client refuses to connect to' : null)
    || (/fetch failed/i.test(text) ? 'no connection could be established' : err?.message || 'unknown network failure');
  return new AppError(
    `${host} could not be reached: ${reason} (${safeUrl}).`,
    {
      code,
      status: 502,
      hint: hint || 'Check the Internet connection (DNS, proxy, firewall) or work offline - every network feature is optional.',
      details: { url: safeUrl, host, reason, cause: cause || null },
      cause: err,
    },
  );
}

/** HTTP GET returning a Buffer, with timeout and size guard. */
export async function fetchBuffer(url, { timeoutMs = 60000, maxBytes = 512 * 1024 * 1024, headers = {}, onProgress = null, signal = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    clearTimeout(timer);
    throw networkError(err, url, { timeoutMs });
  }
  try {
    if (!res.ok) {
      throw new AppError(`HTTP ${res.status} ${res.statusText} while requesting ${redactUrl(url)}`, {
        code: 'HTTP_ERROR',
        status: 502,
        details: { status: res.status, url: redactUrl(url) },
      });
    }
    const total = Number(res.headers.get('content-length') || 0);
    if (total && total > maxBytes) {
      throw new AppError(`Refusing to download ${redactUrl(url)}: ${total} bytes exceeds the ${maxBytes} byte limit.`, {
        code: 'DOWNLOAD_TOO_LARGE',
        status: 507,
      });
    }
    if (!res.body) return Buffer.from(await res.arrayBuffer());
    const chunks = [];
    let received = 0;
    for await (const chunk of res.body) {
      received += chunk.length;
      if (received > maxBytes) {
        controller.abort();
        throw new AppError(`Download exceeded the ${maxBytes} byte limit: ${redactUrl(url)}`, { code: 'DOWNLOAD_TOO_LARGE', status: 507 });
      }
      chunks.push(Buffer.from(chunk));
      if (onProgress) onProgress({ received, total: total || null });
    }
    return Buffer.concat(chunks);
  } catch (err) {
    // The stream can fail after the headers (reset connection, abort, ...).
    throw err instanceof AppError ? err : networkError(err, url, { timeoutMs });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, options = {}) {
  const buf = await fetchBuffer(url, { ...options, maxBytes: options.maxBytes ?? 8 * 1024 * 1024 });
  return buf.toString('utf8');
}

export async function fetchJson(url, options = {}) {
  const buf = await fetchBuffer(url, { ...options, maxBytes: options.maxBytes ?? 32 * 1024 * 1024 });
  const text = buf.toString('utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AppError(`Expected JSON from ${redactUrl(url)} but the response could not be parsed.`, {
      code: 'INVALID_JSON_RESPONSE', status: 502, details: { snippet: text.slice(0, 200) }, cause: err,
    });
  }
}

/** Download to a file, verifying an optional sha1 checksum. */
export async function downloadFile(url, dest, { sha1 = null, timeoutMs = 30 * 60 * 1000, onProgress = null, headers = {} } = {}) {
  await ensureDir(path.dirname(dest));
  const tmp = `${dest}.part-${process.pid}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    clearTimeout(timer);
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw networkError(err, url, { timeoutMs });
  }
  try {
    if (!res.ok || !res.body) {
      throw new AppError(`Download failed: HTTP ${res.status} ${res.statusText} for ${redactUrl(url)}`, {
        code: 'DOWNLOAD_FAILED', status: 502, details: { url: redactUrl(url), status: res.status },
      });
    }
    const total = Number(res.headers.get('content-length') || 0) || null;
    const hash = sha1 ? crypto.createHash('sha1') : null;
    let received = 0;
    const out = fs.createWriteStream(tmp);
    const close = () => new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    // `res.body` is a WHATWG ReadableStream - fetch never hands out a Node
    // stream - so it is consumed by async iteration and written with backpressure
    // (`write()` returning false, then waiting for `drain`). `.on('data')` here
    // looked right and threw on the first real download: `TypeError:
    // res.body.on is not a function`, i.e. nobody could install the server.
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        received += buf.length;
        if (hash) hash.update(buf);
        if (onProgress) onProgress({ received, total });
        if (!out.write(buf) && !(await onceWrite(out, received))) break;
      }
    } catch (err) {
      out.destroy();
      await fsp.rm(tmp, { force: true }).catch(() => {});
      clearTimeout(timer);
      throw err;
    }
    await close();
    if (sha1 && hash.digest('hex').toLowerCase() !== sha1.toLowerCase()) {
      await fsp.rm(tmp, { force: true });
      throw new AppError(`Checksum mismatch for ${redactUrl(url)} (expected sha1 ${sha1}).`, {
        code: 'CHECKSUM_MISMATCH', status: 502, hint: 'The download was corrupted or intercepted. Retry, or download the file manually.',
      });
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(tmp, dest);
    return { bytes: received, path: dest };
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err instanceof AppError ? err : networkError(err, url, { timeoutMs });
  } finally {
    clearTimeout(timer);
  }
}

export function redactUrl(url) {
  try {
    const u = new URL(String(url));
    for (const key of [...u.searchParams.keys()]) {
      if (/token|key|secret|password/i.test(key)) u.searchParams.set(key, '[redacted]');
    }
    return u.toString();
  } catch {
    return String(url);
  }
}

/** Is a TCP port free on the given host? */
export async function isPortFree(port, host = '127.0.0.1', { timeoutMs = 1500 } = {}) {
  // On Windows, binding 0.0.0.0 can succeed while another process already
  // listens on 127.0.0.1 (the address Node's exclusive flag does not make the
  // wildcard probe exclusive across address families). Probe loopback first;
  // a successful TCP handshake proves a listener already owns this port.
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  if (await canConnect(port, probeHost, { timeoutMs: Math.min(timeoutMs, 600) })) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    let timer = null;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => resolve(free));
    };
    // net.Server has no setTimeout(); a socket timeout would not fire while the
    // server is waiting for a connection, so guard the listen handshake here.
    timer = setTimeout(() => finish(false), timeoutMs);
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    try {
      server.listen({ port, host, exclusive: true });
    } catch {
      finish(false);
    }
  });
}

/** Can we open a TCP connection to host:port? */
export function canConnect(port, host = '127.0.0.1', { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Basic reachability test (no payload) used by `doctor`. */
export async function checkInternet({ timeoutMs = 5000 } = {}) {
  const targets = ['https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'https://broker.e4mc.link/getBestRelay'];
  const results = [];
  for (const url of targets) {
    const started = Date.now();
    try {
      const res = await fetch(url, { method: 'GET', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      results.push({ url, ok: res.ok, status: res.status, ms: Date.now() - started });
    } catch (err) {
      results.push({ url, ok: false, status: null, ms: Date.now() - started, error: networkError(err, url, { timeoutMs }).message, reason: causeCode(err) || err?.name || 'unknown' });
    }
  }
  return { ok: results.some((r) => r.ok), results };
}

/**
 * Is this address a loopback address?
 *
 * Used by the mod bridge: the admin API accepts a bearer token only when the
 * TCP connection really comes from this machine. The socket address is used on
 * purpose (never X-Forwarded-For), so a client on the network cannot claim to
 * be localhost.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const raw = address.trim().toLowerCase();
  if (!raw) return false;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) and IPv4 with a scope/zone suffix.
  const unwrapped = raw.replace(/^::ffff:/, '').replace(/%.*$/, '');
  if (unwrapped === '127.0.0.1' || unwrapped === 'localhost') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(unwrapped)) return true;
  if (unwrapped === '::1' || unwrapped === '0:0:0:0:0:0:0:1') return true;
  return false;
}
