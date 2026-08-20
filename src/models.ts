import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadSettings } from "./settings";
import type { UpstreamServer } from "./upstream";

/**
 * Keeps the local models/ directory in step with what upstream servers say
 * their workflow presets need (douga-workflow #127).
 *
 * A server hands out a manifest of models (URL + sha256 + destination), this
 * side downloads what is missing, verifies it, and reports what it holds in
 * the heartbeat's `readyModels`. The server only assigns preset jobs to hosts
 * that hold everything the preset needs, so a missing model never turns into
 * a failed run.
 *
 * The models directory comes from the ComfyUI directory in settings
 * (`<comfyDir>/models`), or `COMFY_MODELS_DIR` when set. With neither, sync
 * stays off and everything else works as before.
 */

/** Verified-hash ledger, so a restart does not re-hash tens of gigabytes. */
const STATE_FILE = ".douga-models.json";

export type ManifestModel = {
  filename: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  dest: string;
};

export type Manifest = {
  presets: Array<{ id: string; name: string; models: ManifestModel[] }>;
};

async function modelsDir(): Promise<string> {
  const override = process.env.COMFY_MODELS_DIR;
  if (override) return resolve(override);
  const settings = await loadSettings();
  return settings.comfyDir ? join(settings.comfyDir, "models") : "";
}

/** "dest/filename" — the key readiness is reported and judged by. */
function keyOf(model: ManifestModel): string {
  return `${model.dest}/${model.filename}`;
}

// The server validates too, but this side writes to the filesystem, so it
// guards itself: names with separators or dots-only could point outside models/.
function isSafeName(value: string): boolean {
  return value.length > 0 && !/[/\\]/.test(value) && value !== ".." && value !== ".";
}

function isManifestModel(value: unknown): value is ManifestModel {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.filename === "string" &&
    isSafeName(m.filename) &&
    typeof m.url === "string" &&
    typeof m.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(m.sha256) &&
    typeof m.sizeBytes === "number" &&
    typeof m.dest === "string" &&
    isSafeName(m.dest)
  );
}

