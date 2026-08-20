import { dirname, join, resolve } from "node:path";

/** Repository root — `src/` sits directly under it. */
export const ROOT_DIR = dirname(import.meta.dir);

/**
 * Where everything this process writes goes. Run from source that is the
 * repository, which is what you want while developing.
 *
 * A single-file build has no such directory: `import.meta.dir` points inside
 * the executable (`/$bunfs/…`), which is read-only, so anything that saved
 * there would fail. The desktop app passes a real one in.
 */
export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : ROOT_DIR;

/** Where user-supplied API-format workflows live. */
export const WORKFLOW_DIR = process.env.WORKFLOW_DIR
  ? resolve(process.env.WORKFLOW_DIR)
  : join(DATA_DIR, "workflows");

/** Settings the UI can change: active workflow, ComfyUI directory, upstreams. */
export const STATE_FILE = join(DATA_DIR, ".state.json");

/** Local job history, kept so it survives a restart. */
export const JOBS_FILE = join(DATA_DIR, ".jobs.json");

export const COMFY_URL = (process.env.COMFY_URL ?? "http://localhost:8188").replace(/\/$/, "");

export const UI_ENABLED = (process.env.UI_ENABLED ?? "true") !== "false";

/**
 * Shared secret for the management UI. Empty means no check, which is fine on
 * loopback and is not fine anywhere else — the UI can start a process here.
 */
export const UI_TOKEN = process.env.UI_TOKEN ?? "";
export const UI_PORT = Number(process.env.UI_PORT ?? "3939");
export const UI_HOSTNAME = process.env.UI_HOSTNAME ?? "127.0.0.1";

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "5000");
export const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? "30000");

/** How long a single ComfyUI run may take before it is abandoned. */
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? "600000");

/**
 * Extra tries an upstream job gets on this machine before its failure is
 * reported. A transient failure — a network blip, ComfyUI mid-restart — is
 * cheaper to retry here than to bounce back through the job server.
 */
export const JOB_RETRIES = Number(process.env.JOB_RETRIES ?? "2");
export const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? "10000");

export const AUTO_UPDATE = (process.env.AUTO_UPDATE ?? "false") !== "false";
export const UPDATE_CHECK_INTERVAL_MS = Number(process.env.UPDATE_CHECK_INTERVAL_MS ?? "60000");

/** Workflow selected at boot when no choice has been saved from the UI yet. */
export const DEFAULT_WORKFLOW = process.env.WORKFLOW ?? null;
