/**
 * Optional integration with a job server.
 *
 * With no upstreams configured the process runs standalone: the management UI
 * still works and runs workflows locally. Add one or more from the Servers page
 * (or seed them with `SERVER_n_*` in `.env`) and the agent additionally claims
 * queued jobs from them, asking the highest-priority server first.
 *
 * The protocol is four endpoints under `/api/internal/hosts/:hostId`, all
 * authenticated with `Authorization: Bearer <secret>`:
 *
 * - `POST /heartbeat`                 — report ComfyUI status, may return `{ pendingJobs }`
 * - `POST /jobs/claim`                — take the next job, or 204 when idle
 * - `POST /jobs/:jobId/result`        — upload the produced file as the raw body
 * - `POST /jobs/:jobId/complete`      — mark done
 * - `POST /jobs/:jobId/fail`          — mark failed with `{ reason }`
 */

import type { Settings, UpstreamConfig } from "./settings";
import type { ClaimedJob, ComfyStatusResult } from "./types";

export type UpstreamServer = {
  /** Log label; defaults to the URL host when `*_NAME` is unset. */
  name: string;
  /** Base URL with no trailing slash. */
  url: string;
  hostId: string;
  secret: string;
};

/**
 * The enabled upstreams, in the order the UI put them. That order is the
 * priority: `claimNext` walks it from the top every cycle.
 */
export function activeUpstreams(settings: Settings): UpstreamServer[] {
  return settings.upstreams
    .filter((server) => server.enabled && server.url && server.hostId && server.secret)
    .map(toServer);
}

function toServer(config: UpstreamConfig): UpstreamServer {
  return {
    name: config.name || config.url,
    url: config.url.replace(/\/$/, ""),
    hostId: config.hostId,
    secret: config.secret,
  };
}

function authHeaders(server: UpstreamServer): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${server.secret}`,
  };
}

export type HeartbeatAck = {
  /** Jobs waiting for this host. Older servers omit it. */
  pendingJobs?: number;
};

export async function sendHeartbeat(
  server: UpstreamServer,
  status: ComfyStatusResult,
): Promise<HeartbeatAck | null> {
  try {
    const res = await fetch(`${server.url}/api/internal/hosts/${server.hostId}/heartbeat`, {
      method: "POST",
      headers: authHeaders(server),
      body: JSON.stringify(status),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[heartbeat] ${server.name} rejected: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as HeartbeatAck;
  } catch (err) {
    console.error(`[heartbeat] ${server.name} error:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export type UpstreamTest = {
  ok: boolean;
  /** Round trip in milliseconds, however it ended. */
  ms: number;
  /** Jobs waiting for this host, when the server said. */
  pendingJobs?: number;
  /** Why it failed, as close to the server's own words as there are any. */
  error?: string;
};

/** Enough of a rejection to tell a wrong secret from a wrong address. */
const REASON_LIMIT = 120;

/**
 * One heartbeat, sent now, answering with why it failed rather than logging it.
 *
 * A separate call from {@link sendHeartbeat} on purpose: that one swallows
 * failures because the poll loop must carry on regardless, and someone who has
 * just typed a secret in wants the opposite — the status code, in the row.
 */
export async function testUpstream(
  server: UpstreamServer,
  status: ComfyStatusResult,
): Promise<UpstreamTest> {
  const started = Date.now();

  try {
    const res = await fetch(`${server.url}/api/internal/hosts/${server.hostId}/heartbeat`, {
      method: "POST",
      headers: authHeaders(server),
      body: JSON.stringify(status),
      signal: AbortSignal.timeout(10_000),
    });
    const ms = Date.now() - started;

    if (!res.ok) {
      const reason = (await res.text().catch(() => "")).trim().slice(0, REASON_LIMIT);
      return {
        ok: false,
        ms,
        error: reason ? `HTTP ${res.status} ${reason}` : `HTTP ${res.status}`,
      };
    }
    const ack = (await res.json()) as HeartbeatAck;
    return { ok: true, ms, pendingJobs: ack.pendingJobs };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function claimJob(server: UpstreamServer): Promise<ClaimedJob | null> {
  try {
    const res = await fetch(`${server.url}/api/internal/hosts/${server.hostId}/jobs/claim`, {
      method: "POST",
      headers: authHeaders(server),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 204) return null;
    if (!res.ok) {
      console.error(`[claim] ${server.name} rejected: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as ClaimedJob;
  } catch (err) {
    console.error(`[claim] ${server.name} error:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Stream the produced file from ComfyUI up to the job server. The host never
 * holds object-storage credentials; the upstream stores it and derives the key.
 */
export async function uploadResult(
  server: UpstreamServer,
  jobId: string,
  fileUrl: string,
): Promise<void> {
  const fileRes = await fetch(fileUrl, { signal: AbortSignal.timeout(60_000) });
  if (!fileRes.ok) throw new Error(`fetching the output failed: HTTP ${fileRes.status}`);
  const contentType = fileRes.headers.get("content-type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await fileRes.arrayBuffer());

  const res = await fetch(
    `${server.url}/api/internal/hosts/${server.hostId}/jobs/${jobId}/result`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${server.secret}`, "Content-Type": contentType },
      body: bytes,
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) {
    const message = await res.text().catch(() => String(res.status));
    throw new Error(`uploading the result failed: HTTP ${res.status} ${message}`);
  }
}

/**
 * Swallowing a failure here would strand the job: the upstream keeps it in the
 * assigned state, and claim only hands out pending ones, so it is never retried.
 * Throw and let the caller report it as a failure instead.
 */
export async function reportComplete(server: UpstreamServer, jobId: string): Promise<void> {
  const res = await fetch(
    `${server.url}/api/internal/hosts/${server.hostId}/jobs/${jobId}/complete`,
    { method: "POST", headers: authHeaders(server), signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`complete rejected: HTTP ${res.status}`);
}

/**
 * Last report in the failure path, so throwing here would take down the poll
 * loop with it. Log and move on.
 */
export async function reportFailure(
  server: UpstreamServer,
  jobId: string,
  reason: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${server.url}/api/internal/hosts/${server.hostId}/jobs/${jobId}/fail`,
      {
        method: "POST",
        headers: authHeaders(server),
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) console.error(`[fail] ${server.name} rejected: HTTP ${res.status}`);
  } catch (err) {
    console.error(`[fail] ${server.name} error:`, err instanceof Error ? err.message : err);
  }
}
