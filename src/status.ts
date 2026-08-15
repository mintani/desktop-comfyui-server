import { checkComfy } from "./comfy";
import { COMFY_URL } from "./config";
import type { ComfyStatusResult } from "./types";

/**
 * Cached ComfyUI status. Both the heartbeat and the UI want it, and neither
 * should hit `/system_stats` on its own schedule, so it is polled once here.
 */
let latest: ComfyStatusResult = {
  comfyStatus: "unavailable",
  queueRunning: 0,
  queuePending: 0,
};
let checkedAt = 0;

export function latestStatus(): ComfyStatusResult & { checkedAt: number } {
  return { ...latest, checkedAt };
}

export async function refreshStatus(): Promise<ComfyStatusResult> {
  latest = await checkComfy(COMFY_URL);
  checkedAt = Date.now();
  return latest;
}

export function startStatusPolling(intervalMs: number): ReturnType<typeof setInterval> {
  void refreshStatus();
  return setInterval(() => void refreshStatus(), intervalMs);
}
