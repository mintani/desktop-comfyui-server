import { CLIENT_ID } from "./progress";
import type { ApiWorkflow } from "./slots";
import type { ComfyStatusResult, OutputKind, RunOutput } from "./types";

type ComfyQueueResponse = {
  queue_running?: unknown[];
  queue_pending?: unknown[];
};

/** Reachability plus queue depth, used for heartbeats and the UI header. */
export async function checkComfy(baseUrl: string): Promise<ComfyStatusResult> {
  try {
    const signal = AbortSignal.timeout(5000);
    const [statsRes, queueRes] = await Promise.all([
      fetch(`${baseUrl}/system_stats`, { signal }),
      fetch(`${baseUrl}/queue`, { signal }),
    ]);

    if (!statsRes.ok || !queueRes.ok) {
      return { comfyStatus: "unavailable", queueRunning: 0, queuePending: 0 };
    }

    const queue = (await queueRes.json()) as ComfyQueueResponse;
    const queueRunning = queue.queue_running?.length ?? 0;
    const queuePending = queue.queue_pending?.length ?? 0;

    return {
      comfyStatus: queueRunning > 0 ? "busy" : "available",
      queueRunning,
      queuePending,
    };
  } catch {
    return { comfyStatus: "unavailable", queueRunning: 0, queuePending: 0 };
  }
}

type UploadImageResponse = { name?: string; subfolder?: string; type?: string };

/**
 * Push an image into ComfyUI's input folder and return the name to reference it
 * by. ComfyUI may rename on collision, so the returned name is authoritative
 * and must be what gets written into the workflow.
 */
export async function uploadImage(
  baseUrl: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([bytes as BlobPart], { type: contentType }), filename);
  form.append("overwrite", "true");

  const res = await fetch(`${baseUrl}/upload/image`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`ComfyUI /upload/image failed: HTTP ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as UploadImageResponse;
  if (!json.name)
    throw new Error(`ComfyUI /upload/image returned no name: ${JSON.stringify(json)}`);
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

type PromptResponse = {
  prompt_id?: string;
  error?: unknown;
  node_errors?: unknown;
};

export async function queuePrompt(baseUrl: string, workflow: ApiWorkflow): Promise<string> {
  const res = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The client id is what makes ComfyUI address its progress messages at the
    // socket in `progress.ts` rather than at nobody.
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`ComfyUI /prompt failed: HTTP ${res.status} ${await res.text()}`);

  const json = (await res.json()) as PromptResponse;
  if (!json.prompt_id) {
    // Validation errors come back with HTTP 200, so this is the normal path for
    // a workflow whose models or nodes are missing on this machine.
    throw new Error(
      `ComfyUI rejected the workflow: ${JSON.stringify({
        error: json.error,
        node_errors: json.node_errors,
      })}`,
    );
  }
  return json.prompt_id;
}

type OutputFile = { filename: string; subfolder: string; type: string };

type NodeOutput = Record<string, unknown> & {
  images?: OutputFile[];
  videos?: OutputFile[];
  gifs?: OutputFile[];
  audio?: OutputFile[];
};

type HistoryEntry = {
  outputs: Record<string, NodeOutput>;
  status: { completed: boolean; status_str?: string; messages?: unknown[] };
};

/** Poll `/history` until the run reports completion or the deadline passes. */
export async function waitForPrompt(
  baseUrl: string,
  promptId: string,
  timeoutMs: number,
): Promise<HistoryEntry> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(2000);
    try {
      const res = await fetch(`${baseUrl}/history/${promptId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const history = (await res.json()) as Record<string, HistoryEntry>;
      const entry = history[promptId];
      if (entry?.status?.completed) return entry;
    } catch {
      // A transient failure mid-run is expected (ComfyUI restarts, brief
      // network hiccups); keep polling until the deadline instead of failing.
    }
  }
  throw new Error(`run timed out after ${Math.round(timeoutMs / 1000)}s`);
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

function classify(filename: string, bucket: string): OutputKind {
  if (VIDEO_EXT.test(filename)) return "video";
  if (AUDIO_EXT.test(filename)) return "audio";
  if (IMAGE_EXT.test(filename)) return "image";
  if (bucket === "videos" || bucket === "gifs") return "video";
  if (bucket === "images") return "image";
  if (bucket === "audio") return "audio";
  return "file";
}

function isOutputFile(value: unknown): value is OutputFile {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as OutputFile).filename === "string"
  );
}

export function viewUrl(baseUrl: string, file: OutputFile): string {
  const query = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? "",
    type: file.type ?? "output",
  });
  return `${baseUrl}/view?${query}`;
}

/**
 * Flatten every file ComfyUI recorded for the run.
 *
 * Output nodes are not detected ahead of time: whatever shows up in the history
 * is collected, so save nodes of any kind work without configuration.
 */
export function collectOutputs(baseUrl: string, entry: HistoryEntry): RunOutput[] {
  const outputs: RunOutput[] = [];
  for (const [nodeId, nodeOutput] of Object.entries(entry.outputs ?? {})) {
    for (const [bucket, value] of Object.entries(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const file of value) {
        if (!isOutputFile(file)) continue;
        outputs.push({
          nodeId,
          filename: file.filename,
          subfolder: file.subfolder ?? "",
          type: file.type ?? "output",
          kind: classify(file.filename, bucket),
          url: viewUrl(baseUrl, file),
        });
      }
    }
  }
  return outputs;
}

export function runFailure(entry: HistoryEntry): string | null {
  const status = entry.status?.status_str;
  if (status && status !== "success") {
    return `ComfyUI reported "${status}": ${JSON.stringify(entry.status.messages ?? [])}`;
  }
  return null;
}

/** Ask ComfyUI to abort whatever it is running now. */
export async function interrupt(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/interrupt`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ComfyUI /interrupt failed: HTTP ${res.status}`);
}
