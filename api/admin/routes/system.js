/** Admin API: status, live metrics, logs, host info, Java detection, doctor, SSE. */

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { sendJson, sendText } from '../../http/http.js';
import { AppError } from '../../util/errors.js';
import { asInt } from '../../util/validate.js';
import { humanBytes, readJson } from '../../util/fsx.js';
import { cpuCount, totalMemoryMb } from '../../util/proc.js';
import { LOG_CHANNELS } from '../../logging/logger.js';

export function register(router, services) {
  const { config, logs, minecraft, e4mc, cloudflare, playit, java, install, players, mods, backups, files, doctor, auth, sse, events, publicStatus, bridge } = services;

  /** Everything the dashboard needs in one request. */
  router.get('/api/admin/status', async () => {
    const [minecraftStatus, e4mcStatus, cloudflareStatus, installStatus, javaStatus, modsSummary, backupUsage] = await Promise.all([
      Promise.resolve(minecraft.status()),
      e4mc.runtimeStatus().catch(() => e4mc.status()),
      cloudflare.status().catch(() => ({ enabled: false, state: 'disabled' })),
      install.status().catch((err) => ({ error: err.message })),
      java.detect().catch(() => ({ found: false })),
      mods.summary().catch(() => ({ total: 0 })),
      backups.usage().catch(() => ({ human: 'n/a' })),
    ]);
    const disk = await files.diskUsage();
    const consoleStats = minecraft.console.stats();
    return {
      at: new Date().toISOString(),
      server: {
        name: config.values.server.name,
        version: config.values.minecraft.version,
        neoforge: config.values.minecraft.neoforge_version,
        port: config.values.minecraft.port,
        adminPort: config.values.admin.port,
        publicPort: config.values.public.port,
      },
      minecraft: minecraftStatus,
      e4mc: e4mcStatus,
      cloudflare: cloudflareStatus,
      playit: playit ? await playit.runtimeStatus() : null,
      install: installStatus,
      java: javaStatus,
      mods: modsSummary,
      backups: backupUsage,
      disk,
      console: consoleStats,
      playerSummary: await players.knownPlayers().then((r) => r.counts).catch(() => null),
      publicPage: { url: cloudflare.publicUrl, enabled: config.values.public.enabled, port: config.values.public.port },
      sse: sse.stats(),
      uptime: { panel: process.uptime(), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() },
    };
  });

  router.get('/api/admin/metrics', async () => minecraft.emitMetrics());

  // Investigation reports written by the bundled Minecraft mod. Keep the
  // filename allowlist narrow so this cannot become an arbitrary file reader.
  router.get('/api/admin/admin-tools/reports', async () => {
    const directory = path.join(config.paths.serverDir, 'config', 'admintools', 'reports');
    let names = [];
    try { names = await fsp.readdir(directory); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const reports = [];
    for (const name of names.filter((value) => /^inspect-\d+\.txt$/.test(value)).sort().reverse().slice(0, 50)) {
      const file = path.join(directory, name);
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      reports.push({ name, createdAt: stat.mtime.toISOString(), size: stat.size });
    }
    return { reports };
  });

  router.get('/api/admin/admin-tools/reports/:name', async (ctx) => {
    const name = String(ctx.params.name || '');
    if (!/^inspect-\d+\.txt$/.test(name)) throw new AppError('Invalid report name.', { code: 'VALIDATION_ERROR', status: 400 });
    const file = path.join(config.paths.serverDir, 'config', 'admintools', 'reports', name);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new AppError('Report is too large to display.', { code: 'FILE_TOO_LARGE', status: 413 });
      return { name, content: await fsp.readFile(file, 'utf8') };
    } catch (err) {
      if (err.code === 'ENOENT') throw new AppError('Report not found.', { code: 'NOT_FOUND', status: 404 });
      throw err;
    }
  });

  router.get('/api/admin/admin-tools/moderation', async () => {
    const data = await readJson(path.join(config.paths.serverDir, 'config', 'admintools', 'moderation.json'), { prisons: {}, freezes: {}, sentences: {} });
    return {
      prisons: Object.values(data?.prisons || {}),
      freezes: Object.values(data?.freezes || {}),
      prisoners: Object.values(data?.sentences || {}).filter((entry) => Number(entry?.expiresAt) > Date.now()),
      sanctions: Object.values(data?.sanctions || {}).flat().filter((entry) => entry?.type === 'warn' || (entry?.type === 'mute' && Number(entry?.expiresAt) > Date.now())).slice(-100),
      notes: Object.values(data?.notes || {}).flat().slice(-100),
    };
  });

  router.get('/api/admin/system', async () => {
    const disk = await files.diskUsage();
    const load = os.loadavg?.() || [0, 0, 0];
    return {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: os.hostname(),
      cpus: cpuCount(),
      cpuModel: os.cpus()?.[0]?.model || null,
      loadAverage: load.map((v) => Math.round(v * 100) / 100),
      memory: { totalMb: totalMemoryMb(), freeMb: Math.round(os.freemem() / 1024 / 1024), totalHuman: humanBytes(os.totalmem()) },
      disk,
      uptimeS: Math.round(os.uptime()),
      panelUptimeS: Math.round(process.uptime()),
      paths: {
        project: config.paths.projectRoot,
        server: config.paths.serverDir,
        logs: config.paths.logsDir,
        backups: config.paths.backupsDir,
        files: config.filesRootDescription || config.fileRoot,
      },
    };
  });

  router.get('/api/admin/java', async () => {
    const detection = await java.detect({ force: true });
    const candidates = await java.listCandidates().catch(() => []);
    return { detection, candidates, configured: config.values.minecraft.java_path || null, required: config.requiredJava };
  });

  router.get('/api/admin/doctor', async () => doctor.run({ includeNetwork: true }));

  router.get('/api/admin/logs', async (ctx) => {
    const channel = ctx.query.channel || 'application';
    const lines = asInt(ctx.query.lines ?? 200, 'lines', { min: 1, max: 5000 });
    if (!LOG_CHANNELS.includes(channel)) {
      return sendJson(ctx.res, 200, { channels: LOG_CHANNELS, channel: null, lines: [] });
    }
    const content = await logs.readFile(channel, { lines });
    return { channels: LOG_CHANNELS, channel, lines: content };
  });

  router.get('/api/admin/logs/download', async (ctx) => {
    const channel = ctx.query.channel || 'application';
    if (!LOG_CHANNELS.includes(channel)) throw new AppError(`Unknown log channel "${channel}".`, { code: 'VALIDATION_ERROR', status: 400, hint: `Available channels: ${LOG_CHANNELS.join(', ')}.` });
    const logger = logs.get(channel);
    const content = await logs.readFile(channel, { lines: 5000 });
    const body = content.join('\n');
    ctx.res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${path.basename(logger.file)}"`,
      'content-length': Buffer.byteLength(body),
    });
    ctx.res.end(body);
    return true;
  });

  /** Server-Sent Events stream: console, status, metrics, e4mc, cloudflare, jobs. */
  router.get('/api/admin/events', async (ctx) => {
    const requested = ctx.query.types ? String(ctx.query.types).split(',').map((s) => s.trim()).filter(Boolean) : null;
    const allowedTypes = ['status', 'console', 'metrics', 'players', 'e4mc', 'cloudflare', 'playit', 'job', 'log', 'settings', 'auth'];
    const types = requested ? requested.filter((t) => allowedTypes.includes(t)) : null;
    const lastEventId = Number(ctx.req.headers['last-event-id'] || ctx.query.lastEventId || 0) || 0;
    sse.handle({ req: ctx.req, res: ctx.res, lastEventId, types });
    return true;
  });

  router.get('/api/admin/events/stats', async () => sse.stats());

  router.get('/api/admin/public-content', async () => publicStatus.contentForAdmin());

  router.get('/api/admin/api-index', async () => ({ routes: router.describe(), events: Object.keys(events).filter((k) => typeof events[k] === 'string') }));

  router.get('/api/admin/ping', async (ctx) => sendText(ctx.res, 200, 'pong'));

  // ------------------------------------------------------------ mod bridge
  // State of the in-game /panel bridge. The token itself is never part of the
  // answer (see BridgeService.status) and the "link" action copies it into the
  // mod configuration without ever showing it.
  router.get('/api/admin/system/bridge', async () => {
    if (!bridge) throw new AppError('The mod bridge is not available in this process.', { code: 'BRIDGE_NOT_CONFIGURED', status: 503 });
    return bridge.status();
  });

  router.post('/api/admin/system/bridge/link', async () => {
    if (!bridge) throw new AppError('The mod bridge is not available in this process.', { code: 'BRIDGE_NOT_CONFIGURED', status: 503 });
    const written = await bridge.writeModConfig();
    return { ...written, status: bridge.status(), message: written.message };
  });

  router.post('/api/admin/system/bridge/rotate', async () => {
    if (!bridge) throw new AppError('The mod bridge is not available in this process.', { code: 'BRIDGE_NOT_CONFIGURED', status: 503 });
    await bridge.rotate({ createdBy: 'panel request' });
    const status = bridge.status();
    return {
      status,
      message: status.linked
        ? 'A new bridge token was generated and is already in the mod configuration. Restart the Minecraft server to use it.'
        : 'A new bridge token was generated. Link it to the mod to let /panel work again.',
    };
  });
}
