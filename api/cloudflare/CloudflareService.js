/**
 * CloudflareService - publishes the PUBLIC status page to the internet.
 *
 * Scope, stated explicitly (project rule #26):
 *   Public web  : Internet -> Cloudflare -> cloudflared tunnel -> local public server
 *   Minecraft   : player -> e4mc relay -> local Minecraft server   (no Cloudflare)
 *
 * Cloudflare is therefore never configured as a Minecraft/TCP proxy here, and
 * the service actively refuses a tunnel configuration that would expose the
 * admin panel.
 *
 * Two integration modes, both real:
 *   1. Tunnel  - runs the official `cloudflared` binary with a generated
 *                config.yml (ingress rules) or with a remotely managed token.
 *   2. API     - optional REST calls (api.cloudflare.com/client/v4/...) to
 *                verify the API token/zone and the DNS record of the public
 *                hostname. The token stays on the backend and is never logged.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnProcess, terminateProcess, runCommand, whichSync } from '../util/proc.js';
import { AppError } from '../util/errors.js';
import { ensureDir, statOrNull, writeFileAtomic } from '../util/fsx.js';
import { fetchJson } from '../util/net.js';
import { redact, redactString } from '../util/redact.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export const CF_STATES = {
  DISABLED: 'disabled',
  MISCONFIGURED: 'misconfigured',
  READY: 'ready',
  STARTING: 'starting',
  ONLINE: 'online',
  ERROR: 'error',
  STOPPED: 'stopped',
};

export class CloudflareService {
  constructor({ config, logs, events }) {
    this.config = config;
    this.log = logs.cloudflare;
    this.events = events;
    this.child = null;
    this.state = config.values.cloudflare.enabled ? CF_STATES.STOPPED : CF_STATES.DISABLED;
    this.error = null;
    this.lastCheck = null;
    this.apiStatus = null;
    this.output = [];
    this.tunnelUrlSeen = null;
    this.mode = 'named';
  }

  // ------------------------------------------------------------- helpers

  get enabled() {
    return Boolean(this.config.values.cloudflare.enabled);
  }

  get publicUrl() {
    if (this.mode === 'quick' && this.tunnelUrlSeen) return this.tunnelUrlSeen;
    const host = this.config.values.cloudflare.public_hostname;
    if (host) return `https://${host}`;
    const domain = this.config.values.cloudflare.domain;
    return domain ? `https://${domain}` : null;
  }

  get serviceTarget() {
    const configured = this.config.values.cloudflare.tunnel_service;
    if (configured) return configured;
    return `http://127.0.0.1:${this.config.values.public.port}`;
  }

  get configFile() {
    return path.join(this.config.paths.cloudflareDir, 'config.yml');
  }

  get credentialsFile() {
    return path.join(this.config.paths.cloudflareDir, `${this.config.values.cloudflare.tunnel_name}.json`);
  }

  get binPath() {
    if (this.config.values.cloudflare.cloudflared_path) return this.config.values.cloudflare.cloudflared_path;
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const local = path.join(this.config.paths.minecraftRoot, name);
    if (fs.existsSync(local)) return local;
    return whichSync(name) || name;
  }

  isRunning() {
    return Boolean(this.child) && this.child.exitCode === null && this.child.signalCode === null;
  }

  setState(state, { reason = null, error = null } = {}) {
    const previous = this.state;
    this.state = state;
    if (error !== null) this.error = error;
    this.events?.publish('cloudflare', {
      state,
      previous,
      reason,
      url: this.publicUrl,
      error: error || undefined,
      at: new Date().toISOString(),
    });
    if (previous !== state) this.log.info(`Cloudflare state: ${previous} -> ${state}${reason ? ` (${reason})` : ''}`);
  }

  // --------------------------------------------------------------- lifecycle

  async start() {
    if (!this.enabled) {
      this.setState(CF_STATES.DISABLED, { reason: 'disabled in configuration' });
      return this.status();
    }
    if (this.config.values.cloudflare.tunnel_enabled) {
      await this.startTunnel({ reason: 'panel boot' }).catch((err) => {
        this.setState(CF_STATES.ERROR, { error: this.diagnose(err) });
      });
    } else {
      this.setState(CF_STATES.READY, { reason: 'tunnel disabled: public page stays local' });
    }
    return this.status();
  }

  async stop() {
    await this.stopTunnel({ reason: 'panel shutdown' }).catch(() => {});
  }

  /** Guard rail: the tunnel may never point at the admin panel port. */
  assertNoAdminExposure(serviceTarget = this.serviceTarget) {
    const adminPort = String(this.config.values.admin.port);
    const publicPort = String(this.config.values.public.port);
    const target = String(serviceTarget);
    const portMatch = /:(\d+)\s*$/.exec(target);
    const port = portMatch ? portMatch[1] : null;
    if (port && port === adminPort) {
      throw new AppError(`Refusing to expose the admin panel (port ${adminPort}) through the Cloudflare tunnel.`, {
        code: 'ADMIN_EXPOSURE_BLOCKED',
        status: 403,
        hint: `The tunnel must point at the public server (port ${publicPort}). Set [cloudflare].tunnel_service accordingly.`,
      });
    }
    if (port === null && /localhost|127\.0\.0\.1/.test(target) && adminPort === publicPort) {
      throw new AppError('The admin and public servers share a port; refusing to expose it.', { code: 'ADMIN_EXPOSURE_BLOCKED', status: 403 });
    }
    return true;
  }

  /** Write the cloudflared configuration file (ingress: public only). */
  async writeTunnelConfig({ overwrite = false } = {}) {
    const cf = this.config.values.cloudflare;
    const hostname = cf.public_hostname || (cf.domain ? `minecraft.${cf.domain}` : null);
    if (!hostname) {
      throw new AppError('No public hostname configured for Cloudflare.', {
        code: 'CLOUDFLARE_MISCONFIGURED', status: 400,
        hint: 'Set [cloudflare].public_hostname (for example minecraft.example.com) in the Settings page.',
      });
    }
    this.assertNoAdminExposure();
    const service = this.serviceTarget;
    const existing = await statOrNull(this.configFile);
    if (existing && !overwrite) {
      const text = await fsp.readFile(this.configFile, 'utf8');
      if (!/Managed by the local panel/.test(text)) {
        return { file: this.configFile, keptExisting: true };
      }
    }
    await ensureDir(this.config.paths.cloudflareDir);
    const content = `# Managed by the local panel - regenerated when the Cloudflare settings change.
# This tunnel publishes the PUBLIC status page only.
# It must never expose the admin panel (${this.config.values.admin.host}:${this.config.values.admin.port}).
tunnel: ${cf.tunnel_name}
credentials-file: ${this.credentialsFile}

ingress:
  - hostname: ${hostname}
    service: ${service}
    originRequest:
      connectTimeout: 10s
      # The public page is read-only and static; no websocket upgrade needed.
  # Anything else (including the admin panel) is refused by Cloudflare.
  - service: http_status:404
`;
    await writeFileAtomic(this.configFile, content, 'utf8');
    this.log.info(`Wrote the cloudflared configuration for ${hostname} -> ${service}`);
    return { file: this.configFile, hostname, service, created: !existing };
  }

  async startTunnel({ reason = 'manual', quick = false } = {}) {
    if (!quick && !this.enabled) throw new AppError('Cloudflare is disabled in the configuration.', { code: 'CLOUDFLARE_DISABLED', status: 409 });
    if (quick && !this.config.values.public.enabled) {
      throw new AppError('The player page is disabled.', { code: 'PUBLIC_PAGE_DISABLED', status: 409, hint: 'Enable the public page in Settings → Web servers, then try again.' });
    }
    if (this.isRunning()) {
      if (quick !== (this.mode === 'quick')) {
        throw new AppError('A different Cloudflare tunnel is already running.', { code: 'CLOUDFLARE_TUNNEL_RUNNING', status: 409, hint: 'Stop the current tunnel before starting the other type.' });
      }
      return { alreadyRunning: true, status: await this.status() };
    }
    const cf = this.config.values.cloudflare;

    const version = await this.detect();
    if (!version.found) {
      const error = {
        code: 'CLOUDFLARED_NOT_FOUND',
        message: 'cloudflared is not installed.',
        hint: 'Install Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ - then set [cloudflare].cloudflared_path if it is not in your PATH.',
      };
      this.setState(CF_STATES.ERROR, { error });
      throw new AppError(error.message, { code: error.code, status: 503, hint: error.hint });
    }

    const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
    let args;
    this.mode = quick ? 'quick' : 'named';
    this.tunnelUrlSeen = null;
    if (quick) {
      const target = `http://127.0.0.1:${this.config.values.public.port}`;
      this.assertNoAdminExposure(target);
      args = ['tunnel', '--no-autoupdate', '--url', target];
      this.log.info(`Starting a free temporary Quick Tunnel for the public page only (${target}).`);
    } else if (token) {
      this.log.info('Starting cloudflared with a remotely managed tunnel token (from the CLOUDFLARE_TUNNEL_TOKEN environment variable).');
      args = ['tunnel', '--no-autoupdate', 'run', '--token', token];
      // token is written to the child process only; it is never logged.
    } else {
      const configResult = await this.writeTunnelConfig({});
      const credentials = await statOrNull(this.credentialsFile);
      const cert = await statOrNull(path.join(this.config.paths.cloudflareDir, 'cert.pem'));
      if (!credentials && !cert) {
        const error = {
          code: 'CLOUDFLARE_CREDENTIALS_MISSING',
          message: `No tunnel credentials found (${this.credentialsFile}).`,
          hint: `Create the tunnel once with: cloudflared tunnel login  &&  cloudflared tunnel create ${cf.tunnel_name}  - the credentials file must be placed in ${this.config.paths.cloudflareDir}. Alternatively provide CLOUDFLARE_TUNNEL_TOKEN in .env for a remotely managed tunnel.`,
        };
        this.setState(CF_STATES.MISCONFIGURED, { error });
        throw new AppError(error.message, { code: error.code, status: 503, hint: error.hint });
      }
      args = ['tunnel', '--no-autoupdate', '--config', this.configFile, 'run', cf.tunnel_name];
    }

    this.assertNoAdminExposure(quick ? `http://127.0.0.1:${this.config.values.public.port}` : this.serviceTarget);
    this.setState(CF_STATES.STARTING, { reason });
    this.output = [];
    this.log.info(`Starting cloudflared (${args[0]} ... run) for ${this.publicUrl || 'the configured hostname'}...`);

    let child;
    try {
      child = spawnProcess(this.binPath, args, { cwd: this.config.paths.cloudflareDir });
    } catch (err) {
      const error = this.diagnose(err);
      this.setState(CF_STATES.ERROR, { error });
      throw new AppError(error.message, { code: error.code, status: 500, hint: error.hint });
    }
    this.child = child;
    this.error = null;

    const handleLine = (line, stream) => {
      const text = redactString(String(line).trim());
      if (!text) return;
      this.output.push({ at: new Date().toISOString(), stream, text });
      if (this.output.length > 300) this.output.shift();
      this.log.info(text);
      const url = /(https:\/\/[a-z0-9.-]+\.(?:trycloudflare\.com|cfargotunnel\.com|[a-z0-9.-]+))/i.exec(text);
      if (url && /trycloudflare/.test(text)) this.tunnelUrlSeen = url[1];
      if (url && /trycloudflare/.test(text)) {
        this.events?.publish('cloudflare', { state: this.state, url: this.tunnelUrlSeen, mode: 'quick' });
      }
      if (/Registered tunnel connection|Connection .* registered|Initial protocol/i.test(text)) {
        this.setState(CF_STATES.ONLINE, { reason: 'tunnel connections registered' });
      }
      if (/You are hitting rate limits|error code: 10\d\d|Invalid tunnel secret|failed to (?:connect|start)|unable to (?:find|open)/i.test(text)) {
        this.error = this.diagnose(new Error(text));
      }
    };
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach((l) => handleLine(l, 'stdout'));
    });
    child.stderr.on('data', (chunk) => String(chunk).split(/\r?\n/).forEach((l) => l.trim() && handleLine(l, 'stderr')));
    child.on('error', (err) => this.setState(CF_STATES.ERROR, { error: this.diagnose(err) }));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.log.warn(`cloudflared exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).`);
      if (this._stopping) {
        this.setState(CF_STATES.STOPPED, { reason: 'tunnel stopped' });
        return;
      }
      const error = this.error || this.diagnose(new Error(`cloudflared exited with code ${code}`));
      this.setState(CF_STATES.ERROR, { reason: 'tunnel process exited', error });
    });

    // give cloudflared a moment to fail fast (bad credentials, no network)
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { started: true, pid: child.pid, status: await this.status() };
  }

  async stopTunnel({ reason = 'manual stop' } = {}) {
    if (!this.isRunning()) {
      if (this.enabled) this.setState(CF_STATES.STOPPED, { reason });
      this.tunnelUrlSeen = null;
      this.mode = 'named';
      return { stopped: true, alreadyStopped: true };
    }
    this._stopping = true;
    this.log.info(`Stopping the Cloudflare tunnel (${reason})...`);
    await terminateProcess(this.child, { graceMs: 8000 });
    this.child = null;
    this._stopping = false;
    this.tunnelUrlSeen = null;
    this.mode = 'named';
    this.setState(CF_STATES.STOPPED, { reason });
    return { stopped: true };
  }

  async restartTunnel() {
    await this.stopTunnel({ reason: 'restart requested' });
    return this.startTunnel({ reason: 'restart' });
  }

  /** Turn an execution error into an actionable explanation. */
  diagnose(err) {
    const message = redactString(err?.message || String(err));
    if (/ENOENT|not found/i.test(message)) {
      return { code: 'CLOUDFLARED_NOT_FOUND', message: 'cloudflared is not installed or not in PATH.', hint: 'Download it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ and set [cloudflare].cloudflared_path.', detail: message };
    }
    if (/credentials|secret|tunnel .* not found/i.test(message)) {
      return { code: 'CLOUDFLARE_CREDENTIALS_INVALID', message: 'The tunnel credentials are missing or invalid.', hint: `Run: cloudflared tunnel login, then cloudflared tunnel create ${this.config.values.cloudflare.tunnel_name}, and place the generated json in ${this.config.paths.cloudflareDir}.`, detail: message };
    }
    if (/Unable to reach|dial tcp|no such host|Get "https:\/\//i.test(message)) {
      return { code: 'CLOUDFLARE_UNREACHABLE', message: 'Cloudflare could not be reached from this computer.', hint: 'Check your internet connection, DNS and firewall. The Minecraft server and the local panel keep working without Cloudflare.', detail: message };
    }
    if (/port is already in use|address already in use/i.test(message)) {
      return { code: 'PORT_IN_USE', message: 'A port needed by the tunnel is already in use.', hint: 'Stop the other cloudflared/tunnel process and retry.', detail: message };
    }
    return { code: 'CLOUDFLARE_ERROR', message: `cloudflared reported an error: ${message}`, hint: 'See the log lines above; the panel keeps working locally.', detail: message };
  }

  async detect() {
    const bin = this.binPath;
    try {
      const { stdout, stderr, code } = await runCommand(bin, ['--version'], { timeoutMs: 10000 });
      const output = `${stdout}${stderr}`.trim();
      this.binary = { found: code === 0, path: bin, version: output.split(/\s+/).find((p) => /^\d+\.\d+/.test(p)) || output.split('\n')[0] || null, output: redactString(output) };
    } catch (err) {
      this.binary = { found: false, path: bin, error: err.code === 'ENOENT' ? 'cloudflared was not found in PATH.' : err.message };
    }
    return this.binary;
  }

  // ------------------------------------------------------------- Cloudflare API

  /**
   * Verify the API token and (when a hostname is set) the DNS record of the
   * public hostname. Read-only calls, backend only.
   */
  async verifyApi({ force = false } = {}) {
    const cf = this.config.values.cloudflare;
    const token = cf.api_token || process.env.CLOUDFLARE_API_TOKEN || '';
    const zoneId = cf.zone_id;
    if (!token || !zoneId) {
      this.apiStatus = {
        ok: false,
        skipped: true,
        message: !token ? 'No Cloudflare API token configured (optional).' : 'No zone id configured (optional).',
      };
      return this.apiStatus;
    }
    if (!force && this.apiStatus?.checkedAt && Date.now() - Date.parse(this.apiStatus.checkedAt) < 60000) return this.apiStatus;

    const result = { checkedAt: new Date().toISOString(), ok: false, token: { ok: false }, zone: null, dns: null };
    try {
      const verify = await fetchJson(`${CLOUDFLARE_API}/user/tokens/verify`, {
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 15000,
        maxBytes: 64 * 1024,
      });
      result.token = { ok: Boolean(verify?.success), status: verify?.result?.status || null };
      if (!verify?.success) {
        result.message = `Cloudflare rejected the API token: ${(verify?.errors || []).map((e) => e.message).join('; ') || 'unknown error'}`;
        result.hint = 'Create a token with the "Zone:Read" and "DNS:Read" permissions for this domain.';
        this.apiStatus = result;
        return result;
      }
      const zone = await fetchJson(`${CLOUDFLARE_API}/zones/${zoneId}`, {
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 15000,
        maxBytes: 256 * 1024,
      });
      result.zone = zone?.success ? { id: zone.result.id, name: zone.result.name, status: zone.result.status } : { error: (zone?.errors || []).map((e) => e.message).join('; ') };
      const hostname = cf.public_hostname;
      if (hostname) {
        const records = await fetchJson(`${CLOUDFLARE_API}/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`, {
          headers: { authorization: `Bearer ${token}` },
          timeoutMs: 15000,
          maxBytes: 512 * 1024,
        });
        const list = (records?.result || []).map((r) => ({ type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl }));
        result.dns = {
          ok: list.length > 0,
          records: list,
          message: list.length ? null : `No DNS record found for ${hostname}.`,
          hint: list.length ? null : `Create it with: cloudflared tunnel route dns ${this.config.values.cloudflare.tunnel_name} ${hostname}`,
        };
      }
      result.ok = result.token.ok && Boolean(result.zone?.id) && (result.dns ? result.dns.ok : true);
      if (!result.ok && !result.message) {
        result.message = result.dns && !result.dns.ok ? result.dns.message : 'Cloudflare reported a configuration problem.';
        result.hint = result.dns?.hint || null;
      }
    } catch (err) {
      result.error = redactString(err.message);
      result.message = `Cloudflare API call failed: ${redactString(err.message)}`;
      result.hint = 'The API is optional - only the status display is affected.';
    }
    // never keep the token inside the cached result
    this.apiStatus = redact(result);
    this.events?.publish('cloudflare', { state: this.state, api: this.apiStatus, url: this.publicUrl });
    return this.apiStatus;
  }

  // ------------------------------------------------------------------ status

  async status() {
    const cf = this.config.values.cloudflare;
    const [configStat, credStat] = await Promise.all([
      statOrNull(this.configFile),
      statOrNull(this.credentialsFile),
    ]);
    let configHostname = null;
    let configService = null;
    if (configStat) {
      const text = await fsp.readFile(this.configFile, 'utf8').catch(() => '');
      configHostname = /hostname:\s*(\S+)/.exec(text)?.[1] || null;
      configService = /service:\s*(\S+)/.exec(text)?.[1] || null;
    }
    const binary = this.binary || (this.enabled ? await this.detect() : { found: false, path: this.binPath });
    const expected = this.publicUrl;
    return {
      enabled: this.enabled || (this.mode === 'quick' && this.isRunning()),
      tunnelEnabled: Boolean(cf.tunnel_enabled),
      state: this.state,
      online: this.state === CF_STATES.ONLINE,
      running: this.isRunning(),
      pid: this.child?.pid ?? null,
      domain: cf.domain || null,
      hostname: cf.public_hostname || configHostname || null,
      url: expected,
      mode: this.mode === 'quick' ? 'quick-tunnel' : cf.tunnel_enabled ? 'tunnel' : 'external-proxy',
      service: this.mode === 'quick' ? `http://127.0.0.1:${this.config.values.public.port}` : this.serviceTarget,
      tunnelName: cf.tunnel_name,
      tunnelServiceTokenProvided: Boolean(process.env.CLOUDFLARE_TUNNEL_TOKEN),
      location: {
        configFile: this.configFile,
        configExists: Boolean(configStat),
        credentialsFile: this.credentialsFile,
        credentialsExist: Boolean(credStat),
        dir: this.config.paths.cloudflareDir,
      },
      cloudflared: binary,
      tokenConfigured: Boolean(cf.api_token || process.env.CLOUDFLARE_API_TOKEN),
      zoneConfigured: Boolean(cf.zone_id),
      api: this.apiStatus,
      error: this.error,
      lastCheck: this.lastCheck,
      adminExposureBlocked: true,
      notes: [
        'Cloudflare publishes the public status page only.',
        'Minecraft players connect through the e4mc address - Cloudflare is not a Minecraft proxy.',
        `The admin panel (port ${this.config.values.admin.port}) is never exposed by the tunnel.`,
      ],
      tail: this.output.slice(-10),
    };
  }

  /** Optional action: verify DNS + API + local public service in one go. */
  async test({ writeConfig = false } = {}) {
    this.lastCheck = new Date().toISOString();
    const result = { at: this.lastCheck, checks: {} };
    result.checks.binary = await this.detect();
    result.checks.config = writeConfig ? await this.writeTunnelConfig({}).catch((err) => ({ error: err.message })) : { file: this.configFile, exists: Boolean(await statOrNull(this.configFile)) };
    result.checks.credentials = { file: this.credentialsFile, exists: Boolean(await statOrNull(this.credentialsFile)), tokenMode: Boolean(process.env.CLOUDFLARE_TUNNEL_TOKEN) };
    result.checks.adminExposure = (() => {
      try {
        this.assertNoAdminExposure();
        return { ok: true, message: 'The tunnel target is not the admin panel.' };
      } catch (err) {
        return { ok: false, message: err.message, hint: err.hint };
      }
    })();
    result.checks.api = await this.verifyApi({ force: true });
    try {
      const local = await fetchJson(`http://127.0.0.1:${this.config.values.public.port}/api/public/status`, { timeoutMs: 5000, maxBytes: 64 * 1024 });
      result.checks.localPublicService = { ok: true, online: local?.online ?? null };
    } catch (err) {
      result.checks.localPublicService = { ok: false, error: redactString(err.message), hint: `The public server should be listening on port ${this.config.values.public.port}.` };
    }
    result.ok = result.checks.binary.found && result.checks.adminExposure.ok !== false;
    return result;
  }

  /** Persist Cloudflare settings (secrets are only written to config/config.toml). */
  async updateSettings(patch) {
    const allowed = ['enabled', 'domain', 'public_hostname', 'zone_id', 'api_token', 'tunnel_enabled', 'tunnel_name', 'cloudflared_path', 'tunnel_service'];
    const clean = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (allowed.includes(key)) clean[key] = value;
    }
    // guard: never let the tunnel point at the admin port
    if (clean.tunnel_service) this.assertNoAdminExposure(clean.tunnel_service);
    const result = await this.config.update({ cloudflare: clean });
    if (clean.enabled !== undefined && clean.enabled === false && this.isRunning()) {
      await this.stopTunnel({ reason: 'disabled in settings' });
    }
    return result;
  }
}
