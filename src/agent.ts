import { Buffer } from "node:buffer";
import { uploadImage } from "./comfy";
import {
  AUTO_UPDATE,
  COMFY_URL,
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
  UPDATE_CHECK_INTERVAL_MS,
} from "./config";
import { completeJob, failJob, markQueued, startJob } from "./jobs";
import { refreshStatus } from "./status";
import { RESTART_EXIT_CODE, remoteHasUpdate } from "./updater";
import { loadSettings } from "./settings";
import {
  activeUpstreams,
  claimJob,
  reportComplete,
  reportFailure,
  sendHeartbeat,
  uploadResult,
} from "./upstream";
import { activeWorkflowName, runWorkflow } from "./workflow";
import type { UpstreamServer } from "./upstream";
import type { ClaimedJob } from "./types";

type HeartbeatState = {
  ok: boolean;
  at: number;
  pendingJobs?: number;
};

let upstreams: UpstreamServer[] = [];
const heartbeats = new Map<string, HeartbeatState>();
let running = false;
/** True while `pollLoop` is between its start and its `finally`. */
let loopActive = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Upstream view for the UI. Secrets are deliberately not included. */
export function agentSnapshot() {
  return {
    running,
    autoUpdate: AUTO_UPDATE,
    upstreams: upstreams.map((server) => ({
      name: server.name,
      url: server.url,
      hostId: server.hostId,
      heartbeat: heartbeats.get(server.name) ?? null,
    })),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sendHeartbeats() {
  const status = await refreshStatus();

  await Promise.all(
    upstreams.map(async (server) => {
      const ack = await sendHeartbeat(server, status);
      if (!ack) {
        heartbeats.set(server.name, { ok: false, at: Date.now() });
        return;
      }
      heartbeats.set(server.name, { ok: true, at: Date.now(), pendingJobs: ack.pendingJobs });
      const backlog =
        ack.pendingJobs === undefined ? "" : ` | upstream queue: ${ack.pendingJobs} waiting`;
      console.log(
        `[heartbeat] ${server.name} OK — comfy: ${status.comfyStatus}` +
          ` | running: ${status.queueRunning} | pending: ${status.queuePending}${backlog}`,
      );
    }),
  );
}

/**
 * Ask upstreams in the order they were configured. The list *is* the priority,
 * so the first server is asked on every cycle and only a server with nothing
 * queued lets the next one through. A busy first server therefore starves the
 * rest — which is what asking for priority means.
 */
async function claimNext(): Promise<{ server: UpstreamServer; job: ClaimedJob } | null> {
  for (const server of upstreams) {
    const job = await claimJob(server);
    if (job) return { server, job };
  }
  return null;
}

async function processJob(server: UpstreamServer, claimed: ClaimedJob) {
  const workflowName = claimed.workflow ?? (await activeWorkflowName());
  if (!workflowName) {
    const reason = "no workflow installed — drop an API-format workflow into workflows/";
    console.error(`[worker] job ${claimed.jobId} rejected: ${reason}`);
    await reportFailure(server, claimed.jobId, reason);
    return;
  }

  console.log(`[worker] job ${claimed.jobId} started (${server.name}, workflow "${workflowName}")`);
  const job = startJob({
    id: claimed.jobId,
    source: "upstream",
    origin: server.name,
    workflow: workflowName,
  });

  try {
    let imageFilename: string | undefined;
    if (claimed.sourceImageBase64) {
      const contentType = claimed.sourceImageContentType || "image/png";
      const ext = contentType.split("/")[1] ?? "png";
      imageFilename = await uploadImage(
        COMFY_URL,
        `input_${claimed.jobId}.${ext}`,
        contentType,
        Buffer.from(claimed.sourceImageBase64, "base64"),
      );
      console.log(`[worker] uploaded input image → ${imageFilename}`);
    }

    const outputs = await runWorkflow(
      workflowName,
      { ...claimed.params, imageFilename },
      (promptId) => markQueued(job, promptId),
    );

    // Upstreams expect a single artefact. Video workflows also emit preview
    // images, so prefer a playable file over whatever happens to come first.
    const primary = outputs.find((output) => output.kind === "video") ?? outputs[0]!;
    await uploadResult(server, claimed.jobId, primary.url);
    await reportComplete(server, claimed.jobId);

    completeJob(job, outputs);
    console.log(`[worker] job ${claimed.jobId} completed`);
  } catch (err) {
    const reason = message(err);
    console.error(`[worker] job ${claimed.jobId} failed: ${reason}`);
    failJob(job, reason);
    await reportFailure(server, claimed.jobId, reason);
  }
}

/**
 * Exit so the launcher can pull the new commit and relaunch. Only ever called
 * between jobs, so nothing in flight is cut off.
 */
function requestRestart(): never {
  running = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  console.log("[update] new commit detected — restarting to apply");
  process.exit(RESTART_EXIT_CODE);
}

async function pollLoop() {
  loopActive = true;
  try {
    await runPoll();
  } finally {
    loopActive = false;
  }
}

async function runPoll() {
  let lastUpdateCheck = Date.now();

  while (running) {
    // The update check sits between jobs, never during one, so the exit in
    // requestRestart() cannot interrupt work in flight.
    if (AUTO_UPDATE && Date.now() - lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS) {
      lastUpdateCheck = Date.now();
      try {
        if (await remoteHasUpdate()) requestRestart();
      } catch (err) {
        console.error("[update] check failed:", message(err));
      }
    }

    // Only the first mode claims. Heartbeats carry on either way, so the
    // upstream still sees this host as alive — its queue simply is not drained
    // from here.
    if ((await loadSettings()).mode !== "accepting") {
      await idle(POLL_INTERVAL_MS);
      continue;
    }

    const claimed = await claimNext();
    if (claimed) {
      await processJob(claimed.server, claimed.job);
      // Go straight round again to drain the queue.
      continue;
    }
    await idle(POLL_INTERVAL_MS);
  }
}

/** Sleep in slices so stopping the agent is felt at once, not a poll later. */
async function idle(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (running && Date.now() < until) {
    await Bun.sleep(Math.min(200, until - Date.now()));
  }
}

export function startAgent(servers: UpstreamServer[]): void {
  upstreams = servers;
  heartbeats.clear();
  if (upstreams.length === 0) return;

  running = true;
  void sendHeartbeats();
  heartbeatTimer = setInterval(() => void sendHeartbeats(), HEARTBEAT_INTERVAL_MS);
  void pollLoop();
}

export function stopAgent(): void {
  running = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * Swap the upstream list while the process keeps running. Waits for the poll
 * loop to actually exit — starting a second one alongside the first would let
 * both claim the same job.
 */
export async function reloadAgent(servers: UpstreamServer[]): Promise<void> {
  stopAgent();
  while (loopActive) await Bun.sleep(50);
  startAgent(servers);
}

/** Called after the Servers page saves, so a change takes effect at once. */
export async function applyUpstreamChange(): Promise<void> {
  await reloadAgent(activeUpstreams(await loadSettings()));
}
