/**
 * Starting and stopping ComfyUI itself.
 *
 * ComfyUI is often already running when this server starts — someone launched
 * it by hand. So there are two separate facts to keep apart: whether ComfyUI
 * answers on `COMFY_URL` (that is `status.ts`), and whether *this* process is
 * the one that launched it (that is here). Only the second one can be stopped
 * from the UI.
 *
 * The command comes from the settings file, never from the request body. A
 * request can only say "start" or "stop" — it cannot say what to run. That
 * still means anyone who can reach the management UI can run the configured
 * command, which is why the UI binds to 127.0.0.1 unless you change it.
 *
 * A managed child that dies without being asked is restarted (see the watchdog
 * constants below); only `stopComfy` — the Stop buttons and the Stopped mode —
 * counts as being asked.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSettings } from "./settings";

export type ComfyProcessState = {
  /** True while this process holds a live ComfyUI child. */
  managed: boolean;
  pid: number | null;
  startedAt: number | null;
  /** Why the last start or stop failed, cleared by the next successful one. */
  error: string | null;
  /** Tail of the child's output — the fastest way to see a wrong command. */
  log: string[];
  /** What would run, resolved from the settings. Empty when not configured. */
  command: string;
  dir: string;
};

const LOG_LINES = 40;

/**
 * The watchdog. A machine that serves jobs unattended is only as reliable as
 * the ComfyUI under it, so a managed child that dies without being asked is
 * started again. A child that keeps dying moments after starting is a broken
 * command, not a hiccup — after three of those in a row it stops trying, and
 * the log holds the reason.
 */
const RESTART_DELAY_MS = 5000;
const FAST_FAIL_MS = 60_000;
const MAX_FAST_FAILS = 3;

let child: Bun.Subprocess | null = null;
let startedAt: number | null = null;
let lastError: string | null = null;
const log: string[] = [];

/** True between a successful start and a requested stop: "keep it running". */
let wanted = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive deaths within {@link FAST_FAIL_MS} of starting. */
let fastFails = 0;

function note(line: string): void {
  for (const part of line.split("\n")) {
    const text = part.trimEnd();
    if (!text) continue;
    log.push(text);
  }
  if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
}

/**
 * Split a command the user typed. Spaces separate arguments, but a quoted run
 * of them does not — on Windows the interpreter usually lives under a path with
 * a space in it, so this is not an edge case there.
 */
