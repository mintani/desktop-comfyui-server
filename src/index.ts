import { mkdir } from "node:fs/promises";
import { startAgent, stopAgent } from "./agent";
import { startComfyWatch, stopComfy } from "./comfy-process";
import { COMFY_URL, DATA_DIR, UI_ENABLED, WORKFLOW_DIR } from "./config";
import { loadJobs } from "./jobs";
import { loadSettings } from "./settings";
import { startStatusPolling } from "./status";
import { startUi } from "./ui/server";
import { activeUpstreams } from "./upstream";
import { activeWorkflowName, listWorkflowNames } from "./workflow";

const STATUS_POLL_MS = 5000;

// The desktop app hands over a directory that has never been used before, so
// nothing here can assume the places it writes to already exist.
await mkdir(DATA_DIR, { recursive: true });
await mkdir(WORKFLOW_DIR, { recursive: true });

const settings = await loadSettings();
await loadJobs();

console.log(`[boot] ComfyUI:   ${COMFY_URL}`);
console.log(`[boot] Workflows: ${WORKFLOW_DIR}`);
if (settings.comfyDir) console.log(`[boot] ComfyUI dir: ${settings.comfyDir}`);

const names = await listWorkflowNames();
const active = await activeWorkflowName();
if (names.length === 0) {
  console.warn(
    "[boot] no workflows found — export one from ComfyUI with Workflow → Export (API)" +
      ` and drop it into ${WORKFLOW_DIR}, or upload one from the Workflows page`,
  );
} else {
  console.log(`[boot] Found ${names.length} workflow(s), active: ${active}`);
}

const statusTimer = startStatusPolling(STATUS_POLL_MS);
const comfyWatch = startComfyWatch();

if (UI_ENABLED) {
  const server = startUi();
  console.log(`[boot] Management UI on http://${server.hostname}:${server.port}`);
}

const upstreams = activeUpstreams(settings);
if (upstreams.length > 0) {
  for (const server of upstreams) console.log(`[boot] Upstream:  ${server.name} (${server.url})`);
  startAgent(upstreams);
} else {
  console.log("[boot] No upstream servers configured — running standalone (UI only)");
}

function shutdown() {
  stopAgent();
  clearInterval(statusTimer);
  clearInterval(comfyWatch);
  void stopComfy();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
