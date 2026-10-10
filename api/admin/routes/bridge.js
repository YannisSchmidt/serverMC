/**
 * Admin API: the mod bridge (`/api/admin/bridge/*`).
 *
 * These endpoints exist for one caller: the admin mod running inside the
 * Minecraft server (`/panel ...` in game). They authenticate with a bearer
 * token that only works from a loopback connection (see BridgeService), never
 * with the browser session cookie, and they answer in two forms:
 *
 *   Accept: application/json  -> the structured payload (default)
 *   Accept: text/plain        -> the same payload already rendered as lines,
 *                                which is what the mod prints in the console
 *
 * Every handler reuses the very same services as the panel routes, so the mod
 * and the browser can never disagree about the state of the server.
 */

import { sendJson, sendText } from '../../http/http.js';
import { AppError } from '../../util/errors.js';
import { asBool, asString } from '../../util/validate.js';

const SERVER_ACTIONS = ['start', 'stop', 'restart'];

function wantsText(ctx) {
  const accept = String(ctx.req.headers.accept || '');
  return accept.includes('text/plain') && !accept.includes('application/json');
}

/** Send either the rendered lines (mod) or the JSON payload (everything else). */
function reply(ctx, payload, text, status = 200) {
  if (wantsText(ctx)) return sendText(ctx.res, status, `${text}\n`);
  return sendJson(ctx.res, status, { ...payload, text });
}

function playerLabel(player) {
  if (!player) return 'unknown';
  return player.name || player.uuid || 'unknown';
}

