/** Default configuration. Mirrors config/config.example.toml. */

export const DEFAULTS = {
  server: {
    name: 'Minecraft Server',
    locale: 'en',
  },
  minecraft: {
    version: '1.21.1',
    neoforge_version: '21.1.253',
    server_dir: 'minecraft/server',
    java_path: '',
    port: 25565,
    host: '0.0.0.0',
    online_mode: true,
    min_ram_mb: 1024,
    max_ram_mb: 4096,
    jvm_args: [],
    server_args: [],
    auto_start: false,
    accept_eula: false,
    shutdown_timeout_s: 90,
    start_timeout_s: 300,
    stop_on_panel_exit: true,
  },
  admin: {
    host: '127.0.0.1',
    port: 8080,
    auth_enabled: true,
  },
  public: {
    enabled: true,
    host: '0.0.0.0',
    port: 8081,
    // ---- wake-up for players (the ONE write route of the public listener) ----
    // allow_power_on + wake_code together decide whether players may start the
    // server from the public page. An empty code closes the door completely, so
    // a default installation never exposes a way to start anything.
    allow_power_on: true,
    wake_code: '',
    power_code_max_attempts: 5,
    power_code_window_min: 10,
  },
  e4mc: {
    enabled: true,
    jar_path: 'minecraft/launcher/e4mcbiat.jar',
    auto_download: true,
    port: 0,
    manual_address: '',
    autostart_with_server: true,
    connect_timeout_s: 60,
  },
  playit: {
    enabled: false,
    agent_path: 'minecraft/launcher/playit.exe',
    client_path: 'C:/Program Files/playit_gg/bin/playit.exe',
    address: '',
    autostart_with_server: true,
  },
  cloudflare: {
    enabled: false,
    domain: '',
    public_hostname: '',
    zone_id: '',
    api_token: '',
    tunnel_enabled: false,
    tunnel_name: 'minecraft-panel',
    cloudflared_path: '',
    tunnel_service: '',
  },
  files: {
    root: '',
    max_upload_mb: 512,
    max_edit_kb: 2048,
  },
  admin_mod: {
    // Sources of the bundled server-side admin mod (mods-src/admin-tools).
    source_dir: 'mods-src/admin-tools',
    // Build with the Gradle wrapper through the configured JDK: no `gradle`
    // command is ever executed, the wrapper is started with `java` itself.
    build_timeout_s: 1800,
    build_xmx_mb: 1024,
    // Copy the built jar into minecraft/server/mods once the build succeeds.
    auto_install: true,
  },
  bridge: {
    // Local bridge used by the in-game /panel command of the bundled admin mod.
    enabled: true,
    // false = the mod can read the panel state but cannot start/stop/restart
    // the Minecraft server through it.
    allow_server_actions: true,
  },
  discord: {
    // Discord webhook notifications. The webhook URL is a secret: it is masked
    // in the API, never logged and never sent back to the browser.
    enabled: false,
    webhook_url: '',
    // Optional cosmetics of the webhook message.
    username: '',
    avatar_url: '',
    // Which events are posted. See api/discord/EVENTS for the accepted names.
    events: [
      'server_start', 'server_stop', 'server_crash',
      'player_join', 'player_leave',
      'backup', 'restore', 'mod',
      'e4mc', 'cloudflare',
      'performance',
    ],
    // Optional role mentioned on performance alerts ("<@&role id>").
    mention_role_id: '',
  },
  restart: {
    // Scheduled restarts. Times are local wall clock, 24h "HH:MM".
    enabled: false,
    times: ['04:00'],
    // Players are warned this many minutes before the restart.
    warn_minutes: [10, 5, 1],
    // Make a backup right before restarting.
    auto_backup: true,
  },
  monitor: {
    // MSPT (milliseconds per tick) alert: the panel reads the real tick times
    // the server prints, so 50 ms means 20 TPS and 100 ms means 10 TPS.
    mspt_alert_ms: 60,
    mspt_sustain_min: 5,
    alert_cooldown_min: 30,
  },
  backups: {
    dir: 'backups',
    include: ['world', 'config', 'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json'],
    include_mods: false,
    keep_last: 0,
    safety_backup_before_restore: true,
    auto_backup_interval_h: 0,
  },
  logging: {
    dir: 'logs',
    level: 'info',
    max_file_mb: 8,
    max_files: 5,
  },
  security: {
    session_ttl_h: 12,
    session_idle_min: 120,
    login_max_attempts: 5,
    login_window_min: 15,
    cookie_secure: 'auto',
    // Forwarded client headers are spoofable unless a trusted proxy overwrites them.
    trust_proxy: false,
    allow_iframe: false,
    generated_password_length: 20,
  },
};

