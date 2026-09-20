/**
 * Optional integration with a job server.
 *
 * With no upstreams configured the process runs standalone: the management UI
 * still works and manages ComfyUI locally. Add one or more from the Servers
 * page (or seed them with `SERVER_n_*` in `.env`) and the agent additionally
 * claims queued jobs from them, asking the highest-priority server first.
 *
 * The protocol is five endpoints under `/api/internal/hosts/:hostId`, all
 * authenticated with `Authorization: Bearer <secret>`:
 *
 * - `POST /heartbeat`                 — report ComfyUI status, may return `{ pendingJobs }`
 * - `POST /jobs/claim`                — take the next job, or 204 when idle
 * - `POST /jobs/:jobId/result`        — upload the produced file as the raw body
 * - `POST /jobs/:jobId/complete`      — mark done
 * - `POST /jobs/:jobId/fail`          — mark failed with `{ reason }`
 *
 * Linking adds one more, outside the per-host block and unauthenticated
 * because the code it takes is itself the credential:
 *
 * - `POST /api/internal/hosts/link`     — trade a one-time code for `{ hostId, hostSecret }`
 *
 * Everything a server answers with is checked before it is used. A job server
 * is trusted to hand out work, not to shape this process's memory, its file
 * names, or the page the user is looking at.
 */

import type { Settings, UpstreamConfig } from "./settings";
import type { ClaimedJob, ComfyStatusResult, RunParams, ServerWorkflow } from "./types";

export type UpstreamServer = {
  /** Log label; defaults to the URL host when `*_NAME` is unset. */
  name: string;
  /** Base URL with no trailing slash. */
  url: string;
  hostId: string;
  secret: string;
};

// ---------------------------------------------------------------------------
// What a server is allowed to be
// ---------------------------------------------------------------------------

/**
 * Hosts that plain `http://` may be used for: this machine, a private network,
 * or a name with no domain in it, which only a local resolver can answer. The
 * secret rides on every request as a bearer token, so anything that could
 * cross the open internet has to be `https://`.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  if (/\.(local|lan|internal|home\.arpa)$/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  // fc00::/7 and fe80::/10.
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

/**
 * Check and tidy a job server URL as typed, saved, linked or read from `.env`.
 * Returns the URL without its trailing slash, or throws with the reason in
 * words the UI can show.
 */
export function normaliseUpstreamUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) throw new Error("a server URL is required");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`not a URL: "${trimmed}"`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the server URL must start with https:// (or http:// on a private network)");
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new Error(
      `${url.host} is not on a private network — use https://, the secret travels on every request`,
    );
  }
  if (url.username || url.password) {
    throw new Error("the server URL must not carry a username or password");
  }
  if (url.search || url.hash) {
    throw new Error("the server URL must not have a query string or fragment");
  }
  return trimmed;
}

/**
 * The enabled upstreams, in the order the UI put them. That order is the
 * priority: `claimNext` walks it from the top every cycle.
 *
 * A stored URL is checked again here, not only when it was saved: a settings
 * file written before plain `http://` was restricted must not keep sending the
 * secret in the clear just because nobody has touched that row since.
 */
