import { MAX_PAUSE_MINUTES, acceptState, isTimeOfDay, pauseUntil } from "../accepting";
import { agentSnapshot, applyUpstreamChange } from "../agent";
import { interrupt, uploadImage, viewUrl } from "../comfy";
import { comfyProcessState, startComfy, stopComfy } from "../comfy-process";
import { COMFY_URL, UI_HOSTNAME, UI_PORT, UI_TOKEN, WORKFLOW_DIR } from "../config";
import { listEvents } from "../events";
import {
  clearFinishedJobs,
  completeJob,
  failJob,
  listJobs,
  markQueued,
  removeJob,
  startJob,
} from "../jobs";
import { latestProgress } from "../progress";
import {
  RUN_MODES,
  hostFromUrl,
  loadSettings,
  newUpstreamId,
  publicUpstreams,
  saveSettings,
} from "../settings";
import { latestStatus, refreshStatus } from "../status";
import {
  activeWorkflowName,
  clearWorkflowCache,
  deleteWorkflowFile,
  listWorkflows,
  loadWorkflow,
  runWorkflow,
  saveWorkflowFile,
  setActiveWorkflow,
} from "../workflow";
import { claimLinkCode, testUpstream } from "../upstream";
import { authorise } from "./guard";
import index from "./index.html";
import type { AcceptSchedule, RunMode, UpstreamConfig } from "../settings";
import type { RunParams } from "../types";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(err: unknown, status = 400): Response {
  return Response.json({ error: message(err) }, { status });
}

async function handleState(): Promise<Response> {
  const settings = await loadSettings();

  return Response.json({
    comfy: { url: COMFY_URL, ...latestStatus() },
    comfyProcess: await comfyProcessState(),
    workflows: await listWorkflows(),
    workflowDir: WORKFLOW_DIR,
    activeWorkflow: await activeWorkflowName(),
    agent: agentSnapshot(),
    upstreams: publicUpstreams(settings),
    settings: { comfyDir: settings.comfyDir, comfyCommand: settings.comfyCommand },
    mode: settings.mode,
    accepting: acceptState(settings),
    progress: latestProgress(),
    desktop: settings.desktop,
    jobs: listJobs(),
    events: listEvents(),
  });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

async function handleSetActive(req: Request): Promise<Response> {
  try {
    const { name } = (await req.json()) as { name?: string };
    if (!name) return fail("name is required");
    await setActiveWorkflow(name);
    return Response.json({ activeWorkflow: name });
  } catch (err) {
    return fail(err);
  }
}

function handleReload(): Response {
  clearWorkflowCache();
  return Response.json({ ok: true });
}

/**
 * Accepts the file the browser picked. The name comes from the upload rather
 * than a path, and `saveWorkflowFile` rejects anything that would escape the
 * workflow directory or fail to parse as an API-format workflow.
 */
async function handleWorkflowUpload(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const file = form.get("workflow");
    if (!(file instanceof File) || file.size === 0) return fail("choose a .json file");

    const given = form.get("name");
    const name = typeof given === "string" && given.trim() ? given : file.name;

    const summary = await saveWorkflowFile(name, await file.text());
    return Response.json({ workflow: summary });
  } catch (err) {
    return fail(err);
  }
}

