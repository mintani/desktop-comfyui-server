/**
 * Settings the management UI can change, kept in one JSON file beside the
 * source. Everything here used to live in `.env` and needed a restart; the
 * environment is still read, but only as the starting value. Once a setting has
 * been saved from the UI, the stored value wins.
 *
 * Upstream secrets sit in this file in plain text. That is the same exposure
 * `.env` already had — the file is local to the machine running ComfyUI and is
 * gitignored — but it means the file deserves the same care as `.env`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { STATE_FILE } from "./config";

export type UpstreamConfig = {
  /** Stable across renames, so the UI can reorder without losing identity. */
  id: string;
  name: string;
  url: string;
  hostId: string;
  secret: string;
  enabled: boolean;
};

/**
 * How the desktop shell behaves. Kept here rather than on the Rust side so the
 * settings page can edit it like anything else; the shell reads it back and
 * applies it.
 */
export type DesktopSettings = {
  /** Start the app when the machine starts. */
  autostart: boolean;
  /** What the window's close button does. */
  closeAction: "tray" | "quit";
};

/**
 * How much work this machine takes on.
 *
 * The middle one is the reason there are three rather than a switch: wanting
 * the GPU for yourself is not the same as wanting the tool to stop.
 */
export type RunMode =
  /** Jobs from upstream servers, and runs started here. */
  | "accepting"
  /** No upstream jobs; runs started here still go. */
  | "local"
  /** Nothing starts, and ComfyUI itself is shut down. */
  | "paused";

export const RUN_MODES: RunMode[] = ["accepting", "local", "paused"];

export type Settings = {
  activeWorkflow: string | null;
  /** Where ComfyUI is checked out. Empty until someone fills it in. */
  comfyDir: string;
  /** What to run inside that directory. Empty means "work it out". */
  comfyCommand: string;
  /** Priority order: the first enabled entry is asked for work first. */
  upstreams: UpstreamConfig[];
  /**
   * What this machine will start. Never stops what is already running.
   *
   * Stored rather than reset on start, because it is a decision — coming back
   * up quietly claiming jobs again is the surprising behaviour.
   */
  mode: RunMode;
  desktop: DesktopSettings;
};

const EMPTY: Settings = {
  activeWorkflow: null,
  comfyDir: "",
  comfyCommand: "",
  upstreams: [],
  mode: "accepting",
  desktop: { autostart: false, closeAction: "tray" },
};

/**
 * Numbered `SERVER_n_*` blocks, read until the first gap. This is the value a
 * fresh install starts from; saving from the UI replaces it wholesale.
 *
 * A block with a URL but no credentials is skipped with a warning rather than
 * thrown, because the process now boots far enough to show the problem in the
 * UI, which is more useful than exiting.
 */
function upstreamsFromEnv(): UpstreamConfig[] {
  const servers: UpstreamConfig[] = [];

  for (let i = 1; ; i++) {
    const url = process.env[`SERVER_${i}_URL`];
    if (!url) break;

    const hostId = process.env[`SERVER_${i}_HOST_ID`];
    const secret = process.env[`SERVER_${i}_HOST_SECRET`];
    if (!hostId || !secret) {
      console.warn(
        `[config] SERVER_${i}_URL is set but SERVER_${i}_HOST_ID / SERVER_${i}_HOST_SECRET is missing — skipped`,
      );
      continue;
    }

    const trimmed = url.replace(/\/$/, "");
    servers.push({
      id: `env-${i}`,
      name: process.env[`SERVER_${i}_NAME`] ?? hostFromUrl(trimmed),
      url: trimmed,
      hostId,
      secret,
      enabled: true,
    });
  }

  return servers;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

let cached: Settings | null = null;

/** Files written before there were three modes stored a boolean instead. */
function normaliseMode(value: Partial<Settings> & { accepting?: unknown }): RunMode {
  if (value.mode && RUN_MODES.includes(value.mode)) return value.mode;
  if (value.accepting === false) return "paused";
  return "accepting";
}

function normaliseDesktop(raw: unknown): DesktopSettings {
  const value = (raw ?? {}) as Partial<DesktopSettings>;
  return {
    autostart: value.autostart === true,
    closeAction: value.closeAction === "quit" ? "quit" : "tray",
  };
}

function normalise(raw: unknown): Settings {
  const value = (raw ?? {}) as Partial<Settings>;
  const upstreams = Array.isArray(value.upstreams) ? value.upstreams : null;

  return {
    activeWorkflow: value.activeWorkflow ?? process.env["WORKFLOW"] ?? null,
    comfyDir: value.comfyDir ?? process.env["COMFY_DIR"] ?? "",
    comfyCommand: value.comfyCommand ?? process.env["COMFY_COMMAND"] ?? "",
    // An empty stored array is a real choice ("I removed them all"), so only a
    // missing key falls back to the environment.
    upstreams: upstreams ?? upstreamsFromEnv(),
    mode: normaliseMode(value),
    desktop: normaliseDesktop(value.desktop),
  };
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;

  try {
    cached = normalise(JSON.parse(await readFile(STATE_FILE, "utf8")));
  } catch {
    cached = normalise(null);
  }
  return cached;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  cached = next;
  await writeFile(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Only what the UI is allowed to see — secrets stay on this side. */
export function publicUpstreams(settings: Settings) {
  return settings.upstreams.map(({ secret, ...rest }) => ({
    ...rest,
    hasSecret: secret.length > 0,
  }));
}

export function newUpstreamId(): string {
  return crypto.randomUUID();
}

export { EMPTY as EMPTY_SETTINGS };
