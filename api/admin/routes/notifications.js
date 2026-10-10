/**
 * Admin API: Discord notifications, scheduled restarts and the MSPT monitor.
 *
 * These three integrations are all *reactive*: they are fed by the event hub,
 * so the routes here only read their real state and trigger the two actions an
 * admin can take (send a Discord test message, restart now).
 *
 * Nothing here returns the Discord webhook URL: the service only ever exposes
 * its host and its counters.
 */

import { asBool } from '../../util/validate.js';
import { AppError } from '../../util/errors.js';

export function register(router, services) {
  const { discord, restartScheduler, healthMonitor, minecraft } = services;

  // ---------------------------------------------------------------- Discord

  router.get('/api/admin/discord', async () => {
    const status = discord.status();
    return {
      discord: status,
      message: status.enabled
        ? `Discord notifications are enabled (${status.events.length} event type(s), ${status.sent} message(s) sent so far).`
        : status.configured
          ? 'A webhook URL is configured but [discord].enabled is false: nothing is posted.'
          : 'Discord notifications are not configured.',
    };
  });

  router.post('/api/admin/discord/test', async () => {
    const result = await discord.sendTest();
    return { ...result, discord: discord.status() };
  });

  // ------------------------------------------------------- scheduled restarts

  router.get('/api/admin/restart-schedule', async () => restartScheduler.status());

  router.post('/api/admin/restart-schedule/run', async (ctx) => {
    if (!asBool(ctx.body?.confirm, 'confirm', { fallback: false })) {
      throw new AppError('Restarting now requires confirmation.', {
        code: 'CONFIRMATION_REQUIRED',
        status: 428,
        hint: 'The players are warned, an optional backup is made, then the server is stopped and started again.',
      });
    }
    const result = await restartScheduler.restartNow({ reason: 'confirmed in the panel' });
    return {
      ...result,
      message: 'The restart was triggered: the players were warned and the server is coming back.',
      schedule: restartScheduler.status(),
    };
  });

  /** Re-arm the scheduler right after the configuration changed. */
  router.post('/api/admin/restart-schedule/reload', async () => {
    restartScheduler.tick();
    return { ...restartScheduler.status(), message: 'The restart schedule was re-armed from the configuration.' };
  });

  // ------------------------------------------------------------ MSPT monitor

  router.get('/api/admin/monitor', async () => {
    await healthMonitor.ready;
    const status = healthMonitor.status();
    const server = minecraft?.status?.() || {};
    return {
      monitor: status,
      server: { state: server.state, tps: server.tps ?? null, mspt: server.mspt ?? null },
      message: status.state === 'alerting'
        ? `MSPT alert active: ${status.mspt} ms per tick (threshold ${status.thresholdMs} ms).`
        : `The server is inside the MSPT threshold (${status.mspt ?? 'no sample yet'} ms per tick, threshold ${status.thresholdMs} ms).`,
    };
  });
}

export default register;
