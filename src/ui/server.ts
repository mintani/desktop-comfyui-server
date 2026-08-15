import { agentSnapshot, applyUpstreamChange } from "../agent";
import { interrupt, uploadImage, viewUrl } from "../comfy";
import { comfyProcessState, startComfy, stopComfy } from "../comfy-process";
import { COMFY_URL, UI_HOSTNAME, UI_PORT, UI_TOKEN, WORKFLOW_DIR } from "../config";
import {
  clearFinishedJobs,
  completeJob,
  failJob,
  listJobs,
  markQueued,
  removeJob,
  startJob,
} from "../jobs";
import { loadSettings, newUpstreamId, publicUpstreams, saveSettings } from "../settings";
import { latestStatus } from "../status";
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
import { authorise } from "./guard";
import index from "./index.html";
import type { UpstreamConfig } from "../settings";
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
    jobs: listJobs(),
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

      "/api/settings": { POST: guarded(handleSettingsSave) },
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
