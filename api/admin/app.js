/**
 * Admin panel HTTP application.
 *
 *   GET  /                -> panel/index.html (single page app)
 *   /api/admin/*          -> administration API (authenticated, CSRF protected)
 *
 * Security applied here (in order):
 *   1. security headers (CSP, nosniff, referrer policy, optional frameguard)
 *   2. cookie parsing + session lookup (in-memory sessions)
 *   3. rate limiting per IP for every API call
 *   4. authentication + CSRF token for state changing requests
 *   5. explicit route table (no dynamic dispatch from user input)
 */

import http from 'node:http';
import { createRouter } from '../http/router.js';
import { StaticServer } from '../http/static.js';
import {
  parseCookies, sendError, sendJson, readJson, clientIp, isSecureRequest, assertSameOrigin, appendSetCookie, serializeCookie,
} from '../http/http.js';
import { SESSION_COOKIE, CSRF_COOKIE } from '../auth/AuthService.js';
import { AppError, toAppError, UnauthorizedError } from '../util/errors.js';
import { redactString } from '../util/redact.js';
import { RateLimiter } from '../auth/AuthService.js';

import * as authRoutes from './routes/auth.js';
import * as systemRoutes from './routes/system.js';
import * as serverRoutes from './routes/server.js';
import * as playerRoutes from './routes/players.js';
import * as modRoutes from './routes/mods.js';
import * as fileRoutes from './routes/files.js';
import * as backupRoutes from './routes/backups.js';
import * as settingsRoutes from './routes/settings.js';
import * as integrationRoutes from './routes/integrations.js';
import * as bridgeRoutes from './routes/bridge.js';
import * as notificationRoutes from './routes/notifications.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Routes reachable without a session. */
const PUBLIC_ADMIN_ROUTES = new Set([
  'GET /api/admin/health',
  'GET /api/admin/auth/session',
  'POST /api/admin/auth/login',
]);
/** Prefix of the in-game mod bridge (bearer token, loopback only). */
const BRIDGE_PREFIX = '/api/admin/bridge/';

export class AdminApp {
  constructor(services) {
    this.services = services;
    const { config, logs, events } = services;
    this.config = config;
    this.log = logs.application.child('admin');
    this.events = events;
    this.router = createRouter();
    const routeModules = [authRoutes, systemRoutes, serverRoutes, playerRoutes, modRoutes, fileRoutes, backupRoutes, settingsRoutes, integrationRoutes, notificationRoutes];
    // The mod bridge is registered only when its service exists (it always does
    // in production; a hand-built test stack may omit it).
    if (services.bridge) routeModules.push(bridgeRoutes);
    for (const module of routeModules) {
      module.register(this.router, services);
    }
    this.static = new StaticServer({ root: config.paths.panelDir, spaFallback: false });
    this.apiLimiter = new RateLimiter({ max: 600, windowMs: 60 * 1000 });
  }