async function handleWorkflowDelete(req: Request): Promise<Response> {
  try {
    const { name } = (await req.json()) as { name?: string };
    if (!name) return fail("name is required");
    await deleteWorkflowFile(name);
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// Upstream servers
// ---------------------------------------------------------------------------

type UpstreamInput = Partial<UpstreamConfig> & { id?: string };

/**
 * The whole list is sent on every save, so reordering is just a different
 * order. A blank secret on an existing row keeps the stored one — the UI never
 * receives secrets, so it cannot send them back.
 */
async function handleUpstreamsSave(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { upstreams?: UpstreamInput[] };
    if (!Array.isArray(body.upstreams)) return fail("upstreams must be an array");

    const settings = await loadSettings();
    const existing = new Map(settings.upstreams.map((server) => [server.id, server]));

    const upstreams = body.upstreams.map((input, position): UpstreamConfig => {
      const previous = input.id ? existing.get(input.id) : undefined;
      const url = (input.url ?? previous?.url ?? "").trim().replace(/\/$/, "");
      if (!url) throw new Error(`server ${position + 1} needs a URL`);

      const hostId = (input.hostId ?? previous?.hostId ?? "").trim();
      if (!hostId) throw new Error(`${url} needs a host id`);

      const secret = (input.secret ?? "").trim() || previous?.secret || "";
      if (!secret) throw new Error(`${url} needs a secret`);

      return {
        id: input.id && existing.has(input.id) ? input.id : newUpstreamId(),
        name: (input.name ?? previous?.name ?? "").trim() || url,
        url,
        hostId,
        secret,
        enabled: input.enabled ?? previous?.enabled ?? true,
      };
    });

    const saved = await saveSettings({ upstreams });
    await applyUpstreamChange();
    return Response.json({ upstreams: publicUpstreams(saved) });
  } catch (err) {
    return fail(err);
  }
}

/**
 * One heartbeat to a single server, sent now, so a wrong secret says so instead
 * of looking like an unreachable host until the next scheduled beat.
 *
 * The row is taken as it stands on screen: a secret typed but not yet saved is
 * what gets tested, and a blank one falls back to the stored value — the same
 * rule the save path uses, so testing and saving cannot disagree about which
 * secret they mean.
 */
async function handleUpstreamTest(req: Request): Promise<Response> {
  try {
    const input = (await req.json()) as UpstreamInput;
    const settings = await loadSettings();
    const stored = input.id
      ? settings.upstreams.find((server) => server.id === input.id)
      : undefined;

    const url = (input.url ?? stored?.url ?? "").trim().replace(/\/$/, "");
    if (!url) return fail("a URL is needed");
    const hostId = (input.hostId ?? stored?.hostId ?? "").trim();
    if (!hostId) return fail("a host id is needed");
    const secret = (input.secret ?? "").trim() || stored?.secret || "";
    if (!secret) return fail("a secret is needed");

    const { comfyStatus, queueRunning, queuePending, gpu } = latestStatus();
    const result = await testUpstream(
      { name: url, url, hostId, secret },
      { comfyStatus, queueRunning, queuePending, gpu },
    );
    return Response.json(result);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Link this machine to a job server with a one-time code issued by that
 * server's own UI.
 *
 * The exchange happens here and not in the page for two reasons: the browser
 * has no CORS grant from a job server it has never spoken to, and the secret
 * that comes back has no business passing through the UI at all.
 */
async function handleLink(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { url?: string; code?: string };
    const url = (body.url ?? "").trim().replace(/\/$/, "");
    const code = (body.code ?? "").trim();

    if (!url) return fail("a server URL is required");
    if (!/^https?:\/\//i.test(url))
      return fail("the server URL must start with http:// or https://");
    if (!code) return fail("a link code is required");

    const linked = await claimLinkCode(url, code);

    // One row per server URL. Linking the same server again replaces the
    // credentials rather than leaving a second row claiming beside the first.
    const settings = await loadSettings();
    const known = settings.upstreams.some((server) => server.url === url);
    const upstreams = known
      ? settings.upstreams.map((server) =>
          server.url === url
            ? { ...server, hostId: linked.hostId, secret: linked.hostSecret }
            : server,
        )
      : [
          ...settings.upstreams,
          {
            id: newUpstreamId(),
            name: hostFromUrl(url),
            url,
            hostId: linked.hostId,
            secret: linked.hostSecret,
            enabled: true,
          },
        ];

    const saved = await saveSettings({ upstreams });
    await applyUpstreamChange();

    return Response.json({
      upstreams: publicUpstreams(saved),
      hostName: linked.hostName ?? null,
      replaced: known,
    });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// ComfyUI itself
// ---------------------------------------------------------------------------

async function handleSettingsSave(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { comfyDir?: string; comfyCommand?: string };
    const saved = await saveSettings({
      ...(body.comfyDir === undefined ? {} : { comfyDir: body.comfyDir.trim() }),
      ...(body.comfyCommand === undefined ? {} : { comfyCommand: body.comfyCommand.trim() }),
    });
    return Response.json({
      settings: { comfyDir: saved.comfyDir, comfyCommand: saved.comfyCommand },
    });
  } catch (err) {
    return fail(err);
  }
}

/**
 * The run mode, reachable from the page and from the tray menu. Two of the
 * three only decide what is allowed to start; `paused` also shuts ComfyUI down,
 * because the reason for choosing it is wanting the machine back, and a ComfyUI
 * left sitting there still holds the GPU. Both callers ask before sending it.
 *
 * All three describe what ComfyUI will do, so none of them can be set without
 * one: the page and the tray grey the choice out, and this refuses it.
 */
async function handleMode(req: Request): Promise<Response> {
  try {
    const { mode } = (await req.json()) as { mode?: unknown };
    if (!RUN_MODES.includes(mode as RunMode)) {
      return fail(`mode must be one of ${RUN_MODES.join(", ")}`);
    }
    if (latestStatus().comfyStatus === "unavailable") {
      return fail("ComfyUI is not running", 409);
    }

    const saved = await saveSettings({ mode: mode as RunMode });
    // Saved first: a ComfyUI that refuses to die must not leave the machine
    // marked as still accepting work.
    if (saved.mode === "paused") {
      await stopComfy();
      // The status is polled on a timer, and this just made it wrong. Asking
      // now is what greys the choice out in the same breath as stopping it.
      await refreshStatus();
    }
    return Response.json({ mode: saved.mode });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Hold off claiming for a while, then let it resume on its own. `0` minutes
 * (or `null`) clears a pause that is still running.
 *
 * Deliberately not folded into `/api/mode`: the mode is what someone decided
 * this machine is for, and a pause is a detour from it that ends by itself.
 */
async function handlePause(req: Request): Promise<Response> {
  try {
    const { minutes } = (await req.json()) as { minutes?: unknown };
    const value = minutes === null || minutes === undefined ? 0 : minutes;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail("minutes must be a number");
    }
    if (value < 0 || value > MAX_PAUSE_MINUTES) {
      return fail(`minutes must be between 0 and ${MAX_PAUSE_MINUTES}`);
    }

    const saved = await saveSettings({ pauseUntil: pauseUntil(value) });
    return Response.json({ accepting: acceptState(saved) });
  } catch (err) {
    return fail(err);
  }
}

/**
 * The daily window. Saved field by field like the desktop switches, so turning
 * the window on does not need the times sent again, and fixing a time does not
 * need the switch sent again.
 */
async function handleScheduleSave(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<AcceptSchedule>;
    const current = (await loadSettings()).schedule;

    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return fail("enabled must be true or false");
    }
    const from = body.from ?? current.from;
    const to = body.to ?? current.to;
    if (!isTimeOfDay(from) || !isTimeOfDay(to)) return fail("from and to must be HH:MM");

    const saved = await saveSettings({
      schedule: { enabled: body.enabled ?? current.enabled, from, to },
    });
    return Response.json({ accepting: acceptState(saved) });
  } catch (err) {
    return fail(err);
  }
}

/** How the desktop shell behaves. The shell reads these back and applies them. */
async function handleDesktopSave(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { autostart?: unknown; closeAction?: unknown };
    const current = (await loadSettings()).desktop;

    const closeAction =
      body.closeAction === undefined
        ? current.closeAction
        : body.closeAction === "tray" || body.closeAction === "quit"
          ? body.closeAction
          : null;
    if (closeAction === null) return fail('closeAction must be "tray" or "quit"');

    if (body.autostart !== undefined && typeof body.autostart !== "boolean") {
      return fail("autostart must be true or false");
    }

    const saved = await saveSettings({
      desktop: {
        autostart: body.autostart === undefined ? current.autostart : body.autostart,
        closeAction,
      },
    });
    return Response.json({ desktop: saved.desktop });
  } catch (err) {
    return fail(err);
  }
}

async function handleComfyStart(): Promise<Response> {
  try {
    await startComfy();
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

async function handleComfyStop(): Promise<Response> {
  try {
    await stopComfy();
    // Rather than let the timer find out: what is now down decides what the
    // agent claims and whether the run mode can be changed at all.
    await refreshStatus();
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err, 500);
  }
}

async function handleInterrupt(): Promise<Response> {
  try {
    await interrupt(COMFY_URL);
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err, 502);
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function handleJobDelete(req: Request): Promise<Response> {
  try {
    const { id } = (await req.json()) as { id?: string };
    if (!id) return fail("id is required");
    if (!removeJob(id)) return fail("no such job", 404);
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

function handleJobsClear(): Response {
  return Response.json({ removed: clearFinishedJobs() });
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Start a run and return immediately with the job id. Generation takes minutes,
 * far longer than a request should stay open, so progress is read back through
 * `/api/state`.
 */
async function handleRun(req: Request): Promise<Response> {
  try {
    if ((await loadSettings()).mode === "paused") return fail("new work is paused", 409);

    const form = await req.formData();

    const text = (key: string): string | undefined => {
      const value = form.get(key);
      return typeof value === "string" && value.trim() !== "" ? value : undefined;
    };
    const number = (key: string): number | undefined => {
      const raw = text(key);
      if (raw === undefined) return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    const name = text("workflow") ?? (await activeWorkflowName());
    if (!name) return fail("no workflow selected");

    // Parse before starting anything, so a broken file answers the request with
    // the reason instead of logging a job that was doomed from the start.
    await loadWorkflow(name);

    const params: RunParams = {
      positivePrompt: text("positive"),
      negativePrompt: text("negative"),
      seed: number("seed"),
      seconds: number("seconds"),
      fps: number("fps"),
    };

    const image = form.get("image");
    if (image instanceof File && image.size > 0) {
      params.imageFilename = await uploadImage(
        COMFY_URL,
        image.name || "input.png",
        image.type || "image/png",
        new Uint8Array(await image.arrayBuffer()),
      );
    }

    const job = startJob({ id: crypto.randomUUID(), source: "ui", workflow: name });
    void runWorkflow(name, params, (promptId) => markQueued(job, promptId))
      .then((outputs) => completeJob(job, outputs))
      .catch((err) => failJob(job, message(err)));

    return Response.json({ jobId: job.id });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Serve ComfyUI outputs through this process so the UI works when ComfyUI is
 * only reachable from the host. The target is rebuilt from `COMFY_URL` and the
 * three `/view` parameters rather than taken as a URL, which keeps it from
 * being usable as an open proxy.
 */
async function handleOutput(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const filename = params.get("filename");
  if (!filename) return fail("filename is required");

  const target = viewUrl(COMFY_URL, {
    filename,
    subfolder: params.get("subfolder") ?? "",
    type: params.get("type") ?? "output",
  });

  try {
    const upstream = await fetch(target, { signal: AbortSignal.timeout(60_000) });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return fail(err, 502);
  }
}

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Wrap a handler in the checks from `guard.ts`. Applied to every API route
 * rather than the dangerous-looking ones, because "dangerous" is not obvious:
 * reading the state exposes the upstream list, and uploading writes a file.
 */
function guarded(handler: Handler): Handler {
  return (req) => authorise(req) ?? handler(req);
}

export function startUi() {
  if (UI_HOSTNAME !== "127.0.0.1" && UI_HOSTNAME !== "localhost" && !UI_TOKEN) {
    console.warn(
      `[ui] listening on ${UI_HOSTNAME} with no UI_TOKEN — anyone who can reach` +
        " this port can start ComfyUI on this machine. Set UI_TOKEN in .env.",
    );
  }

  return Bun.serve({
    port: UI_PORT,
    hostname: UI_HOSTNAME,
    routes: {
      "/": index,
      "/api/state": { GET: guarded(handleState) },

      "/api/workflows/active": { POST: guarded(handleSetActive) },
      "/api/workflows/reload": { POST: guarded(handleReload) },
      "/api/workflows/upload": { POST: guarded(handleWorkflowUpload) },
      "/api/workflows/delete": { POST: guarded(handleWorkflowDelete) },

      "/api/upstreams": { POST: guarded(handleUpstreamsSave) },
      "/api/upstreams/test": { POST: guarded(handleUpstreamTest) },
      "/api/link": { POST: guarded(handleLink) },

      "/api/settings": { POST: guarded(handleSettingsSave) },
      "/api/mode": { POST: guarded(handleMode) },
      "/api/accept/pause": { POST: guarded(handlePause) },
      "/api/accept/schedule": { POST: guarded(handleScheduleSave) },
      "/api/desktop": { POST: guarded(handleDesktopSave) },
      "/api/comfy/start": { POST: guarded(handleComfyStart) },
      "/api/comfy/stop": { POST: guarded(handleComfyStop) },

      "/api/jobs/delete": { POST: guarded(handleJobDelete) },
      "/api/jobs/clear": { POST: guarded(handleJobsClear) },

      "/api/run": { POST: guarded(handleRun) },
      "/api/interrupt": { POST: guarded(handleInterrupt) },
      "/api/output": { GET: guarded(handleOutput) },
    },
    fetch() {
      return new Response("Not found", { status: 404 });
    },
  });
}
