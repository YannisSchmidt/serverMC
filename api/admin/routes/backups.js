/** Admin API: backups (create, list, inspect, restore, delete, download). */

import { sendJson } from '../../http/http.js';
import { asBool, asString } from '../../util/validate.js';

export function register(router, services) {
  const { backups, minecraft } = services;

  router.get('/api/admin/backups', async () => {
    const [list, usage] = await Promise.all([backups.list(), backups.usage()]);
    return {
      ...list,
      usage,
      running: backups.running,
      serverRunning: Boolean(minecraft?.isRunning?.()),
      settings: {
        dir: usage.dir,
        includeMods: services.config.values.backups.include_mods,
        include: services.config.values.backups.include,
        keepLast: services.config.values.backups.keep_last,
        safetyBackupBeforeRestore: services.config.values.backups.safety_backup_before_restore !== false,
        autoBackupIntervalH: services.config.values.backups.auto_backup_interval_h,
      },
    };
  });

  router.post('/api/admin/backups', async (ctx) => {
    const label = asString(ctx.body?.label ?? '', 'label', { max: 32 });
    const includeMods = ctx.body?.includeMods === undefined ? null : asBool(ctx.body.includeMods, 'includeMods');
    const result = await backups.create({ label, reason: 'manual backup from the panel', includeMods });
    return sendJson(ctx.res, 201, {
      ...result,
      message: `Backup created: ${result.name} (${result.files} files, ${result.sizeHuman}).`,
    });
  });

  router.get('/api/admin/backups/:name', async (ctx) => backups.inspect(ctx.params.name));

  router.post('/api/admin/backups/:name/restore', async (ctx) => {
    const confirm = asBool(ctx.body?.confirm, 'confirm', { fallback: false });
    const restartAfter = asBool(ctx.body?.restartAfter, 'restartAfter', { fallback: false });
    const stopServer = asBool(ctx.body?.stopServer, 'stopServer', { fallback: true });
    const result = await backups.restore(ctx.params.name, { confirm, restartAfter, stopServer });
    return {
      ...result,
      message: `Restored ${result.restored.files} files from ${ctx.params.name}${result.safetyBackup ? ` (safety backup: ${result.safetyBackup})` : ''}${result.restarted ? '. The server is starting again.' : '.'}`,
    };
  });

  router.delete('/api/admin/backups/:name', async (ctx) => {
    const confirm = asBool(ctx.query.confirm, 'confirm', { fallback: false });
    const result = await backups.remove(ctx.params.name, { confirm });
    return { ...result, message: `Backup ${ctx.params.name} deleted.` };
  });

  router.get('/api/admin/backups/:name/download', async (ctx) => {
    const download = await backups.openDownload(ctx.params.name);
    ctx.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': download.size,
      'content-disposition': `attachment; filename="${download.name}"`,
    });
    download.stream.pipe(ctx.res);
    return true;
  });
}
