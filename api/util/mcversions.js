/**
 * Minecraft / NeoForge version knowledge.
 *
 * Everything in here is derived from *verified* upstream facts, never guessed:
 *
 *  - NeoForge uses `<mcMinor>.<mcPatch>.<build>` since 1.20.2, e.g.
 *       Minecraft 1.21.1  ->  neoForge 21.1.x   (metadata: maven.neoforged.net "21.1.256")
 *       Minecraft 1.21.3  ->  neoForge 21.3.x
 *       Minecraft 1.21.4  ->  neoForge 21.4.x
 *    (verified against the NeoForge repository branches `1.21.1` and `1.21.3`,
 *     whose gradle.properties declare minecraft_version 1.21.1 / 1.21.3)
 *
 *  - Minecraft 1.21.1 requires Java 21 (NeoForge branch 1.21.1: java_version=21).
 *
 *  - Vanilla server jars come from the Mojang version manifest (piston-meta).
 *
 *  - NeoForge installers are published on maven.neoforged.net:
 *      releases/net/neoforged/neoforge/<version>/neoforge-<version>-installer.jar
 */

import { AppError } from './errors.js';

export const MOJANG_VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const NEOFORGE_MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
export const NEOFORGE_METADATA_URL = `${NEOFORGE_MAVEN_BASE}/maven-metadata.xml`;

/** Minecraft versions this manager is tested/known to work with. */
export const KNOWN_MC_VERSIONS = {
  '1.20.2': { java: 17, notes: 'NeoForge 20.2.x' },
  '1.20.4': { java: 17, notes: 'NeoForge 20.4.x' },
  '1.20.6': { java: 21, notes: 'NeoForge 20.6.x' },
  '1.21.1': { java: 21, notes: 'NeoForge 21.1.x - the version this project is configured for' },
  '1.21.3': { java: 21, notes: 'NeoForge 21.3.x' },
  '1.21.4': { java: 21, notes: 'NeoForge 21.4.x' },
  '1.21.5': { java: 21, notes: 'NeoForge 21.5.x' },
  '1.21.8': { java: 21, notes: 'NeoForge 21.8.x' },
  '1.21.11': { java: 21, notes: 'NeoForge 21.11.x' },
};

export function parseVersion(version) {
  const cleaned = String(version || '').trim();
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(cleaned);
  if (!match) return null;
  return { raw: cleaned, major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) };
}

export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  return va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
}

/** NeoForge version prefix expected for a Minecraft version ("1.21.1" -> "21.1."). */
export function neoforgePrefixFor(mcVersion) {
  const v = parseVersion(mcVersion);
  if (!v) throw new AppError(`Invalid Minecraft version "${mcVersion}".`, { code: 'INVALID_CONFIGURATION', status: 400 });
  const text = String(mcVersion).trim();
  if (text.startsWith('1.')) return `${v.minor}.${v.patch}.`;
  // Newer snapshots/releases use a leading year, e.g. 26.1 -> 26.1.
  return `${v.major}.${v.minor}.`;
}

export function neoforgeMajorMinor(mcVersion) {
  return neoforgePrefixFor(mcVersion).replace(/\.$/, '');
}

/** Required Java feature version for a Minecraft release. */
export function javaRequirementFor(mcVersion) {
  const key = String(mcVersion).trim();
  if (KNOWN_MC_VERSIONS[key]) return KNOWN_MC_VERSIONS[key].java;
  const v = parseVersion(key);
  if (!v) return 21;
  if (v.major > 1 || v.minor >= 21) return 21;
  if (v.major === 1 && (v.minor > 20 || (v.minor === 20 && v.patch >= 5))) return 21;
  if (v.major === 1 && v.minor >= 18) return 17;
  if (v.major === 1 && v.minor === 17) return 17;
  return 8;
}

/**
 * Validate a Minecraft/NeoForge pair. Returns { ok, error, hint, expectedPrefix }.
 * This is what makes "Minecraft 1.21.1 + NeoForge 21.3.253" impossible to
 * configure by accident: it fails with an explicit explanation.
 */
export function validateVersionPair(mcVersion, neoforgeVersion) {
  const prefix = neoforgePrefixFor(mcVersion);
  const nf = String(neoforgeVersion || '').trim();
  if (!/^\d+(\.\d+){2,3}([-+][A-Za-z0-9.+-]+)?$/.test(nf)) {
    return {
      ok: false,
      expectedPrefix: prefix,
      error: `NeoForge version "${neoforgeVersion}" is not a valid NeoForge version number.`,
      hint: 'NeoForge versions look like 21.1.253 (or 26.3.0.57-beta for the newest lines).',
    };
  }
  if (!nf.startsWith(prefix)) {
    const implied = prefixToMinecraft(nf);
    return {
      ok: false,
      expectedPrefix: prefix,
      error: `NeoForge ${nf} does not target Minecraft ${mcVersion} (it belongs to the ${nf.split('.').slice(0, 2).join('.')}.x line${implied ? `, i.e. Minecraft ${implied}` : ''}).`,
      hint: `For Minecraft ${mcVersion} use a NeoForge ${prefix}x build (example: ${prefix}253 for 1.21.1, or the newest from maven.neoforged.net).`,
    };
  }
  if (/alpha|beta|snapshot/i.test(nf)) {
    return {
      ok: true,
      warning: `NeoForge ${nf} is a pre-release build; pre-releases can break mods.`,
      expectedPrefix: prefix,
    };
  }
  return { ok: true, expectedPrefix: prefix };
}