/** Environment variable -> config path mapping (env wins over the TOML file). */
export const ENV_MAP = {
  SERVER_NAME: 'server.name',
  LOCALE: 'server.locale',
  MINECRAFT_VERSION: 'minecraft.version',
  NEOFORGE_VERSION: 'minecraft.neoforge_version',
  MINECRAFT_DIR: 'minecraft.server_dir',
  MINECRAFT_PORT: 'minecraft.port',
  JAVA_PATH: 'minecraft.java_path',
  MC_MIN_RAM_MB: 'minecraft.min_ram_mb',
  MC_MAX_RAM_MB: 'minecraft.max_ram_mb',
  MC_AUTO_START: 'minecraft.auto_start',
  MC_ACCEPT_EULA: 'minecraft.accept_eula',
  ADMIN_HOST: 'admin.host',
  ADMIN_PORT: 'admin.port',
  ADMIN_AUTH_ENABLED: 'admin.auth_enabled',
  PUBLIC_ENABLED: 'public.enabled',
  PUBLIC_HOST: 'public.host',
  PUBLIC_PORT: 'public.port',
  PUBLIC_ALLOW_POWER_ON: 'public.allow_power_on',
  PUBLIC_WAKE_CODE: 'public.wake_code',
  PUBLIC_POWER_MAX_ATTEMPTS: 'public.power_code_max_attempts',
  PUBLIC_POWER_WINDOW_MIN: 'public.power_code_window_min',
  E4MC_ENABLED: 'e4mc.enabled',
  E4MC_JAR_PATH: 'e4mc.jar_path',
  E4MC_AUTO_DOWNLOAD: 'e4mc.auto_download',
  E4MC_PORT: 'e4mc.port',
  E4MC_MANUAL_ADDRESS: 'e4mc.manual_address',
  E4MC_AUTOSTART: 'e4mc.autostart_with_server',
  PLAYIT_ENABLED: 'playit.enabled',
  PLAYIT_AGENT_PATH: 'playit.agent_path',
  PLAYIT_CLIENT_PATH: 'playit.client_path',
  PLAYIT_ADDRESS: 'playit.address',
  PLAYIT_AUTOSTART: 'playit.autostart_with_server',
  CLOUDFLARE_ENABLED: 'cloudflare.enabled',
  CLOUDFLARE_DOMAIN: 'cloudflare.domain',
  CLOUDFLARE_PUBLIC_HOSTNAME: 'cloudflare.public_hostname',
  CLOUDFLARE_ZONE_ID: 'cloudflare.zone_id',
  CLOUDFLARE_API_TOKEN: 'cloudflare.api_token',
  CLOUDFLARE_TUNNEL_ENABLED: 'cloudflare.tunnel_enabled',
  CLOUDFLARE_TUNNEL_NAME: 'cloudflare.tunnel_name',
  CLOUDFLARED_PATH: 'cloudflare.cloudflared_path',
  CLOUDFLARE_TUNNEL_SERVICE: 'cloudflare.tunnel_service',
  BRIDGE_ENABLED: 'bridge.enabled',
  DISCORD_ENABLED: 'discord.enabled',
  DISCORD_WEBHOOK_URL: 'discord.webhook_url',
  DISCORD_MENTION_ROLE_ID: 'discord.mention_role_id',
  RESTART_ENABLED: 'restart.enabled',
  RESTART_TIMES: 'restart.times',
  RESTART_WARN_MINUTES: 'restart.warn_minutes',
  MONITOR_MSPT_ALERT_MS: 'monitor.mspt_alert_ms',
  MONITOR_MSPT_SUSTAIN_MIN: 'monitor.mspt_sustain_min',
  MONITOR_ALERT_COOLDOWN_MIN: 'monitor.alert_cooldown_min',
  BRIDGE_ALLOW_SERVER_ACTIONS: 'bridge.allow_server_actions',
  FILES_ROOT: 'files.root',
  FILES_MAX_UPLOAD_MB: 'files.max_upload_mb',
  FILES_MAX_EDIT_KB: 'files.max_edit_kb',
  BACKUP_DIR: 'backups.dir',
  BACKUP_INCLUDE_MODS: 'backups.include_mods',
  BACKUP_KEEP_LAST: 'backups.keep_last',
  BACKUP_AUTO_INTERVAL_H: 'backups.auto_backup_interval_h',
  LOG_LEVEL: 'logging.level',
  LOG_DIR: 'logging.dir',
  LOG_MAX_FILE_MB: 'logging.max_file_mb',
  SESSION_TTL_H: 'security.session_ttl_h',
  SESSION_IDLE_MIN: 'security.session_idle_min',
  LOGIN_MAX_ATTEMPTS: 'security.login_max_attempts',
  LOGIN_WINDOW_MIN: 'security.login_window_min',
  COOKIE_SECURE: 'security.cookie_secure',
  TRUST_PROXY: 'security.trust_proxy',
  ALLOW_IFRAME: 'security.allow_iframe',
};
