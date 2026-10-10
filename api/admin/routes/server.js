/** Admin API: server lifecycle, console and commands. */

import { sendJson, readBody } from '../../http/http.js';
import { asBool, asInt, asString } from '../../util/validate.js';
import { AppError } from '../../util/errors.js';

export function register(router, services) {
  const { minecraft, console: consoleService, config, install, players } = services;

  router.get('/api/admin/server/status', async () => minecraft.status());

  router.get('/api/admin/server/preflight', async () => {
    const preflight = await minecraft.preflight();
    return {
      ...preflight,
      java: preflight.java,
      install: preflight.installStatus,
    };
  });

  router.post('/api/admin/server/start', async (ctx) => {
    const preflightOnly = asBool(ctx.body?.preflightOnly, 'preflightOnly', { fallback: false });
    if (preflightOnly) {
      const preflight = await minecraft.preflight();
      return { started: false, preflight };
    }
    const status = await minecraft.startServer({ reason: 'panel' });
    return { started: true, status, message: 'The server is starting. Open the Console page to follow the boot.' };
  });

  router.post('/api/admin/server/stop', async (ctx) => {
    const force = asBool(ctx.body?.force, 'force', { fallback: false });
    const timeoutS = asInt(ctx.body?.timeoutS ?? null, 'timeoutS', { min: 5, max: 1800, fallback: null });
    const result = await minecraft.requestStop({
      reason: 'panel request',
      force,
      timeoutMs: timeoutS ? timeoutS * 1000 : undefined,
    });
    if (!result.stopped) {
      return sendJson(ctx.res, 202, {
        stopped: false,
        message: result.message,
        hint: result.hint,
      });
    }
    return { stopped: true, message: 'The server stopped cleanly (world saved).' };
  });

  router.post('/api/admin/server/restart', async (ctx) => {
    const result = await minecraft.restart({ reason: 'panel restart' });
    return { ...result, message: result.restarting ? 'The server is stopping, it will start again automatically.' : 'The server was started.' };
  });

  router.post('/api/admin/server/kill', async (ctx) => {
    const confirm = asBool(ctx.body?.confirm, 'confirm', { fallback: false });
    if (!confirm) {
      throw new AppError('Killing the server requires confirmation.', {
        code: 'CONFIRMATION_REQUIRED', status: 428,
        hint: 'KILL terminates Java immediately: everything since the last save is lost.',
      });
    }
    const result = await minecraft.kill({ reason: 'confirmed in the panel' });
    if (!result.killed) {
      return {
        ...result,
        message: 'The Minecraft server was not running, so there was nothing to kill.',
        warning: null,
      };
    }
    return {
      ...result,
      message: `The Minecraft server (pid ${result.pid}) was killed without saving. Start it again to continue playing.`,
      warning: 'The server was killed without saving. Restart it to continue playing.',
    };
  });

  router.get('/api/admin/console', async (ctx) => {
    const lines = asInt(ctx.query.lines ?? 400, 'lines', { min: 1, max: 5000 });
    const search = ctx.query.q ? asString(ctx.query.q, 'q', { max: 200 }) : null;
    const matched = search ? consoleService.search(search, { limit: lines }) : null;
    return {
      stats: consoleService.stats(),
      state: minecraft.state,
      lines: search ? matched : consoleService.tail(lines),
      search: search ? { query: search, count: matched.length } : null,
      maxCommandLength: 512,
      history: minecraft.commandHistory.slice(-30),
    };
  });

  router.get('/api/admin/console/download', async (ctx) => {
    const body = consoleService.toText({ lines: 5000 });
    ctx.res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="minecraft-console.txt"`,
      'content-length': Buffer.byteLength(body),
    });
    ctx.res.end(body);
    return true;
  });

  router.post('/api/admin/console/clear', async () => {
    const result = consoleService.clear();
    return { ...result, message: 'The console view was cleared. logs/minecraft.log keeps the full history.' };
  });

  router.post('/api/admin/console/command', async (ctx) => {
    const command = asString(ctx.body?.command, 'command', { min: 1, max: 512, allowEmpty: false, trim: true });
    const result = minecraft.sendCommand(command);
    return { ...result, message: `Command sent to the Minecraft console: ${result.command}` };
  });

  /** Send a raw body upload? no - helpers for the console command history. */
  router.get('/api/admin/console/history', async () => ({ history: minecraft.commandHistory.slice(-50) }));

  router.post('/api/admin/console/save', async () => {
    minecraft.sendCommand('save-all');
    return { message: 'save-all sent: the world is being written to disk.' };
  });

  router.get('/api/admin/server/properties', async () => {
    const props = await install.status().then(async () => {
      const { ServerProperties } = await import('../../minecraft/ServerProperties.js');
      const instance = new ServerProperties(`${config.paths.serverDir}/server.properties`);
      await instance.load();
      return instance;
    });
    return {
      path: 'minecraft/server/server.properties',
      values: props.toObject(),
      fields: props.describe(),
      restartRequiredFor: ['server-port', 'max-players', 'online-mode', 'enable-rcon'],
    };
  });

  router.put('/api/admin/server/properties', async (ctx) => {
    const { ServerProperties } = await import('../../minecraft/ServerProperties.js');
    const instance = new ServerProperties(`${config.paths.serverDir}/server.properties`);
    await instance.load();
    instance.applyValues(ctx.body?.values || {});
    await instance.save();
    return {
      saved: true,
      values: instance.toObject(),
      restartRequired: minecraft.isRunning(),
      message: minecraft.isRunning() ? 'Saved. Restart the server to apply the changes.' : 'Saved.',
    };
  });

  router.get('/api/admin/server/players-online', async () => ({
    players: players.currentlyOnline(),
    count: players.currentlyOnline().length,
  }));

  /** Raw stdin helper kept private: the panel only exposes validated commands. */
  router.post('/api/admin/server/say', async (ctx) => {
    const message = asString(ctx.body?.message, 'message', { min: 1, max: 200, allowEmpty: false });
    minecraft.sendCommand(`say ${message.replace(/[\r\n]/g, ' ')}`);
    return { sent: true };
  });

  // Read the raw body for console uploads? (not exposed) - keep the endpoint map explicit.
  router.get('/api/admin/server/raw-logs', async (ctx) => {
    await readBody(ctx.req, { limit: 1 }); // ensures the request is drained
    return { hint: 'Use /api/admin/logs?channel=minecraft for the server log file.' };
  });
}
