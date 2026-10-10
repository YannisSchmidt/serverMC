/** Admin API: e4mc and Cloudflare integrations. */

import { sendJson } from '../../http/http.js';
import { asBool, asString } from '../../util/validate.js';
import { AppError } from '../../util/errors.js';

export function register(router, services) {
  const { e4mc, cloudflare, config, sse, minecraft } = services;
  if (services.playit) {
    router.get('/api/admin/playit', async () => services.playit.runtimeStatus());
    router.post('/api/admin/playit/install', async () => ({ ...await services.playit.installAgent(), message: 'Official Playit Windows application detected.' }));
    router.post('/api/admin/playit/start', async () => ({ ...await services.playit.start(), message: 'Playit agent started. Use the claim link to connect it to your account.' }));
    router.post('/api/admin/playit/stop', async () => ({ ...await services.playit.stop(), message: 'Playit agent stopped.' }));
  }

  // ------------------------------------------------------------------ e4mc

  router.get('/api/admin/e4mc', async () => e4mc.runtimeStatus());

  router.post('/api/admin/e4mc/start', async () => {
    const result = await e4mc.startRelay({ reason: 'panel request' });
    return { ...result, message: 'The e4mc relay client is starting; the public address appears as soon as the relay answers.' };
  });

  router.post('/api/admin/e4mc/stop', async () => {
    const result = await e4mc.stopRelay({ reason: 'panel request' });
    return { ...result, message: 'The e4mc relay client stopped. The Minecraft server keeps running locally (LAN/localhost).' };
  });

  router.post('/api/admin/e4mc/restart', async () => {
    await e4mc.stopRelay({ reason: 'restart requested' });
    const result = await e4mc.startRelay({ reason: 'restart requested' });
    return { ...result, message: 'The e4mc relay client was restarted.' };
  });

  router.post('/api/admin/e4mc/address', async (ctx) => {
    const address = asString(ctx.body?.address ?? '', 'address', { max: 253 });
    const status = await e4mc.setManualAddress(address);
    return { ...status, message: address ? `Manual address saved: ${address}` : 'Manual address cleared: automatic detection is used again.' };
  });

  router.post('/api/admin/e4mc/test', async (ctx) => {
    const address = ctx.body?.address ? asString(ctx.body.address, 'address', { max: 253 }) : undefined;
    const [broker, test] = await Promise.all([
      e4mc.checkBroker(),
      e4mc.testAddress(address).catch((err) => ({ ok: false, error: err.message, hint: err.hint })),
    ]);
    return {
      broker,
      address: test,
      summary: test?.tcp?.ok
        ? `The address ${test.host} answered on port 25565: the tunnel is up end to end.`
        : broker.ok
          ? 'The e4mc relay is reachable but the address did not answer (the tunnel may still be starting).'
          : 'The e4mc relay network could not be reached from this computer.',
    };
  });

  router.put('/api/admin/e4mc/enabled', async (ctx) => {
    const enabled = asBool(ctx.body?.enabled, 'enabled');
    const status = await e4mc.setEnabled(enabled);
    return { ...status, message: enabled ? 'e4mc enabled.' : 'e4mc disabled: only LAN players can join.' };
  });

  // ------------------------------------------------------------ Cloudflare

  router.get('/api/admin/cloudflare', async () => cloudflare.status());

  router.post('/api/admin/cloudflare/start', async () => {
    const result = await cloudflare.startTunnel({ reason: 'panel request' });
    return { ...result, message: 'cloudflared is starting. The public page becomes reachable once the tunnel registers.' };
  });

  router.post('/api/admin/cloudflare/quick-start', async () => {
    const result = await cloudflare.startTunnel({ reason: 'temporary Quick Tunnel from panel', quick: true });
    return { ...result, message: result.status?.url
      ? `Free temporary player page started: ${result.status.url}`
      : 'Free temporary Cloudflare link is starting; its URL will appear on the dashboard.' };
  });

  router.post('/api/admin/cloudflare/stop', async () => {
    const result = await cloudflare.stopTunnel({ reason: 'panel request' });
    return { ...result, message: 'The tunnel stopped. The public page is still served locally.' };
  });

  router.post('/api/admin/cloudflare/restart', async () => {
    await cloudflare.restartTunnel();
    return { message: 'The Cloudflare tunnel was restarted.' };
  });

  router.post('/api/admin/cloudflare/test', async (ctx) => {
    const writeConfig = asBool(ctx.body?.writeConfig, 'writeConfig', { fallback: false });
    const result = await cloudflare.test({ writeConfig });
    return {
      ...result,
      summary: result.checks.binary.found
        ? result.checks.credentials.tokenMode || result.checks.credentials.exists
          ? 'cloudflared is installed and credentials are present.'
          : 'cloudflared is installed but no tunnel credentials were found.'
        : 'cloudflared is not installed on this computer.',
    };
  });

  router.post('/api/admin/cloudflare/config', async (ctx) => {
    const overwrite = asBool(ctx.body?.overwrite, 'overwrite', { fallback: false });
    const result = await cloudflare.writeTunnelConfig({ overwrite });
    return { ...result, message: result.keptExisting ? 'An existing hand-written cloudflared config was kept.' : `cloudflared configuration written (${result.hostname} -> ${result.service}).` };
  });

  router.put('/api/admin/cloudflare/settings', async (ctx) => {
    const patch = {};
    for (const key of ['enabled', 'domain', 'public_hostname', 'zone_id', 'api_token', 'tunnel_enabled', 'tunnel_name', 'cloudflared_path', 'tunnel_service']) {
      if (ctx.body?.[key] !== undefined) patch[key] = ctx.body[key];
    }
    if (patch.api_token === '********') delete patch.api_token; // unchanged masked value
    if (patch.enabled !== undefined) patch.enabled = asBool(patch.enabled, 'enabled');
    if (patch.tunnel_enabled !== undefined) patch.tunnel_enabled = asBool(patch.tunnel_enabled, 'tunnel_enabled');
    if (Object.keys(patch).length === 0) throw new AppError('No Cloudflare setting was provided.', { code: 'VALIDATION_ERROR', status: 400 });
    const result = await cloudflare.updateSettings(patch);
    const status = await cloudflare.status();
    return { ...result, status, message: 'Cloudflare settings saved.' };
  });

  router.get('/api/admin/cloudflare/api-check', async (ctx) => {
    const force = ctx.query.force === 'true';
    return cloudflare.verifyApi({ force });
  });

  router.get('/api/admin/integrations/summary', async () => ({
    e4mc: e4mc.status(),
    cloudflare: await cloudflare.status(),
    separation: {
      minecraft: `Players connect through the e4mc address (${e4mc.status().address || 'not assigned yet'})`,
      web: cloudflare.publicUrl ? `The public page is published on ${cloudflare.publicUrl}` : 'The public page is local only',
      note: 'Minecraft traffic never goes through Cloudflare. Web traffic never goes through e4mc.',
    },
  }));
}
