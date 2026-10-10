/**
 * Public web application (the only service that may be exposed to the internet).
 *
 *   GET /                     -> public/index.html       (status page)
 *   GET /public               -> same page
 *   GET /api/public/status    -> strictly filtered JSON payload
 *   GET /api/public/health    -> liveness probe for Cloudflare/tunnel monitoring
 *   GET /api/public/capabilities -> whether the page may draw the wake-up button
 *   POST /api/public/power    -> start the server, guarded by the wake-up code
 *
 * Hard rules enforced here:
 *   - only the PublicStatusService payload is served (explicit key whitelist)
 *   - the ONE write route calls PowerService, which can only start the server
 *   - no CORS headers, no cookies, no auth endpoints, no admin routes
 *   - aggressive rate limiting and no caching of dynamic responses
 */

import http from 'node:http';
import { createRouter } from '../http/router.js';
import { StaticServer } from '../http/static.js';
import { sendError, sendJson, clientIp, readJson } from '../http/http.js';
import { RateLimiter } from '../auth/AuthService.js';
import { AppError, toAppError } from '../util/errors.js';

export class PublicApp {
  constructor(services) {
    this.services = services;
    const { config, logs } = services;
    this.config = config;
    this.log = logs.application.child('public-web');
    this.router = createRouter();
    this.limiter = new RateLimiter({ max: 120, windowMs: 60 * 1000 });
    this.static = new StaticServer({ root: config.paths.publicDir, spaFallback: false });
    this.requests = 0;

    // Explicit whitelist: these are the ONLY JSON endpoints of the public app.
    this.router.get('/api/public/status', async () => this.services.publicStatus.status({ includeContent: true }));
    this.router.get('/api/public/health', async () => ({ ok: true, at: new Date().toISOString() }));
    // The page asks before drawing the wake-up control, so a host who never set a
    // code never sees a button that cannot work. Registered only when the service
    // is present, so a stack without it keeps answering 404 instead of 500.
    if (services.power) {
      this.router.get('/api/public/capabilities', async () => this.services.power.capabilities());
      this.router.post('/api/public/power', async (ctx) => {
        const contentType = String(ctx.req.headers['content-type'] || '');
        if (!/application\/json/i.test(contentType)) {
          // Deliberate: an HTML form cannot set this header, so a cross-site form
          // POST never reaches the guard, and a real cross-origin fetch has to
          // pass a CORS preflight - which this app does not answer.
          throw new AppError('Send the wake-up code as JSON (Content-Type: application/json).', {
            code: 'CONTENT_TYPE_REQUIRED', status: 415,
          });
        }
        const body = await readJson(ctx.req, { limit: 2048 });
        return this.services.power.request({ code: body?.code, ip: ctx.ip });
        });
    }
  }

  securityHeaders() {
    return {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'permissions-policy': 'geolocation=(), microphone=(), camera=()',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "form-action 'none'",
        "base-uri 'none'",
        'frame-ancestors *',
      ].join('; '),
    };
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const ip = clientIp(req, { trustProxy: this.config.values.security.trust_proxy });

    try {
      for (const [key, value] of Object.entries(this.securityHeaders())) res.setHeader(key, value);

      const limit = this.limiter.check(ip);
      if (!limit.allowed) {
        res.setHeader('retry-after', String(Math.ceil(limit.retryAfterMs / 1000)));
        throw new AppError('Too many requests.', { code: 'RATE_LIMITED', status: 429 });
      }
      this.limiter.hit(ip);
      this.requests += 1;

      if (pathname.startsWith('/api/public')) {
        const match = this.router.match(req.method, pathname);
        if (!match) {
          throw new AppError(`Unknown public endpoint: ${req.method} ${pathname}`, {
            code: 'NOT_FOUND', status: 404,
            hint: 'Available: GET /api/public/status, GET /api/public/health, GET /api/public/capabilities and POST /api/public/power.',
          });
        }
        if (match.methodNotAllowed) {
          // Same precise answer as the admin API: the path exists, the method
          // does not. The public API is read-only except for the single guarded
          // wake-up route, which is POST-only and never accepts GET.
          throw new AppError(`${req.method} is not allowed on ${pathname}.`, {
            code: 'METHOD_NOT_ALLOWED', status: 405,
            hint: 'The public API is read-only, apart from POST /api/public/power.',
          });
        }
        const result = await match.route.handler({ req, res, ip, query: Object.fromEntries(url.searchParams), params: match.params || {} });
        if (result === true || res.writableEnded) return;
        return sendJson(res, 200, result);
      }

      // Only the public single page application is reachable.
      const served = await this.static.handle(req, res, { pathname: pathname === '/' || pathname === '/public' ? '/index.html' : pathname });
      if (served) return;
      throw new AppError('Page not found.', { code: 'NOT_FOUND', status: 404, hint: 'This server publishes a single status page at /.' });
    } catch (err) {
      const appError = toAppError(err);
      if (appError.status >= 500) this.log.error(`Public request failed: ${appError.message}`);
      if (!res.headersSent) sendError(res, appError);
      else res.end();
    }
  }

  createServer() {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) sendError(res, err);
        else res.end();
      });
    });
    server.headersTimeout = 20000;
    server.requestTimeout = 30000;
    return server;
  }

  async listen() {
    const { host, port } = this.config.values.public;
    this.server = this.createServer();
    await new Promise((resolve, reject) => {
      this.server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new AppError(`Port ${port} is already in use: the public page cannot start.`, {
            code: 'PORT_IN_USE', status: 500,
            hint: `Change [public].port (or PUBLIC_PORT) - it must differ from the admin port (${this.config.values.admin.port}).`,
          }));
        } else reject(err);
      });
      this.server.listen({ host, port }, resolve);
    });
    this.log.info(`Public status page listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    return this.server;
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
  }

  get address() {
    const { host, port } = this.config.values.public;
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    return `http://${displayHost}:${port}`;
  }
}
