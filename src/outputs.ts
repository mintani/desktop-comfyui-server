/**
 * ComfyUI's output folder, watched and trimmed.
 *
 * Video workflows fill the disk quietly — nothing in ComfyUI ever deletes an
 * output. This keeps a cheap running total (files and bytes) for the UI, and
 * deletes files older than a chosen age: on demand from a button, and on a
 * timer when `outputCleanupDays` is set.
 *
 * Only files under the output directory are ever touched, and directories are
 * left in place. The scan is cached and redone on a slow timer rather than per
 * request — the UI polls every two seconds, and a large folder should not be
 * walked at that pace.
 */

import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pushEvent } from "./events";
import { loadSettings } from "./settings";

const SCAN_INTERVAL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export type OutputsSnapshot = {
  dir: string;
  files: number;
  bytes: number;
  scannedAt: number;
};

let snapshot: OutputsSnapshot | null = null;

/**
 * Where ComfyUI writes its outputs, mirroring how `resolveCommand` reads the
 * directory: the portable bundle keeps ComfyUI one level down.
 */
export function outputDirFor(comfyDir: string): string | null {
  if (!comfyDir) return null;
  const portable = join(comfyDir, "ComfyUI", "output");
  if (existsSync(portable)) return portable;
  const plain = join(comfyDir, "output");
  return existsSync(plain) ? plain : null;
}

async function walk(
  dir: string,
  visit: (path: string, size: number, mtimeMs: number) => void,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, visit);
    } else if (entry.isFile()) {
      const stats = await stat(path).catch(() => null);
      if (stats) visit(path, stats.size, stats.mtimeMs);
    }
  }
}

export function outputsSnapshot(): OutputsSnapshot | null {
  return snapshot;
}

export async function rescanOutputs(): Promise<OutputsSnapshot | null> {
  const dir = outputDirFor((await loadSettings()).comfyDir);
  if (!dir) {
    snapshot = null;
    return null;
  }

  let files = 0;
  let bytes = 0;
  await walk(dir, (_path, size) => {
    files += 1;
    bytes += size;
  });

  snapshot = { dir, files, bytes, scannedAt: Date.now() };
  return snapshot;
}

/** "3.2 GB" or "410 MB" — for logs and notifications, not for the record. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Delete every file older than `days` under the output folder. A file that
 * refuses to go — held open by a player, say — is skipped, not fatal: the next
 * sweep gets another chance at it.
 */
export async function trimOutputs(
  days: number,
): Promise<{ removedFiles: number; removedBytes: number }> {
  const dir = outputDirFor((await loadSettings()).comfyDir);
  if (!dir) throw new Error("no output folder found — set the ComfyUI directory first");

  const cutoff = Date.now() - days * DAY_MS;
  const doomed: { path: string; size: number }[] = [];
  await walk(dir, (path, size, mtimeMs) => {
    if (mtimeMs < cutoff) doomed.push({ path, size });
  });

  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of doomed) {
    try {
      await rm(file.path);
      removedFiles += 1;
      removedBytes += file.size;
    } catch {
      // Skipped this sweep; it stays in the count the rescan reports.
    }
  }

  await rescanOutputs();
  return { removedFiles, removedBytes };
}

/** One pass of the timer: apply the stored rule, or just refresh the count. */
async function sweep(): Promise<void> {
  const settings = await loadSettings();

  if (settings.outputCleanupDays > 0 && outputDirFor(settings.comfyDir)) {
    const { removedFiles, removedBytes } = await trimOutputs(settings.outputCleanupDays);
    if (removedFiles > 0) {
      console.log(`[outputs] removed ${removedFiles} file(s), ${formatBytes(removedBytes)}`);
      pushEvent("outputs-trimmed", {
        files: String(removedFiles),
        size: formatBytes(removedBytes),
      });
    }
    return; // trimOutputs rescanned already
  }

  await rescanOutputs();
}

export function startOutputWatch(): ReturnType<typeof setInterval> {
  void sweep();
  return setInterval(() => void sweep(), SCAN_INTERVAL_MS);
}