export async function fetchManifest(server: UpstreamServer): Promise<Manifest | null> {
  try {
    const res = await fetch(`${server.url}/api/internal/hosts/${server.hostId}/manifest`, {
      headers: { Authorization: `Bearer ${server.secret}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Older servers have no manifest endpoint; that is not an error.
      if (res.status !== 404) {
        console.error(`[models] ${server.name} manifest rejected: HTTP ${res.status}`);
      }
      return null;
    }
    const body = (await res.json()) as { presets?: unknown };
    if (!Array.isArray(body.presets)) return null;
    const presets = body.presets.flatMap((preset) => {
      if (typeof preset !== "object" || preset === null) return [];
      const p = preset as Record<string, unknown>;
      if (typeof p.id !== "string" || typeof p.name !== "string") return [];
      const models = Array.isArray(p.models) ? p.models.filter(isManifestModel) : [];
      return [{ id: p.id, name: p.name, models }];
    });
    return { presets };
  } catch (err) {
    console.error(
      `[models] ${server.name} manifest error:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verified-hash ledger
// ---------------------------------------------------------------------------

// The ledger keeps mtime as well as the hash: a file replaced in place with the
// same size still moves its mtime, so tampering or partial writes get caught
// without re-hashing everything at every boot.
type VerifiedEntry = { sha256: string; mtimeMs: number };
type VerifiedState = Record<string, VerifiedEntry>;

function isVerifiedEntry(value: unknown): value is VerifiedEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sha256 === "string" && typeof entry.mtimeMs === "number";
}

async function loadState(dir: string): Promise<VerifiedState> {
  try {
    const file = Bun.file(join(dir, STATE_FILE));
    if (!(await file.exists())) return {};
    const parsed = (await file.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const state: VerifiedState = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isVerifiedEntry(value)) state[key] = value;
    }
    return state;
  } catch {
    return {};
  }
}

async function saveState(dir: string, state: VerifiedState): Promise<void> {
  await Bun.write(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Keys of models held and verified. The heartbeat sends this as-is. */
const ready = new Set<string>();

export function getReadyModels(): string[] {
  return [...ready].sort();
}

let syncing = false;
let warnedNoDir = false;

async function downloadModel(model: ManifestModel, target: string): Promise<void> {
  const tmp = `${target}.part`;
  const res = await fetch(model.url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

  // Hash while downloading; writing tens of gigabytes and then reading them
  // back to hash would double the disk traffic.
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(tmp).writer();
  let written = 0;
  for await (const chunk of res.body) {
    hasher.update(chunk);
    writer.write(chunk);
    written += chunk.byteLength;
  }
  await writer.end();

  const digest = hasher.digest("hex");
  if (digest !== model.sha256) {
    await rm(tmp, { force: true });
    throw new Error(`sha256 mismatch (got ${digest.slice(0, 12)}…, ${written} bytes)`);
  }
  await rename(tmp, target);
}

/**
 * Brings the local models into line with the manifests, one file at a time.
 * Sequential on purpose: the sources hand out multi-gigabyte files, and
 * parallel downloads only make failures harder to attribute. One failure
 * does not stop the rest.
 */
export async function syncModels(manifests: Manifest[]): Promise<void> {
  if (syncing) return;
  const dir = await modelsDir();
  if (!dir) {
    if (!warnedNoDir) {
      warnedNoDir = true;
      console.log("[models] no ComfyUI directory configured — preset model sync disabled");
    }
    return;
  }
  syncing = true;
  try {
    // Merge manifests from every upstream. On a key collision with a different
    // hash the first one wins — one path can only hold one file.
    const wanted = new Map<string, ManifestModel>();
    for (const manifest of manifests) {
      for (const preset of manifest.presets) {
        for (const model of preset.models) {
          const key = keyOf(model);
          const existing = wanted.get(key);
          if (existing && existing.sha256 !== model.sha256) {
            console.error(`[models] conflicting sha256 for ${key} — keeping the first one seen`);
            continue;
          }
          wanted.set(key, model);
        }
      }
    }
    if (wanted.size === 0) return;

    const state = await loadState(dir);

    for (const [key, model] of wanted) {
      if (ready.has(key)) continue;
      const destDir = join(dir, model.dest);
      const target = join(destDir, model.filename);
      try {
        await mkdir(destDir, { recursive: true });

        const existing = await stat(target).catch(() => null);
        if (existing) {
          const noted = state[key];
          // Size, noted hash and mtime all line up: nothing to re-read.
          if (
            existing.size === model.sizeBytes &&
            noted?.sha256 === model.sha256 &&
            noted.mtimeMs === existing.mtimeMs
          ) {
            ready.add(key);
            continue;
          }
          // Right size but no (or stale) note: hash it once and record it.
          if (existing.size === model.sizeBytes) {
            console.log(`[models] verifying ${key} (${existing.size} bytes)`);
            const digest = await hashFile(target);
            if (digest === model.sha256) {
              state[key] = { sha256: digest, mtimeMs: existing.mtimeMs };
              await saveState(dir, state);
              ready.add(key);
              continue;
            }
            console.error(`[models] ${key} hash mismatch — re-downloading`);
          } else {
            console.error(
              `[models] ${key} size mismatch (${existing.size} != ${model.sizeBytes}) — re-downloading`,
            );
          }
          await rm(target, { force: true });
          delete state[key];
        }

        console.log(`[models] downloading ${key} (${model.sizeBytes} bytes)`);
        await downloadModel(model, target);
        const downloaded = await stat(target);
        state[key] = { sha256: model.sha256, mtimeMs: downloaded.mtimeMs };
        await saveState(dir, state);
        ready.add(key);
        console.log(`[models] ${key} ready`);
      } catch (err) {
        console.error(`[models] ${key} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Node definitions
// ---------------------------------------------------------------------------

// Hash of the last object_info actually accepted somewhere, so an unchanged
// node set is not re-uploaded (it runs to megabytes) every sync.
let lastObjectInfoHash = "";

/**
 * Reports ComfyUI's `/object_info` to every upstream. The web workflow editor
 * builds its node palette from this; execution never reads it. Failures stay
 * out of the job path.
 */
export async function reportObjectInfo(comfyUrl: string, servers: UpstreamServer[]): Promise<void> {
  let body: string;
  try {
    const res = await fetch(`${comfyUrl.replace(/\/$/, "")}/object_info`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return;
    body = await res.text();
  } catch {
    // ComfyUI is simply down; the next cycle tries again.
    return;
  }

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  const hash = hasher.digest("hex");
  if (hash === lastObjectInfoHash) return;

  let reported = false;
  await Promise.all(
    servers.map(async (server) => {
      try {
        const res = await fetch(`${server.url}/api/internal/hosts/${server.hostId}/object-info`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${server.secret}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) reported = true;
        // Older servers have no endpoint for this (404); that is not an error.
        else if (res.status !== 404) {
          console.error(`[models] ${server.name} object-info rejected: HTTP ${res.status}`);
        }
      } catch (err) {
        console.error(
          `[models] ${server.name} object-info error:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
  if (reported) {
    lastObjectInfoHash = hash;
    console.log(`[models] object_info reported (${body.length} bytes)`);
  }
}
