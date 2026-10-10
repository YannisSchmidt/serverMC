/** Admin API: authentication, session and password management. */

import { sendJson, appendSetCookie, serializeCookie } from '../../http/http.js';
import { SESSION_COOKIE, CSRF_COOKIE } from '../../auth/AuthService.js';
import { asString, asBool } from '../../util/validate.js';

export function register(router, services) {
  const { auth, config } = services;

  router.get('/api/admin/health', async (ctx) => ({
    ok: true,
    name: config.values.server.name,
    version: '1.0.0',
    authEnabled: auth.authEnabled,
    requiresLogin: auth.authEnabled,
    minecraft: {
      version: config.values.minecraft.version,
      neoforge: config.values.minecraft.neoforge_version,
    },
  }));

  router.get('/api/admin/auth/session', async (ctx) => {
    const session = ctx.session;
    if (!session) return sendJson(ctx.res, 200, { authenticated: false, authEnabled: auth.authEnabled, username: auth.account?.username || 'admin' });
    return sendJson(ctx.res, 200, {
      authenticated: true,
      authEnabled: auth.authEnabled,
      username: auth.account?.username || 'admin',
      csrfToken: session.csrfToken,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresInMs: Math.max(0, auth.sessionTtlMs - (Date.now() - session.createdAt)),
      account: { passwordUpdatedAt: auth.account?.updatedAt || null, createdAt: auth.account?.createdAt || null },
    });
  });

  router.post('/api/admin/auth/login', async (ctx) => {
    const username = asString(ctx.body.username ?? 'admin', 'username', { min: 1, max: 64, allowEmpty: false });
    const password = asString(ctx.body.password, 'password', { min: 1, max: 256, allowEmpty: false, trim: false });
    const { session } = auth.login({ username, password, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] || '' });
    const secure = ctx.secure;
    appendSetCookie(ctx.res, serializeCookie(SESSION_COOKIE, session.sid, auth.cookieOptions({ secure })));
    // CSRF cookie is readable by the app (double submit pattern).
    appendSetCookie(ctx.res, serializeCookie(CSRF_COOKIE, session.csrfToken, { ...auth.cookieOptions({ secure }), httpOnly: false }));
    return sendJson(ctx.res, 200, {
      authenticated: true,
      username: auth.account?.username || 'admin',
      csrfToken: session.csrfToken,
    });
  });

  router.post('/api/admin/auth/logout', async (ctx) => {
    const sid = ctx.session?.sid;
    if (sid) auth.logout(sid);
    appendSetCookie(ctx.res, serializeCookie(SESSION_COOKIE, '', { ...auth.cookieOptions({ secure: ctx.secure }), maxAge: 0 }));
    appendSetCookie(ctx.res, serializeCookie(CSRF_COOKIE, '', { ...auth.cookieOptions({ secure: ctx.secure }), httpOnly: false, maxAge: 0 }));
    return sendJson(ctx.res, 200, { authenticated: false });
  });

  router.post('/api/admin/auth/password', async (ctx) => {
    const current = asString(ctx.body.currentPassword, 'currentPassword', { min: 1, allowEmpty: false, trim: false });
    const next = asString(ctx.body.newPassword, 'newPassword', { min: 12, max: 256, allowEmpty: false, trim: false });
    const result = await auth.changePassword(current, next, { session: ctx.session });
    return sendJson(ctx.res, 200, { ...result, message: 'Password updated. Other sessions were signed out.' });
  });

  router.get('/api/admin/auth/status', async (ctx) => sendJson(ctx.res, 200, auth.status()));

  router.put('/api/admin/auth/enabled', async (ctx) => {
    const enabled = asBool(ctx.body.enabled, 'enabled');
    await config.update({ admin: { auth_enabled: enabled } });
    return { authEnabled: enabled, warning: enabled ? null : 'Authentication is now disabled: anyone who can reach this port has full control of the server.' };
  });
}