/** "21.1.253" -> "1.21.1" (best effort, used for error messages). */
export function prefixToMinecraft(neoforgeVersion) {
  const parts = String(neoforgeVersion || '').split('.');
  if (parts.length < 2) return null;
  const [a, b] = parts;
  if (Number(a) >= 24) return `${a}.${b}`; // newer year based scheme
  return `1.${a}.${b}`;
}

export function isKnownPair(mcVersion, neoforgeVersion) {
  const prefix = neoforgePrefixFor(mcVersion);
  return String(neoforgeVersion).startsWith(prefix) && !/alpha|beta|snapshot/i.test(neoforgeVersion);
}

export function vanillaServerUrl(manifest, version) {
  const entry = (manifest?.versions || []).find((v) => v.id === version);
  if (!entry) return null;
  return entry.url;
}

/**
 * The small flat record the installer caches for a Minecraft version.
 *
 * Both shapes are accepted: the record this module writes (`{id, url, sha1, …}`)
 * and a raw Mojang version detail (`{id, downloads: {server: {url, sha1, size}}}`),
 * so a hand-placed manifest entry works offline too. Anything without an id, a
 * url and a checksum is refused: a half-written cache must never be trusted.
 */
export function normalizeVersionMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const server = raw.downloads?.server || raw;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const url = typeof server.url === 'string' && /^https:\/\//.test(server.url) ? server.url : null;
  const sha1 = typeof server.sha1 === 'string' && /^[0-9a-f]{40}$/i.test(server.sha1) ? server.sha1.toLowerCase() : null;
  if (!id || !url || !sha1) return null;
  const size = Number(server.size);
  return {
    id,
    url,
    sha1,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    released: raw.releaseTime || raw.released || null,
  };
}

export function neoforgeInstallerUrl(version) {
  return `${NEOFORGE_MAVEN_BASE}/${version}/neoforge-${version}-installer.jar`;
}

export function neoforgeUniversalUrl(version) {
  return `${NEOFORGE_MAVEN_BASE}/${version}/neoforge-${version}-universal.jar`;
}

/** Parse maven-metadata.xml (versions list) and keep only the requested line. */
export function parseNeoForgeMetadata(xml, { prefix = null, includePrerelease = false } = {}) {
  const versions = [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1].trim());
  return versions
    .filter((v) => (prefix ? v.startsWith(prefix) : true))
    .filter((v) => (includePrerelease ? true : !/alpha|beta|snapshot/i.test(v)))
    .map((v) => ({ version: v, prerelease: /alpha|beta|snapshot/i.test(v) }));
}

/** Compare NeoForge builds inside the same line: 21.1.9 < 21.1.10. */
export function sortNeoForgeVersions(versions) {
  return [...versions].sort((a, b) => {
    const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
    const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const x = pa[i] ?? -1;
      const y = pb[i] ?? -1;
      if (typeof x === 'number' && typeof y === 'number') {
        if (x !== y) return x - y;
      } else if (String(x) !== String(y)) {
        return String(x).localeCompare(String(y));
      }
    }
    return 0;
  });
}

/**
 * Launch layout produced by `java -jar neoforge-installer.jar --installServer`.
 * Verified for the 1.21.x installer: it writes run.sh / run.bat plus the
 * argument files under libraries/net/neoforged/neoforge/<version>/.
 */
export function neoforgeArgsFile(serverDir, version, platform = process.platform) {
  const name = platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  return {
    relative: `libraries/net/neoforged/neoforge/${version}/${name}`,
    name,
    platform: platform === 'win32' ? 'windows' : 'unix',
  };
}

/** JVM arguments recommended for a Minecraft server of this version. */
export function recommendedJvmArgs(mcVersion, { maxRamMb = 4096, minRamMb = 1024 } = {}) {
  const java = javaRequirementFor(mcVersion);
  const args = [`-Xms${minRamMb}M`, `-Xmx${maxRamMb}M`];
  if (java >= 21) {
    // Aikar-style flags trimmed to what a modded 1.21 server benefits from.
    args.push(
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem',
      '-XX:MaxTenuringThreshold=1',
      '-Dusing.aikars.flags=https://mcflags.emc.gs',
      '-Daikars.new.flags=true',
    );
  }
  return args;
}
