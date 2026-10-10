/** Admin API: player management. */

import { asString } from '../../util/validate.js';
import { ValidationError } from '../../util/errors.js';

const ACTIONS = ['kick', 'ban', 'unban', 'whitelist_add', 'whitelist_remove', 'op', 'deop', 'message'];

/** Every destructive action needs an explicit confirmation from the UI. */
const CONFIRM_REQUIRED = new Set(['kick', 'ban', 'unban', 'whitelist_remove', 'op', 'deop']);

export function register(router, services) {
  const { players, minecraft } = services;

  router.get('/api/admin/players', async (ctx) => {
    const known = await players.knownPlayers();
    return {
      ...known,
      serverState: minecraft.state,
      actions: ACTIONS,
      reason: 'Player data comes from the live console, usercache.json, whitelist.json, ops.json, banned-players.json and world/playerdata.',
    };
  });

  router.post('/api/admin/players/refresh', async () => {
    const known = await players.knownPlayers({ force: true });
    return { ...known, refreshed: true };
  });

  router.post('/api/admin/players/action', async (ctx) => {
    const action = asString(ctx.body?.action, 'action', { min: 1, max: 32, allowEmpty: false });
    if (!ACTIONS.includes(action)) {
      throw new ValidationError(`Unknown action "${action}".`, { hint: `Valid actions: ${ACTIONS.join(', ')}` });
    }
    const result = await players.action(action, {
      player: ctx.body?.player,
      reason: ctx.body?.reason,
      message: ctx.body?.message,
      confirm: ctx.body?.confirm === true,
    });
    return { ...result, message: `Sent to the Minecraft console: ${result.command}` };
  });

  router.get('/api/admin/players/history', async (ctx) => {
    const known = await players.knownPlayers();
    const player = ctx.query.player ? String(ctx.query.player).toLowerCase() : null;
    if (player) {
      return { player: known.players.find((p) => (p.name || '').toLowerCase() === player || p.uuid === ctx.query.player) || null };
    }
    return { players: known.players };
  });
}