export function activeUpstreams(settings: Settings): UpstreamServer[] {
  return settings.upstreams
    .filter((server) => server.enabled && server.url && server.hostId && server.secret)
    .filter((server) => {
      try {
        normaliseUpstreamUrl(server.url);
        return true;
      } catch (err) {
        console.warn(
          `[config] ${server.name || server.url} skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    })
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

// ---------------------------------------------------------------------------
// Reading what a server sends back
// ---------------------------------------------------------------------------

/** Enough for any answer in this protocol except a claim, which carries an image. */
const SMALL_BODY_LIMIT = 64 * 1024;
/** A claim holds the input image as base64; this allows for a large one. */
const CLAIM_BODY_LIMIT = 48 * 1024 * 1024;

/**
 * Parse a JSON body no larger than `limit` bytes. `res.json()` on its own would
 * read whatever the server chose to send; a hostile or broken one could take
 * the process down with a single response.
 */
export async function readJson(res: Response, limit: number): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`response too large (${declared} bytes)`);
  }
  if (!res.body) throw new Error("empty response");

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`response too large (over ${limit} bytes)`);
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Ids end up in request paths, in file names handed to ComfyUI and in the job
 * history, so they are held to what an id looks like rather than escaped at
 * each of those places.
 */
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function encodePath(hostId: string, ...rest: string[]): string {
  return [hostId, ...rest].map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

export type LinkedHost = {
  hostId: string;
  hostSecret: string;
  /** What the server calls this host, so the UI can confirm what was linked. */
  hostName?: string;
};

/**
 * Trade a one-time code, issued by the job server's own UI, for this machine's
 * credentials.
 *
 * This is the alternative to carrying a host id and a secret across by hand.
 * The code is short-lived and spent on use, so it is safe to read off a screen
 * in a way the secret it buys is not — which is why the secret is fetched here
 * rather than shown to whoever is registering the machine.
 */
export async function claimLinkCode(url: string, code: string): Promise<LinkedHost> {
  const res = await fetch(`${url}/api/internal/hosts/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await readJson(res, SMALL_BODY_LIMIT).catch(() => null);
    const reason = isRecord(body) ? optionalString(body.error) : undefined;
    throw new Error(reason ?? `the server refused the code: HTTP ${res.status}`);
  }

  const linked = await readJson(res, SMALL_BODY_LIMIT);
  if (!isRecord(linked) || !linked.hostId || !linked.hostSecret) {
    throw new Error("the server accepted the code but sent no credentials");
  }
  const hostId = optionalString(linked.hostId);
  const hostSecret = optionalString(linked.hostSecret);
  if (!hostId || !SAFE_ID.test(hostId)) throw new Error("the server sent an unusable host id");
  if (!hostSecret) throw new Error("the server sent an unusable secret");

  return { hostId, hostSecret, hostName: optionalString(linked.hostName) };
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

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

/** Only the field this side knows, and only when it is a number. */
function toAck(body: unknown): HeartbeatAck {
  const pending = isRecord(body) ? optionalNumber(body.pendingJobs) : undefined;
  return pending === undefined ? {} : { pendingJobs: pending };
}

export async function sendHeartbeat(
  server: UpstreamServer,
  status: ComfyStatusResult & { readyModels?: string[] },
): Promise<HeartbeatAck | null> {
  try {
    const res = await fetch(
      `${server.url}/api/internal/hosts/${encodePath(server.hostId)}/heartbeat`,
      {
        method: "POST",
        headers: authHeaders(server),
        body: JSON.stringify(status),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.error(`[heartbeat] ${server.name} rejected: HTTP ${res.status}`);
      return null;
    }
    return toAck(await readJson(res, SMALL_BODY_LIMIT));
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
    const res = await fetch(
      `${server.url}/api/internal/hosts/${encodePath(server.hostId)}/heartbeat`,
      {
        method: "POST",
        headers: authHeaders(server),
        body: JSON.stringify(status),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const ms = Date.now() - started;

    if (!res.ok) {
      const reason = (await res.text().catch(() => "")).trim().slice(0, REASON_LIMIT);
      return {
        ok: false,
        ms,
        error: reason ? `HTTP ${res.status} ${reason}` : `HTTP ${res.status}`,
      };
    }
    const ack = toAck(await readJson(res, SMALL_BODY_LIMIT));
    return { ok: true, ms, ...ack };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Only the overrides this side understands, each with the type it expects. */
function toParams(value: unknown): RunParams | undefined {
  if (!isRecord(value)) return undefined;
  return {
    positivePrompt: optionalString(value.positivePrompt),
    negativePrompt: optionalString(value.negativePrompt),
    seed: optionalNumber(value.seed),
    seconds: optionalNumber(value.seconds),
    fps: optionalNumber(value.fps),
  };
}

function toServerWorkflow(value: Record<string, unknown>): ServerWorkflow {
  const presetId = optionalString(value.presetId);
  const workflowJson = optionalString(value.workflowJson);
  if (!presetId || !SAFE_ID.test(presetId)) throw new Error("workflow.presetId is not an id");
  if (!workflowJson) throw new Error("workflow.workflowJson is not a string");
  const triggerWords = value.triggerWords;
  if (triggerWords !== null && triggerWords !== undefined && typeof triggerWords !== "string") {
    throw new Error("workflow.triggerWords is not a string");
  }
  return { presetId, workflowJson, triggerWords: triggerWords ?? null };
}

/**
 * Narrow a claim to the shape this side runs. Throws on anything that is not a
 * job, so a server that sends nonsense is logged rather than obeyed.
 */
export function toClaimedJob(body: unknown): ClaimedJob {
  if (!isRecord(body)) throw new Error("claim is not an object");

  const jobId = optionalString(body.jobId);
  if (!jobId || !SAFE_ID.test(jobId)) throw new Error("claim has no usable jobId");

  const image = body.sourceImageBase64 ?? "";
  if (typeof image !== "string") throw new Error("sourceImageBase64 is not a string");
  const contentType = body.sourceImageContentType ?? "image/png";
  if (typeof contentType !== "string") throw new Error("sourceImageContentType is not a string");

  let workflow: ClaimedJob["workflow"];
  if (body.workflow === undefined || body.workflow === null) workflow = null;
  else if (typeof body.workflow === "string") workflow = body.workflow;
  else if (isRecord(body.workflow)) workflow = toServerWorkflow(body.workflow);
  else throw new Error("workflow is neither a name nor a workflow");

  return {
    jobId,
    userId: optionalString(body.userId) ?? "",
    sourceImageBase64: image,
    sourceImageContentType: contentType,
    params: toParams(body.params),
    workflow,
  };
}

export async function claimJob(server: UpstreamServer): Promise<ClaimedJob | null> {
  try {
    const res = await fetch(
      `${server.url}/api/internal/hosts/${encodePath(server.hostId, "jobs", "claim")}`,
      {
        method: "POST",
        headers: authHeaders(server),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (res.status === 204) return null;
    if (!res.ok) {
      console.error(`[claim] ${server.name} rejected: HTTP ${res.status}`);
      return null;
    }
    return toClaimedJob(await readJson(res, CLAIM_BODY_LIMIT));
  } catch (err) {
    console.error(`[claim] ${server.name} error:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Stream the produced file from ComfyUI up to the job server, without holding
 * it in memory on the way: a video runs to gigabytes. The host never holds
 * object-storage credentials; the upstream stores it and derives the key.
 */
export async function uploadResult(
  server: UpstreamServer,
  jobId: string,
  fileUrl: string,
): Promise<void> {
  const fileRes = await fetch(fileUrl, { signal: AbortSignal.timeout(60_000) });
  if (!fileRes.ok || !fileRes.body) {
    throw new Error(`fetching the output failed: HTTP ${fileRes.status}`);
  }
  const contentType = fileRes.headers.get("content-type") ?? "application/octet-stream";
  const contentLength = fileRes.headers.get("content-length");

  const res = await fetch(
    `${server.url}/api/internal/hosts/${encodePath(server.hostId, "jobs", jobId, "result")}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${server.secret}`,
        "Content-Type": contentType,
        ...(contentLength ? { "Content-Length": contentLength } : {}),
      },
      body: fileRes.body,
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) {
    const message = (await res.text().catch(() => "")).slice(0, REASON_LIMIT) || String(res.status);
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
    `${server.url}/api/internal/hosts/${encodePath(server.hostId, "jobs", jobId, "complete")}`,
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
      `${server.url}/api/internal/hosts/${encodePath(server.hostId, "jobs", jobId, "fail")}`,
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
