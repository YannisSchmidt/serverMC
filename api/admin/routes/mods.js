/** Admin API: mod management (upload, enable/disable, delete, inspect). */

import { sendJson, readBody } from '../../http/http.js';
import { AppError } from '../../util/errors.js';
import { asBool, asString } from '../../util/validate.js';

export function register(router, services) {
  const { mods, config, sse, adminMod, events } = services;
  /** Publish a real change so the SSE stream (and Discord) can react to it. */
  const changed = (action, file) => {
    events?.publish('job', { job: 'mods', state: 'changed', action, file, at: new Date().toISOString() });
  };

  router.get('/api/admin/mods', async (ctx) => {
    const refresh = ctx.query.refresh === 'true';
    return mods.list({ refresh });
  });

  router.get('/api/admin/mods/trash', async () => ({ files: await mods.trash() }));

  /**
   * The bundled server-side admin mod (sources in mods-src/admin-tools).
   *
   * `GET`  reports whether the sources/JDK are usable, whether a jar was built
   *        and whether it is installed, without starting anything.
   * `POST` compiles it with the Gradle wrapper (through the configured JDK) and
   *        copies the jar into minecraft/server/mods.
   *
   * The build is a real Gradle run and can take several minutes on the first
   * try; its output is streamed over the `job` SSE channel, so the page shows
   * progress without polling and the request itself stays open until the end.
   */
  router.get('/api/admin/mods/admin-mod', async () => adminMod.status());

  router.post('/api/admin/mods/admin-mod/build', async (ctx) => {
    const install = ctx.body?.install === undefined ? null : asBool(ctx.body.install, 'install');
    const confirm = asBool(ctx.body?.confirm, 'confirm', { fallback: false });
    const status = await adminMod.status();
    // Replacing a jar the server already loads is a destructive-ish action: ask.
    if (status.jar.installed && !confirm) {
      throw new AppError(`admintools ${status.mod.version} is already installed in minecraft/server/mods.`, {
        code: 'CONFIRMATION_REQUIRED',
        status: 428,
        hint: 'Send {"confirm":true} to rebuild it and replace the installed jar (the Minecraft server must be restarted afterwards).',
        details: { installedPath: status.jar.installedPath },
      });
    }
    const result = await adminMod.build({ reason: 'panel request', install });
    sse.remember('job', { job: 'admin-mod-build', state: 'done', message: result.message });
    return result;
  });

  /** Raw-body upload: the browser sends the .jar as the request body. */
  router.put('/api/admin/mods/upload', async (ctx) => {
    const fileName = asString(ctx.query.name || ctx.req.headers['x-file-name'] || '', 'name', { min: 1, max: 200, allowEmpty: false });
    const replace = ctx.query.replace === 'true';
    const buffer = await readBody(ctx.req, { limit: config.maxUploadBytes });
    if (buffer.length === 0) throw new AppError('The uploaded file is empty.', { code: 'EMPTY_UPLOAD', status: 400 });
    const result = await mods.writeMod(fileName, buffer, { replace });
    sse.remember('job', { job: 'mod-upload', state: 'done', file: result.file });
    changed('uploaded', result.file);
    return sendJson(ctx.res, 201, { ...result, message: `${result.file} stored in minecraft/server/mods (${result.size} bytes).` });
  });

  router.get('/api/admin/mods/:file/inspect', async (ctx) => ({ file: ctx.params.file, entries: await mods.inspectText(ctx.params.file) }));

  router.post('/api/admin/mods/:file/enable', async (ctx) => {
    const result = await mods.setEnabled(ctx.params.file, true);
    changed('enabled', result.file);
    return result;
  });
  router.post('/api/admin/mods/:file/disable', async (ctx) => {
    const result = await mods.setEnabled(ctx.params.file, false);
    changed('disabled', result.file);
    return result;
  });

  router.delete('/api/admin/mods/:file', async (ctx) => {
    const confirm = asBool(ctx.query.confirm, 'confirm', { fallback: false });
    const result = await mods.remove(ctx.params.file, { confirm });
    changed('deleted', result.file);
    return { ...result, message: `${result.file} was moved to mods/.panel-trash (restore it manually if needed).` };
  });

  router.get('/api/admin/mods/:file/download', async (ctx) => {
    const { FilesService } = await import('../../files/FilesService.js');
    const files = services.files || new FilesService({ config, logs: services.logs });
    const download = await files.openDownload(`mods/${ctx.params.file}`);
    ctx.res.writeHead(200, {
      'content-type': 'application/java-archive',
      'content-length': download.size,
      'content-disposition': `attachment; filename="${download.name}"`,
    });
    download.stream.pipe(ctx.res);
    return true;
  });
}