export function register(router, services) {
  const { minecraft, players, backups, mods, e4mc, install, bridge, config } = services;

  router.get('/api/admin/bridge/ping', async (ctx) => {
    const status = bridge.status();
    const payload = {
      ok: true,
      service: 'minecraft-server-manager',
      minecraft: config.values.minecraft.version,
      neoforge: config.values.minecraft.neoforge_version,
      bridgeUseCount: status.useCount,
      linked: status.linked,
      time: new Date().toISOString(),
    };
    return reply(ctx, payload, [
      'panel reachable',
      `minecraft ${payload.minecraft} / neoforge ${payload.neoforge}`,
      `bridge requests so far: ${status.useCount}`,
      status.linked ? 'token matches the mod configuration' : 'token does not match minecraft/server/config/admintools.properties',
    ].join('\n'));
  });

  router.get('/api/admin/bridge/status', async (ctx) => {
    const mc = minecraft.status();
    const relay = await e4mc.runtimeStatus().catch(() => null);
    const [backupList, modList] = await Promise.all([
      backups.list().catch(() => ({ backups: [] })),
      mods.list().catch(() => ({ mods: [] })),
    ]);
    const installStatus = await install.status().catch(() => null);
    const payload = {
      server: {
        state: mc.state,
        online: mc.online,
        pid: mc.pid,
        uptimeS: mc.uptimeS,
        minecraftVersion: mc.version,
        neoforgeVersion: mc.neoforge,
        playersOnline: mc.players.online,
        playersMax: mc.players.max,
        tps: mc.tps,
        mspt: mc.mspt,
        ramUsedMb: mc.ram.usedMb,
        ramMaxMb: mc.ram.maxMb,
        cpuPercent: mc.cpu?.percent ?? null,
        lastError: mc.lastError ? mc.lastError.message : null,
      },
      e4mc: relay ? { state: relay.state, address: relay.address, port: relay.port } : null,
      counts: {
        backups: backupList.backups?.length || 0,
        mods: modList.mods?.length || 0,
        playersKnown: (await players.knownPlayers().catch(() => ({ counts: { known: 0 } }))).counts.known || 0,
      },
      installed: installStatus ? { ready: installStatus.ready, installed: installStatus.installed } : null,
    };
    const ram = payload.server.ramUsedMb === null ? 'n/a' : `${payload.server.ramUsedMb} / ${payload.server.ramMaxMb} MB`;
    const text = [
      `server: ${payload.server.state.toUpperCase()}${payload.server.pid ? ` (pid ${payload.server.pid})` : ''}`,
      `uptime: ${payload.server.uptimeS}s`,
      `minecraft: ${payload.server.minecraftVersion} / neoforge ${payload.server.neoforgeVersion || 'unknown'}`,
      `players: ${payload.server.playersOnline} / ${payload.server.playersMax}`,
      `tps: ${payload.server.tps ?? 'n/a'} (mspt ${payload.server.mspt ?? 'n/a'})`,
      `ram: ${ram}`,
      `cpu: ${payload.server.cpuPercent ?? 'n/a'}%`,
      `backups: ${payload.counts.backups} / mods: ${payload.counts.mods} / known players: ${payload.counts.playersKnown}`,
      `e4mc: ${payload.e4mc ? `${payload.e4mc.state}${payload.e4mc.address ? ` - ${payload.e4mc.address}` : ''}` : 'unavailable'}`,
    ].join('\n');
    if (payload.server.lastError) text.concat(`\nlast error: ${payload.server.lastError}`);
    return reply(ctx, payload, text);
  });

  router.get('/api/admin/bridge/players', async (ctx) => {
    const known = await players.knownPlayers();
    const online = minecraft.playerList().map((name) => String(name));
    const knownPlayers = (known.players || []).map((p) => ({
      name: p.name,
      uuid: p.uuid,
      online: online.includes(String(p.name).toLowerCase()) || Boolean(p.online),
      op: Boolean(p.op),
      whitelisted: Boolean(p.whitelisted),
      banned: Boolean(p.banned),
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
    }));
    const payload = { online, known: knownPlayers, counts: known.counts };
    const text = [
      `online (${online.length}): ${online.length ? online.join(', ') : 'nobody'}`,
      `known players: ${knownPlayers.length}`,
      ...knownPlayers.slice(0, 20).map((p) => `  ${p.name}${p.op ? ' [op]' : ''}${p.banned ? ' [banned]' : ''}${p.whitelisted ? ' [whitelisted]' : ''} first ${p.firstSeen || '?'} last ${p.lastSeen || '?'}`),
    ].join('\n');
    return reply(ctx, payload, text);
  });

  /** The panel is the source of truth for the player history. */
  router.get('/api/admin/bridge/player/:name', async (ctx) => {
    const wanted = String(ctx.params.name || '').toLowerCase();
    const known = await players.knownPlayers();
    const found = (known.players || []).find((p) => String(p.name || '').toLowerCase() === wanted || p.uuid === ctx.params.name);
    if (!found) {
      throw new AppError(`No player named "${ctx.params.name}" is known to the panel.`, {
        code: 'PLAYER_UNKNOWN',
        status: 404,
        hint: 'The panel learns players from the console, usercache.json, whitelist.json, ops.json and world/playerdata. Check the spelling.',
      });
    }
    const payload = { player: found };
    const text = [
      `${found.name}${found.uuid ? ` (${found.uuid})` : ''}`,
      `first seen: ${found.firstSeen || 'unknown'}`,
      `last seen: ${found.lastSeen || 'unknown'}`,
      `online: ${found.online ? 'yes' : 'no'}`,
      `op: ${found.op ? 'yes' : 'no'} / whitelisted: ${found.whitelisted ? 'yes' : 'no'} / banned: ${found.banned ? 'yes' : 'no'}`,
      `playtime: ${found.playtimeS === null || found.playtimeS === undefined ? 'unknown' : `${Math.round(found.playtimeS / 60)} min`}`,
    ].join('\n');
    return reply(ctx, payload, text);
  });

  router.get('/api/admin/bridge/backups', async (ctx) => {
    const list = await backups.list();
    const usage = await backups.usage().catch(() => null);
    const payload = {
      count: list.backups?.length || 0,
      backups: (list.backups || []).map((b) => ({ name: b.name, sizeHuman: b.sizeHuman, createdAt: b.createdAt, files: b.files })),
      usage,
    };
    const text = [
      `backups: ${payload.count}${usage ? ` (${usage.human} used in ${usage.dir})` : ''}`,
      ...(payload.count ? payload.backups.slice(0, 20).map((b) => `  ${b.name}  ${b.sizeHuman}  ${b.createdAt}`) : ['  (none yet)']),
    ].join('\n');
    return reply(ctx, payload, text);
  });

  router.post('/api/admin/bridge/backups', async (ctx) => {
    const label = asString(ctx.body?.label ?? '', 'label', { max: 32 });
    const result = await backups.create({ label, reason: '/panel backup (in game)' });
    const payload = { name: result.name, files: result.files, sizeHuman: result.sizeHuman };
    return reply(ctx, payload, `backup created: ${result.name} (${result.files} files, ${result.sizeHuman})`, 201);
  });

  router.get('/api/admin/bridge/mods', async (ctx) => {
    const list = await mods.list();
    const payload = {
      count: list.mods?.length || 0,
      mods: (list.mods || []).map((m) => ({
        name: m.name,
        file: m.file,
        sizeHuman: m.sizeHuman,
        enabled: m.enabled !== false,
        version: m.version || null,
      })),
    };
    const text = [
      `mods: ${payload.count}`,
      ...payload.mods.map((m) => `  ${m.name} ${m.version || ''}${m.enabled ? '' : ' [disabled]'} (${m.file}, ${m.sizeHuman})`),
    ].join('\n');
    return reply(ctx, payload, text);
  });

  router.get('/api/admin/bridge/e4mc', async (ctx) => {
    const relay = await e4mc.runtimeStatus();
    const broker = await e4mc.checkBroker().catch(() => null);
    const payload = {
      state: relay.state,
      address: relay.address,
      port: relay.port,
      jarPresent: relay.jar?.present ?? null,
      broker: broker ? { ok: broker.ok, ms: broker.ms, host: broker.relay?.host || null } : null,
      error: relay.error ? relay.error.message : null,
    };
    const text = [
      `e4mc: ${relay.state}`,
      `address: ${relay.address || '(not assigned yet)'}`,
      `relay port: ${relay.port}`,
      `client jar: ${relay.jar?.present ? relay.jar.path : `missing (${relay.jar?.path})`}`,
      broker ? `broker: ${broker.ok ? `reachable (${broker.ms} ms, relay ${broker.relay?.host})` : `unreachable - ${broker.error}`}` : 'broker: not checked',
    ].join('\n');
    return reply(ctx, payload, text);
  });

  /** start / stop / restart the Minecraft server, from the game. */
  router.post('/api/admin/bridge/server/:action', async (ctx) => {
    const action = String(ctx.params.action || '').toLowerCase();
    if (!SERVER_ACTIONS.includes(action)) {
      throw new AppError(`Unknown server action "${action}".`, {
        code: 'VALIDATION_ERROR', status: 400, hint: `Valid actions: ${SERVER_ACTIONS.join(', ')}`,
      });
    }
    if (config.values.bridge?.allow_server_actions === false) {
      throw new AppError(`The bridge cannot ${action} the Minecraft server: server actions are disabled.`, {
        code: 'BRIDGE_ACTIONS_DISABLED', status: 403,
        hint: 'Set [bridge].allow_server_actions = true in config/config.toml to let the in-game /panel command control the server.',
      });
    }
    if (action === 'start') {
      const status = await minecraft.startServer({ reason: '/panel start (in game)' });
      return reply(ctx, { state: status.state, pid: status.pid }, `server is ${status.state}${status.pid ? ` (pid ${status.pid})` : ''}`, 201);
    }
    if (action === 'stop') {
      const result = await minecraft.requestStop({ reason: '/panel stop (in game)' });
      return reply(ctx, { stopped: result.stopped }, result.stopped ? 'server stopped cleanly' : `server is stopping: ${result.message}`);
    }
    await minecraft.restart({ reason: '/panel restart (in game)' });
    const status = minecraft.status();
    return reply(ctx, { state: status.state }, `restart requested, the server will be ${status.state} again in a moment`, 202);
  });

  /**
   * Restore a backup from the game. The explicit `confirm` flag is required:
   * a restore replaces the world, so it can never be triggered by a typo.
   */
  router.post('/api/admin/bridge/backups/:name/restore', async (ctx) => {
    const confirm = asBool(ctx.body?.confirm, 'confirm', { fallback: false });
    const restartAfter = asBool(ctx.body?.restartAfter, 'restartAfter', { fallback: false });
    if (!confirm) {
      throw new AppError(`Restoring ${ctx.params.name} replaces the world, the configuration and server.properties.`, {
        code: 'CONFIRMATION_REQUIRED',
        status: 428,
        hint: 'Run the same command again with "confirm" to restore it (a safety backup is made first).',
      });
    }
    const result = await backups.restore(ctx.params.name, { confirm: true, restartAfter, stopServer: true });
    const payload = {
      restored: result.restored,
      safetyBackup: result.safetyBackup,
      restarted: result.restarted,
    };
    const text = `restored ${result.restored.files} files from ${ctx.params.name}`
      + `${result.safetyBackup ? ` (safety backup: ${result.safetyBackup})` : ''}`
      + `${result.restarted ? ' - the server is starting again' : ''}`;
    return reply(ctx, payload, text);
  });
}