function splitCommand(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

/**
 * What to run in the ComfyUI directory. A checkout usually has a virtualenv
 * beside `main.py`, and using its interpreter is what people mean by "start
 * ComfyUI" — falling back to a bare `python` would pick the wrong packages.
 */
export function resolveCommand(dir: string, override: string): string[] {
  if (override.trim()) return splitCommand(override.trim());
  if (!dir) return [];

  // ComfyUI_windows_portable, which is how most people on Windows have it: an
  // embedded interpreter beside a ComfyUI folder rather than inside it. This is
  // what the `run_*.bat` in that download runs.
  const embedded = join(dir, "python_embeded", "python.exe");
  if (existsSync(embedded) && existsSync(join(dir, "ComfyUI", "main.py"))) {
    return [embedded, "-s", join("ComfyUI", "main.py")];
  }

  const candidates = [
    join(dir, ".venv", "bin", "python"),
    join(dir, "venv", "bin", "python"),
    join(dir, ".venv", "Scripts", "python.exe"),
    join(dir, "venv", "Scripts", "python.exe"),
  ];
  // `python3` is not a command on Windows; asking for it opens the Store.
  const fallback = process.platform === "win32" ? "python" : "python3";
  const python = candidates.find((path) => existsSync(path)) ?? fallback;

  return [python, "main.py"];
}

export async function comfyProcessState(): Promise<ComfyProcessState> {
  const settings = await loadSettings();
  return {
    managed: child !== null,
    pid: child?.pid ?? null,
    startedAt,
    error: lastError,
    log: [...log],
    command: resolveCommand(settings.comfyDir, settings.comfyCommand).join(" "),
    dir: settings.comfyDir,
  };
}

export async function startComfy(): Promise<void> {
  if (child) throw new Error("ComfyUI is already running here");

  const settings = await loadSettings();
  if (!settings.comfyDir) {
    throw new Error("set the ComfyUI directory on the ComfyUI page first");
  }
  if (!existsSync(settings.comfyDir)) {
    throw new Error(`no such directory: ${settings.comfyDir}`);
  }

  const command = resolveCommand(settings.comfyDir, settings.comfyCommand);
  if (command.length === 0) throw new Error("nothing to run — set a start command");

  log.length = 0;
  lastError = null;
  fastFails = 0;
  wanted = true;
  launch(command, settings.comfyDir);
}

function launch(command: string[], dir: string): void {
  note(`$ ${command.join(" ")}`);

  const spawned = Bun.spawn(command, {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    onExit(_proc, exitCode, signalCode) {
      note(`— exited (code ${exitCode ?? "null"}${signalCode ? `, ${signalCode}` : ""})`);
      if (child !== spawned) return;

      const uptime = Date.now() - (startedAt ?? Date.now());
      child = null;
      startedAt = null;
      // A non-zero exit with nothing asked of it is a failure worth surfacing.
      if (exitCode !== 0 && signalCode === null) {
        lastError = `ComfyUI exited with code ${exitCode}`;
      }
      maybeRestart(uptime);
    },
  });

  child = spawned;
  startedAt = Date.now();

  void drain(spawned.stdout);
  void drain(spawned.stderr);
}

/** Called with how long the child lived, after every exit nobody asked for. */
function maybeRestart(uptimeMs: number): void {
  if (!wanted) return;

  // A death after a long run gets a fresh allowance; one right after starting
  // spends it.
  fastFails = uptimeMs < FAST_FAIL_MS ? fastFails + 1 : 1;

  if (fastFails > MAX_FAST_FAILS) {
    wanted = false;
    lastError = "ComfyUI keeps crashing right after starting — not restarting, check the log";
    note(`— ${lastError}`);
    return;
  }

  note(`— restarting in ${RESTART_DELAY_MS / 1000} s (crash ${fastFails}/${MAX_FAST_FAILS})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restart();
  }, RESTART_DELAY_MS);
}

/**
 * The automatic path back up. Unlike {@link startComfy} it keeps the log, so
 * the crash that caused it stays readable, and it re-reads the settings so a
 * directory fixed in the meantime is what gets run.
 */
async function restart(): Promise<void> {
  // Someone pressed Stop during the delay, or Start beat the timer to it.
  if (!wanted || child) return;

  const settings = await loadSettings();
  const command = resolveCommand(settings.comfyDir, settings.comfyCommand);
  if (!settings.comfyDir || !existsSync(settings.comfyDir) || command.length === 0) {
    wanted = false;
    lastError = "cannot restart ComfyUI — the directory or command is gone";
    note(`— ${lastError}`);
    return;
  }

  launch(command, settings.comfyDir);
}

async function drain(stream: ReadableStream<Uint8Array> | number | undefined): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) note(decoder.decode(chunk));
}

/**
 * Ask it to stop, then insist. ComfyUI shuts down on SIGTERM in a moment or
 * two; a model still loading can take longer than anyone wants to wait.
 */
export async function stopComfy(): Promise<void> {
  // Asked to stop, so an exit is no longer something to undo.
  wanted = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const running = child;
  if (!running) return;

  running.kill();

  const deadline = Date.now() + 8000;
  while (child === running && Date.now() < deadline) await Bun.sleep(100);

  if (child === running) {
    running.kill("SIGKILL");
    note("— did not stop in time, killed");
    child = null;
    startedAt = null;
  }
}

/**
 * Reap a child that died without `onExit` firing (it can be missed when the
 * process is replaced under a hot reload). Cheap enough to run on a timer.
 */
export function startComfyWatch(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (child && child.killed) {
      child = null;
      startedAt = null;
    }
  }, 2000);
}