  securityHeaders(req) {
    const { security, public: publicCfg } = this.config.values;
    const headers = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-xss-protection': '0',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'geolocation=(), microphone=(), camera=()',
      'cache-control': 'no-store',
    };
    const frameAncestors = security.allow_iframe ? "'self' *" : "'self'";
    headers['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; ');
    if (!security.allow_iframe) headers['x-frame-options'] = 'SAMEORIGIN';
    return headers;
  }

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const query = Object.fromEntries(url.searchParams.entries());
    const ip = clientIp(req, { trustProxy: this.config.values.security.trust_proxy });
    const secure = isSecureRequest(req, { trustProxy: this.config.values.security.trust_proxy });

    try {
      for (const [key, value] of Object.entries(this.securityHeaders(req))) res.setHeader(key, value);

      // ---- static panel assets (index.html, css, js) --------------------
      if (!pathname.startsWith('/api/')) {
        const served = await this.static.handle(req, res, { pathname: pathname === '/' ? '/index.html' : pathname });
        if (served) return;
        if (pathname !== '/') {
          // Unknown page: hand it to the SPA (hash routing handles the rest).
          const indexServed = await this.static.handle(req, res, { pathname: '/index.html' });
          if (indexServed) return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      // ---- API ---------------------------------------------------------
      const limit = this.apiLimiter.check(`${ip}:${pathname}`);
      if (!limit.allowed) {
        res.setHeader('retry-after', String(Math.ceil(limit.retryAfterMs / 1000)));
        throw new AppError('Too many requests.', { code: 'RATE_LIMITED', status: 429, hint: `Wait ${Math.ceil(limit.retryAfterMs / 1000)} second(s) before retrying.` });
      }
      this.apiLimiter.hit(`${ip}:${pathname}`);

      const match = this.router.match(req.method, pathname);
      if (!match) {
        throw new AppError(`Unknown admin endpoint: ${req.method} ${pathname}`, {
          code: 'NOT_FOUND', status: 404,
          hint: 'Check the API index at GET /api/admin/api-index.',
        });
      }
      if (match.methodNotAllowed) {
        throw new AppError(`${req.method} is not allowed on ${pathname}.`, { code: 'METHOD_NOT_ALLOWED', status: 405 });
      }

      // Body first: raw uploads (mods/files) are streamed by their handlers and
      // must not be consumed here, JSON bodies are parsed and size limited.
      let body = {};
      const contentType = String(req.headers['content-type'] || '');
      if (UNSAFE_METHODS.has(req.method) && contentType.includes('application/json')) {
        body = await readJson(req, { limit: 4 * 1024 * 1024 });
      }

      const cookies = parseCookies(req.headers.cookie || '');
      const session = this.services.auth.getSession(cookies[SESSION_COOKIE]);
      const routeKey = `${req.method} ${match.route.pattern}`;
      const isPublicRoute = PUBLIC_ADMIN_ROUTES.has(routeKey);

      // ---- the mod bridge (/panel in game) ------------------------------
      // A bearer token that only works from a loopback connection. No session,
      // no CSRF cookie: the caller is the Minecraft server itself, not a
      // browser, so there is no cookie to ride on.
      if (match.route.pattern.startsWith(BRIDGE_PREFIX)) {
        if (this.config.values.bridge?.enabled === false) {
          throw new AppError('The mod bridge is disabled in the configuration.', {
            code: 'BRIDGE_DISABLED', status: 503,
            hint: 'Set [bridge].enabled = true in config/config.toml (or BRIDGE_ENABLED=true) and restart the panel.',
          });
        }
        this.services.bridge.assertRequest({
          token: bearerToken(req),
          remoteAddress: req.socket?.remoteAddress,
          path: routeKey,
        });
      } else if (!isPublicRoute) {
        if (this.services.auth.authEnabled && !session) {
          throw new UnauthorizedError('You must sign in to the admin panel.', {
            hint: 'Open http://localhost:' + this.config.values.admin.port + '/ and enter the admin password.',
          });
        }
        // CSRF (double submit cookie + header) for state changing requests
        if (UNSAFE_METHODS.has(req.method)) {
          assertSameOrigin(req);
          this.services.auth.assertCsrf(session, req.headers['x-csrf-token'] || body?.csrfToken);
        }
      }

      const ctx = {
        req, res, query, body, ip, secure, session, params: match.params || {},
        pathname, startedAt: started,
        services: this.services,
        log: this.log,
      };

      const result = await match.route.handler(ctx);
      if (result === true || res.writableEnded) return;
      if (result === undefined) sendJson(res, 200, { ok: true });
      else sendJson(res, 200, result);
    } catch (err) {
      const appError = toAppError(err);
      if (appError.status >= 500) {
        this.log.error(`${req.method} ${pathname} failed: ${redactString(appError.message)}`, { code: appError.code });
      } else if (appError.status !== 401) {
        this.log.warn(`${req.method} ${pathname} -> ${appError.status} ${appError.code}: ${redactString(appError.message)}`);
      }
      if (!res.headersSent) sendError(res, appError);
      else res.end();
    }
  }

  /** Create the HTTP server bound to the configured host/port. */
  createServer() {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log.error(`Unhandled admin error: ${err.message}`);
        if (!res.headersSent) sendError(res, err);
        else res.end();
      });
    });
    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    // Reasonable limits: the admin panel is a local tool.
    server.requestTimeout = 20 * 60 * 1000;
    server.headersTimeout = 65 * 1000;
    return server;
  }

  async listen() {
    const { host, port } = this.config.values.admin;
    this.server = this.createServer();
    await new Promise((resolve, reject) => {
      this.server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new AppError(`Port ${port} is already in use: the admin panel cannot start.`, {
            code: 'PORT_IN_USE', status: 500,
            hint: `Close the program using port ${port}, or change [admin].port in config/config.toml (env ADMIN_PORT also works).`,
          }));
        } else if (err.code === 'EACCES') {
          reject(new AppError(`Permission denied while binding ${host}:${port}.`, { code: 'PERMISSION_DENIED', status: 500, hint: 'Ports below 1024 need administrator rights on most systems.' }));
        } else reject(err);
      });
      this.server.listen({ host, port }, resolve);
    });
    this.log.info(`Admin panel listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    return this.server;
  }

  async close() {
    if (!this.server) return;
    this.services.sse?.closeAll();
    await new Promise((resolve) => this.server.close(resolve));
  }

  get address() {
    const { host, port } = this.config.values.admin;
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    return `http://${displayHost}:${port}`;
  }
}

export { CSRF_COOKIE, appendSetCookie, serializeCookie };

/** `Authorization: Bearer <token>` -> the token, or null. */
function bearerToken(req) {
  const header = req.headers.authorization || req.headers['x-bridge-token'];
  if (!header) return null;
  const value = String(header).trim();
  if (/^bearer\s+/i.test(value)) return value.replace(/^bearer\s+/i, '').trim();
  return value || null;
}
