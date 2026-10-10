/**
 * Process metrics (RAM / CPU) for the Minecraft java process.
 *
 * Platform strategies:
 *   linux   -> /proc/<pid>/statm + /proc/<pid>/stat (no subprocess at all)
 *   darwin  -> `ps -o rss=,%cpu= -p <pid>`  (whitelisted binary)
 *   win32   -> `tasklist /FI "PID eq <pid>" /FO CSV /NH` (whitelisted binary)
 *
 * Values are real measurements of the running server; when a platform cannot
 * report a metric the result is null and the UI shows "-" instead of a fake
 * number.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import { runCommand } from './proc.js';

const PAGE_SIZE = 4096;

export async function getProcessStats(pid) {
  if (!pid) return { rssMb: null, cpuPercent: null, source: 'none' };
  try {
    if (process.platform === 'linux') return await linuxStats(pid);
    if (process.platform === 'darwin') return await psStats(pid);
    if (process.platform === 'win32') return await windowsStats(pid);
  } catch {
    /* fall through to unknown */
  }
  return { rssMb: null, cpuPercent: null, source: 'unavailable' };
}

async function linuxStats(pid) {
  const statm = await fsp.readFile(`/proc/${pid}/statm`, 'utf8');
  const rssPages = Number(statm.split(/\s+/)[1]);
  const rssMb = Number.isFinite(rssPages) ? (rssPages * PAGE_SIZE) / (1024 * 1024) : null;

  let cpuPercent = null;
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    const fields = stat.slice(closeParen + 2).split(/\s+/);
    // fields[11] = utime, fields[12] = stime (0-based after the comm field)
    const utime = Number(fields[11] || 0);
    const stime = Number(fields[12] || 0);
    const starttime = Number(fields[19] || 0);
    const uptimeSeconds = os.uptime();
    const hertz = 100; // CLK_TCK is 100 on effectively all Linux builds
    const processSeconds = (utime + stime) / hertz;
    const elapsed = Math.max(1, uptimeSeconds - starttime / hertz);
    cpuPercent = Math.round((processSeconds / elapsed) * 1000) / 10;
  } catch {
    cpuPercent = null;
  }
  return { rssMb: rssMb === null ? null : Math.round(rssMb), cpuPercent, source: 'procfs' };
}

async function psStats(pid) {
  const { stdout } = await runCommand('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)], { timeoutMs: 5000 });
  const [rssKb, cpu] = stdout.trim().split(/\s+/);
  return {
    rssMb: Number.isFinite(Number(rssKb)) ? Math.round(Number(rssKb) / 1024) : null,
    cpuPercent: Number.isFinite(Number(cpu)) ? Number(cpu) : null,
    source: 'ps',
  };
}

async function windowsStats(pid) {
  const { stdout } = await runCommand('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], { timeoutMs: 8000 });
  // "java.exe","1234","Console","1","1,234,567 K"
  const match = /"([^"]+)","(\d+)","[^"]*","(\d+)","([\d\s.,]+) K"/.exec(stdout);
  if (!match) return { rssMb: null, cpuPercent: null, source: 'tasklist' };
  const kb = Number(match[4].replace(/[^\d]/g, ''));
  return { rssMb: Number.isFinite(kb) ? Math.round(kb / 1024) : null, cpuPercent: null, source: 'tasklist' };
}
