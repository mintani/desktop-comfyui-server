import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { collectOutputs, queuePrompt, runFailure, waitForPrompt } from "./comfy";
import { COMFY_URL, JOB_TIMEOUT_MS, WORKFLOW_DIR } from "./config";
import { loadSettings, saveSettings } from "./settings";
import { applyOverrides, detectSlots, parseApiWorkflow, readNumber } from "./slots";
import type { ApiWorkflow, Slot, SlotOverrides, WorkflowSlots } from "./slots";
import type { RunOutput, RunParams, ServerWorkflow } from "./types";

export type LoadedWorkflow = {
  name: string;
  file: string;
  workflow: ApiWorkflow;
  slots: WorkflowSlots;
  /** Slot keys that came from the sidecar rather than detection. */
  overridden: string[];
  nodeCount: number;
};

export type WorkflowSummary = {
  name: string;
  valid: boolean;
  error?: string;
  nodeCount?: number;
  slots?: WorkflowSlots;
  overridden?: string[];
};

/**
 * Workflow names reach here from the HTTP layer, so anything that could escape
 * the workflow directory has to be rejected rather than sanitised.
 */
const SAFE_NAME = /^[A-Za-z0-9._\-()[\] ]+$/;

function workflowPath(name: string): string {
  if (!SAFE_NAME.test(name) || name.includes("..")) {
    throw new Error(`invalid workflow name: "${name}"`);
  }
  return join(WORKFLOW_DIR, `${name}.json`);
}

function sidecarPath(name: string): string {
  return join(WORKFLOW_DIR, `${name}.slots.json`);
}

export async function listWorkflowNames(): Promise<string[]> {
  const entries = await readdir(WORKFLOW_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".slots.json"),
    )
    .map((entry) => basename(entry.name, ".json"))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Parsing is cached on file identity (mtime + size) rather than a timer, so an
 * edited workflow is picked up on the next request without a restart, while the
 * UI polling every couple of seconds does not re-parse megabytes of JSON.
 */
type CacheEntry = { key: string; result: LoadedWorkflow | { error: string } };
const cache = new Map<string, CacheEntry>();

