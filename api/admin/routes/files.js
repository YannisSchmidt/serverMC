/** Admin API: sandboxed file manager. */

import { sendJson } from '../../http/http.js';
import { asBool, asString } from '../../util/validate.js';
import { ValidationError } from '../../util/errors.js';

export function register(router, services) {
  const { files } = services;

  router.get('/api/admin/files', async (ctx) => {
    const listing = await files.list(ctx.query.path || '');
    return {
      ...listing,
      sandbox: files.describe(),
      disk: await files.diskUsage(),
    };
  });

  router.get('/api/admin/files/content', async (ctx) => {
    const target = asString(ctx.query.path, 'path', { min: 1, max: 1024, allowEmpty: false });
    return files.readFile(target);
  });

  router.put('/api/admin/files/content', async (ctx) => {
    const target = asString(ctx.body?.path, 'path', { min: 1, max: 1024, allowEmpty: false });
    const content = typeof ctx.body?.content === 'string' ? ctx.body.content : null;
    if (content === null) throw new ValidationError('"content" must be a string.');
    const expected = ctx.body?.expectedModifiedAt ? String(ctx.body.expectedModifiedAt) : null;
    const result = await files.writeFile(target, content, { expectedModifiedAt: expected });
    return { ...result, message: `${target} saved.` };
  });

  router.post('/api/admin/files/mkdir', async (ctx) => {
    const target = asString(ctx.body?.path, 'path', { min: 1, max: 1024, allowEmpty: false });
    const result = await files.mkdir(target);
    return { ...result, message: `Folder ${target} created.` };
  });

  router.post('/api/admin/files/rename', async (ctx) => {
    const from = asString(ctx.body?.from, 'from', { min: 1, max: 1024, allowEmpty: false });
    const to = asString(ctx.body?.to, 'to', { min: 1, max: 1024, allowEmpty: false });
    const result = await files.rename(from, to);
    return { ...result, message: `${from} renamed to ${to}.` };
  });

  /** Raw body upload (no multipart): the browser sends the file as the body. */
  router.put('/api/admin/files/upload', async (ctx) => {
    const dir = ctx.query.path ? String(ctx.query.path) : '';
    const name = ctx.req.headers['x-file-name'] || ctx.query.name;
    const overwrite = asBool(ctx.query.overwrite, 'overwrite', { fallback: false });
    const result = await files.saveStream(dir, name, ctx.req, {
      maxBytes: files.maxUploadBytes,
      overwrite,
    });
    return sendJson(ctx.res, 201, { ...result, message: `${result.path} uploaded (${result.sizeHuman}).` });
  });

  router.get('/api/admin/files/download', async (ctx) => {
    const target = asString(ctx.query.path, 'path', { min: 1, max: 1024, allowEmpty: false });
    const download = await files.openDownload(target);
    ctx.res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': download.size,
      'content-disposition': `attachment; filename="${download.name}"`,
    });
    download.stream.pipe(ctx.res);
    return true;
  });

  router.delete('/api/admin/files', async (ctx) => {
    const target = asString(ctx.query.path, 'path', { min: 1, max: 1024, allowEmpty: false });
    const confirm = asBool(ctx.query.confirm, 'confirm', { fallback: false });
    const recursive = asBool(ctx.query.recursive, 'recursive', { fallback: false });
    const result = await files.delete(target, { confirm, recursive });
    return { ...result, message: `${target} deleted.` };
  });
}
