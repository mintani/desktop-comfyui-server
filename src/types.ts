export type ComfyStatus = "available" | "busy" | "unavailable";

/**
 * The GPU as ComfyUI reports it, in bytes. Read through ComfyUI rather than
 * from this machine, so a remote `COMFY_URL` shows the GPU actually doing the
 * work.
 */
export type GpuStatus = {
  name: string;
  vramTotal: number;
  vramFree: number;
};

export type ComfyStatusResult = {
  comfyStatus: ComfyStatus;
  queueRunning: number;
  queuePending: number;
  /** `null` when ComfyUI is unreachable or reported no GPU device. */
  gpu: GpuStatus | null;
};

export type OutputKind = "image" | "video" | "audio" | "file";

/** One file produced by a run, resolved to a URL that ComfyUI will serve. */
export type RunOutput = {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
  kind: OutputKind;
  url: string;
};

/**
 * Parameters a caller may override on a run. Every field is optional: a field
 * left out keeps whatever the workflow file already had, and a field whose slot
 * was not detected in that workflow is silently ignored.
 */
export type RunParams = {
  /** Filename as returned by ComfyUI's `/upload/image`, not a local path. */
  imageFilename?: string;
  positivePrompt?: string;
  negativePrompt?: string;
  /** Applied to every detected seed input. Randomised when omitted. */
  seed?: number;
  /** Converted to a frame count using `fps`, for video workflows. */
  seconds?: number;
  fps?: number;
};

export type JobSource = "ui" | "upstream";

export type JobState = "running" | "succeeded" | "failed";

export type JobRecord = {
  id: string;
  source: JobSource;
  /** Upstream server name for claimed jobs; undefined for UI test runs. */
  origin?: string;
  workflow: string;
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  promptId?: string;
  outputs?: RunOutput[];
  error?: string;
  /**
   * The process died while this job was running. Flagged rather than left to
   * `error` alone so the UI can say it in the reader's own language.
   */
  interrupted?: boolean;
};

/** Job payload handed out by an upstream server's claim endpoint. */
export type ClaimedJob = {
  jobId: string;
  userId: string;
  sourceImageBase64: string;
  sourceImageContentType: string;
  /** Optional per-job overrides; upstreams that don't send these get defaults. */
  params?: RunParams;
  /** Workflow name to run. Falls back to the active workflow when absent. */
  workflow?: string;
};