async function fileKey(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "-";
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readWorkflow(name: string): Promise<LoadedWorkflow | { error: string }> {
  const file = workflowPath(name);
  const key = `${await fileKey(file)}|${await fileKey(sidecarPath(name))}`;

  const cached = cache.get(name);
  if (cached?.key === key) return cached.result;

  const result = await parseWorkflowFiles(name, file);
  cache.set(name, { key, result });
  return result;
}

async function parseWorkflowFiles(
  name: string,
  file: string,
): Promise<LoadedWorkflow | { error: string }> {
  let workflow: ApiWorkflow;
  try {
    workflow = parseApiWorkflow(await readJson(file));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  let overrides: SlotOverrides = {};
  try {
    const raw = await readJson(sidecarPath(name)).catch(() => null);
    if (raw !== null) overrides = raw as SlotOverrides;
  } catch (err) {
    return {
      error: `${name}.slots.json is not valid JSON: ${err instanceof Error ? err.message : err}`,
    };
  }

  try {
    const { slots, overridden } = applyOverrides(workflow, detectSlots(workflow), overrides);
    return { name, file, workflow, slots, overridden, nodeCount: Object.keys(workflow).length };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function clearWorkflowCache(): void {
  cache.clear();
}

export async function loadWorkflow(name: string): Promise<LoadedWorkflow> {
  const result = await readWorkflow(name);
  if ("error" in result) throw new Error(`workflow "${name}": ${result.error}`);
  return result;
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const names = await listWorkflowNames();
  return Promise.all(
    names.map(async (name): Promise<WorkflowSummary> => {
      const result = await readWorkflow(name);
      if ("error" in result) return { name, valid: false, error: result.error };
      return {
        name,
        valid: true,
        nodeCount: result.nodeCount,
        slots: result.slots,
        overridden: result.overridden,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Active workflow — the one used for jobs that don't name one explicitly.
// ---------------------------------------------------------------------------

async function readSavedChoice(): Promise<string | null> {
  return (await loadSettings()).activeWorkflow;
}

/**
 * Resolve the active workflow. Dropping a single file into the directory should
 * be enough to get running, so with no saved choice the first *parseable* file
 * wins — picking one that fails to load just because it sorts first would leave
 * the server unable to run anything.
 *
 * A choice the user made is honoured even when the file no longer parses, so
 * the breakage surfaces instead of quietly running a different workflow.
 */
export async function activeWorkflowName(): Promise<string | null> {
  const names = await listWorkflowNames();
  const saved = await readSavedChoice();
  if (saved && names.includes(saved)) return saved;

  const summaries = await listWorkflows();
  return summaries.find((summary) => summary.valid)?.name ?? names[0] ?? null;
}

export async function setActiveWorkflow(name: string): Promise<void> {
  const names = await listWorkflowNames();
  if (!names.includes(name)) throw new Error(`no such workflow: "${name}"`);
  await saveSettings({ activeWorkflow: name });
}

/**
 * Write an uploaded workflow to disk. The JSON is parsed as an API-format
 * workflow first, so a file that cannot run never lands in the directory and
 * the uploader is told why on the spot.
 */
export async function saveWorkflowFile(name: string, json: string): Promise<WorkflowSummary> {
  const trimmed = name.replace(/\.json$/i, "").trim();
  if (!trimmed) throw new Error("a file name is required");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`not valid JSON: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  }

  // Throws with the reason when this is a UI-format export rather than API.
  parseApiWorkflow(parsed);

  const file = workflowPath(trimmed);
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
  cache.delete(trimmed);

  const summaries = await listWorkflows();
  return summaries.find((summary) => summary.name === trimmed)!;
}

export async function deleteWorkflowFile(name: string): Promise<void> {
  await rm(workflowPath(name));
  await rm(sidecarPath(name), { force: true });
  cache.delete(name);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Copy the workflow with the caller's parameters written into the detected
 * slots. Parameters with no matching slot in this workflow are dropped — a
 * workflow without a LoadImage simply ignores an image.
 */
export function applyParams(loaded: LoadedWorkflow, params: RunParams): ApiWorkflow {
  const workflow = structuredClone(loaded.workflow);
  const { slots } = loaded;

  const set = (slot: Slot | null, value: unknown) => {
    if (!slot) return;
    const node = workflow[slot.nodeId];
    if (node) node.inputs[slot.input] = value;
  };

  if (params.imageFilename !== undefined) set(slots.image, params.imageFilename);
  if (params.positivePrompt !== undefined) set(slots.positive, params.positivePrompt);
  if (params.negativePrompt !== undefined) set(slots.negative, params.negativePrompt);
  if (params.fps !== undefined) set(slots.frameRate, params.fps);

  // Randomise unless the caller pinned a seed, otherwise every run would reuse
  // whatever was baked into the file and produce identical output.
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
  for (const slot of slots.seed) set(slot, seed);

  if (params.seconds !== undefined && slots.length) {
    const fps = params.fps ?? readNumber(loaded.workflow, slots.frameRate) ?? 16;
    set(slots.length, Math.max(1, Math.round(params.seconds * fps)));
  }

  return workflow;
}

/**
 * Queue a workflow and wait for it to finish. `onQueued` fires as soon as
 * ComfyUI accepts the prompt, so callers can record the id before the wait.
 */
export async function runWorkflow(
  name: string,
  params: RunParams,
  onQueued?: (promptId: string) => void,
): Promise<RunOutput[]> {
  const loaded = await loadWorkflow(name);
  const promptId = await queuePrompt(COMFY_URL, applyParams(loaded, params));
  onQueued?.(promptId);

  const entry = await waitForPrompt(COMFY_URL, promptId, JOB_TIMEOUT_MS);

  const failure = runFailure(entry);
  if (failure) throw new Error(failure);

  const outputs = collectOutputs(COMFY_URL, entry);
  if (outputs.length === 0) {
    throw new Error("run finished but produced no files — does the workflow have a save node?");
  }
  return outputs;
}

/**
 * Placeholders a server-supplied workflow may carry (douga-workflow #127).
 * Node ids differ per workflow, so the substitution points are marked in the
 * JSON itself; this walks every node's inputs and swaps values, never touching
 * the graph's structure.
 *
 * - "__INPUT_IMAGE__"   → the uploaded input image's filename
 * - "__TRIGGER_WORDS__" → the preset's trigger words (empty when null)
 * - "__SEED__"          → a random seed (number)
 */
function substitutePlaceholders(
  workflow: ApiWorkflow,
  imageFilename: string | undefined,
  triggerWords: string | null,
): void {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const trigger = triggerWords ?? "";
  for (const node of Object.values(workflow)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (value === "__INPUT_IMAGE__") {
        if (imageFilename) node.inputs[name] = imageFilename;
      } else if (value === "__SEED__") {
        node.inputs[name] = seed;
      } else if (typeof value === "string" && value.includes("__TRIGGER_WORDS__")) {
        // No joining commas or spaces added here; the JSON's author decides.
        node.inputs[name] = value.replaceAll("__TRIGGER_WORDS__", trigger);
      }
    }
  }
}

/**
 * Runs a workflow the server shipped with the job. Same submit/wait/collect
 * path as {@link runWorkflow}; only where the JSON comes from differs.
 */
export async function runServerWorkflow(
  spec: ServerWorkflow,
  imageFilename: string | undefined,
  onQueued?: (promptId: string) => void,
): Promise<RunOutput[]> {
  let workflow: ApiWorkflow;
  try {
    workflow = parseApiWorkflow(JSON.parse(spec.workflowJson));
  } catch (err) {
    throw new Error(
      `preset workflow is not a valid API-format workflow: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    );
  }
  substitutePlaceholders(workflow, imageFilename, spec.triggerWords);

  const promptId = await queuePrompt(COMFY_URL, workflow);
  onQueued?.(promptId);

  const entry = await waitForPrompt(COMFY_URL, promptId, JOB_TIMEOUT_MS);

  const failure = runFailure(entry);
  if (failure) throw new Error(failure);

  const outputs = collectOutputs(COMFY_URL, entry);
  if (outputs.length === 0) {
    throw new Error("run finished but produced no files — does the workflow have a save node?");
  }
  return outputs;
}
