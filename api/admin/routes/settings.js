/** Admin API: configuration, installation and public page content. */

import { asBool, asString, asStringArray } from '../../util/validate.js';
import { AppError } from '../../util/errors.js';

export function register(router, services) {
  const { config, install, publicStatus, e4mc, events, logs, sse } = services;

  router.get('/api/admin/settings', async () => {
    const neoforgeVersions = await install.availableNeoForgeVersions({ includePrerelease: false }).catch((err) => ({ error: err.message }));
    return {
      config: config.toPublicJson(),
      editable: {
        sections: ['server', 'minecraft', 'admin', 'public', 'e4mc', 'playit', 'cloudflare', 'discord', 'restart', 'monitor', 'files', 'backups', 'logging', 'security'],
        secretKeys: ['cloudflare.api_token', 'discord.webhook_url', 'public.wake_code'],
        restartRequired: ['admin.host', 'admin.port', 'public.host', 'public.port'],
      },
      envOverrides: config.envOverrides || [],
      neoforgeVersions,
      publicContent: publicStatus.contentForAdmin(),
      configFile: 'config/config.toml',
      exampleFile: 'config/config.example.toml',
    };
  });

  router.put('/api/admin/settings', async (ctx) => {
    const patch = ctx.body?.patch;
    if (!patch || typeof patch !== 'object') throw new AppError('"patch" must be an object of sections.', { code: 'VALIDATION_ERROR', status: 400 });
    // Never let the API write raw values it did not validate: Config.update()
    // checks every key against the known schema.
    const result = await config.update(patch);
    await services.playit?.applySettings();
    // keep dependent services in sync with the new configuration
    logs.setLevel(config.values.logging.level);
    events.publish('settings', { changed: result.applied, restartRequired: result.restartRequired });
    return { ...result, message: `Configuration saved (${result.applied.length} value(s)).` };
  });

  router.get('/api/admin/settings/raw', async (ctx) => {
    const fs = await import('node:fs/promises');
    const text = await fs.readFile(config.configFile, 'utf8').catch(() => '');
    return { file: 'config/config.toml', content: text, lines: text.split('\n').length };
  });

  router.put('/api/admin/settings/public-content', async (ctx) => {
    const patch = {
      name: ctx.body?.name,
      description: ctx.body?.description,
      rules: ctx.body?.rules,
      discord: ctx.body?.discord,
      website: ctx.body?.website,
    };
    const updated = await publicStatus.updateContent(patch);
    return { publicContent: updated, message: 'The public page content was updated.' };
  });

  // ------------------------------------------------------------- installer

  router.get('/api/admin/install', async () => {
    const status = await install.status();
    const neoforgeVersions = await install.availableNeoForgeVersions({}).catch((err) => ({ error: err.message }));
    return { status, neoforgeVersions, eulaUrl: 'https://aka.ms/MinecraftEULA' };
  });

  router.get('/api/admin/install/versions', async (ctx) => {
    const includePrerelease = ctx.query.prerelease === 'true';
    return install.availableNeoForgeVersions({ includePrerelease });
  });

  router.post('/api/admin/install', async (ctx) => {
    const acceptEula = asBool(ctx.body?.acceptEula, 'acceptEula', { fallback: false });
    const includeE4mc = ctx.body?.includeE4mc === undefined ? true : asBool(ctx.body.includeE4mc, 'includeE4mc');
    if (services.minecraft.isRunning()) {
      throw new AppError('Stop the Minecraft server before installing or repairing it.', { code: 'SERVER_RUNNING', status: 409 });
    }
    const progress = [];
    sse.remember('job', { job: 'install', state: 'running' });
    events.publish('job', { job: 'install', state: 'running', message: 'Installation started' });
    const result = await install.install({
      acceptEula,
      includeE4mc,
      onProgress: (update) => {
        progress.push(update);
        events.publish('job', { job: 'install', state: 'progress', ...update });
      },
    });
    events.publish('job', { job: 'install', state: 'done', steps: result.steps });
    return {
      ...result,
      progress,
      message: `Installation finished: ${result.steps.filter((s) => s.ok).length}/${result.steps.length} step(s) ok.`,
    };
  });

  router.post('/api/admin/install/eula', async (ctx) => {
    const accept = asBool(ctx.body?.accept, 'accept', { fallback: false });
    const file = await install.writeEula(accept);
    return {
      accepted: accept,
      file: file.replace(config.paths.projectRoot, '.'),
      message: accept
        ? 'EULA accepted (eula=true). You confirmed the agreement with https://aka.ms/MinecraftEULA.'
        : 'EULA set to false: the server will refuse to start until you accept it.',
    };
  });

  router.post('/api/admin/install/jvm-args', async (ctx) => {
    const overwrite = asBool(ctx.body?.overwrite, 'overwrite', { fallback: false });
    const result = await install.writeJvmArgs({ overwrite });
    return { ...result, message: result.keptExisting ? 'The existing user_jvm_args.txt was kept (it already sets -Xmx).' : 'user_jvm_args.txt written from the configuration.' };
  });

  router.post('/api/admin/install/server-properties', async (ctx) => {
    const overwrite = asBool(ctx.body?.overwrite, 'overwrite', { fallback: false });
    const props = await install.writeServerProperties({ overwrite });
    return { values: props.toObject(), message: overwrite ? 'server.properties regenerated.' : 'Missing defaults were added to server.properties.' };
  });

  router.post('/api/admin/install/vanilla', async () => {
    const result = await install.downloadVanillaServer({});
    return { ...result, message: `Vanilla server jar ready (${result.id}).` };
  });

  router.post('/api/admin/install/e4mc', async () => {
    if (config.values.e4mc && (await install.e4mcStatus()).present) {
      return { skipped: true, message: 'The e4mc relay client is already installed.' };
    }
    const result = await install.downloadE4mcRelay({});
    return { ...result, message: `e4mcbiat ${result.tag} downloaded to the launcher folder.` };
  });

  // ------------------------------------------------------------ validation

  router.post('/api/admin/settings/validate-versions', async (ctx) => {
    const { validateVersionPair, neoforgePrefixFor, javaRequirementFor } = await import('../../util/mcversions.js');
    const minecraft = asString(ctx.body?.minecraft_version, 'minecraft_version', { min: 1, max: 32, allowEmpty: false });
    const neoforge = asString(ctx.body?.neoforge_version, 'neoforge_version', { min: 1, max: 64, allowEmpty: false });
    const pair = validateVersionPair(minecraft, neoforge);
    return {
      ...pair,
      minecraft,
      neoforge,
      expectedPrefix: pair.expectedPrefix || neoforgePrefixFor(minecraft),
      requiredJava: javaRequirementFor(minecraft),
    };
  });

  router.get('/api/admin/settings/backups-options', async () => ({
    include: config.values.backups.include,
    available: ['world', 'config', 'mods', 'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'logs'],
  }));

  router.put('/api/admin/settings/backups-include', async (ctx) => {
    const include = asStringArray(ctx.body?.include, 'include', { max: 40, maxItem: 128 });
    if (include.length === 0) throw new AppError('At least one path must be included in backups.', { code: 'VALIDATION_ERROR', status: 400 });
    const result = await config.update({
      backups: {
        include,
        include_mods: ctx.body?.include_mods === undefined ? config.values.backups.include_mods : asBool(ctx.body.include_mods, 'include_mods'),
        keep_last: ctx.body?.keep_last === undefined ? config.values.backups.keep_last : Number(ctx.body.keep_last),
        auto_backup_interval_h: ctx.body?.auto_backup_interval_h === undefined ? config.values.backups.auto_backup_interval_h : Number(ctx.body.auto_backup_interval_h),
      },
    });
    services.backups.scheduleAutoBackup();
    return { ...result, include };
  });

  router.post('/api/admin/settings/reload', async () => {
    config.reload();
    logs.setLevel(config.values.logging.level);
    await services.playit?.applySettings();
    const e4mcStatus = await e4mc.runtimeStatus();
    return { message: 'Configuration reloaded from config/config.toml.', config: config.toPublicJson(), e4mc: e4mcStatus };
  });
}
