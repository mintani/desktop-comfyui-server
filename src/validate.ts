/**
 * Check a workflow against the ComfyUI it would run on, without running it.
 *
 * A workflow that names a model or a custom node this machine does not have
 * fails only when a run reaches that node — minutes in, after a claim. ComfyUI
 * already knows everything needed to say so up front: `/object_info` lists
 * every installed node class, and for each combo input the exact choices on
 * offer (which is where checkpoints, LoRAs and VAEs live). This compares the
 * workflow's literal values against that list.
 *
 * Inputs the app rewrites at run time — the detected slots, the input image
 * above all — are left out: their stored value is about to be replaced, so its
 * absence proves nothing.
 */

import { COMFY_URL } from "./config";
import { loadWorkflow } from "./workflow";
import type { Slot, WorkflowSlots } from "./slots";

type InputSpec = unknown[];

type ObjectInfo = Record<
  string,
  {
    input?: {
      required?: Record<string, InputSpec>;
      optional?: Record<string, InputSpec>;
    };
  }
>;

/**
 * `/object_info` is megabytes and changes only when models or nodes are
 * installed, so one minute of reuse spares ComfyUI without going stale enough
 * to mislead anyone.
 */
const OBJECT_INFO_TTL_MS = 60_000;

let cached: { at: number; info: ObjectInfo } | null = null;

async function objectInfo(): Promise<ObjectInfo> {
  if (cached && Date.now() - cached.at < OBJECT_INFO_TTL_MS) return cached.info;

  let res: Response;
  try {
    res = await fetch(`${COMFY_URL}/object_info`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("ComfyUI is not answering — start it before checking");
  }
  if (!res.ok) throw new Error(`ComfyUI /object_info failed: HTTP ${res.status}`);

  const info = (await res.json()) as ObjectInfo;
  cached = { at: Date.now(), info };
  return info;
}

function slotRefs(slots: WorkflowSlots): Set<string> {
  const refs = new Set<string>();
  const add = (slot: Slot | null) => {
    if (slot) refs.add(`${slot.nodeId}:${slot.input}`);
  };
  add(slots.image);
  add(slots.positive);
  add(slots.negative);
  add(slots.length);
  add(slots.frameRate);
  for (const seed of slots.seed) add(seed);
  return refs;
}

export type WorkflowCheck = {
  ok: boolean;
  /** Worded server-side, like every other error the UI passes through. */
  problems: string[];
  checkedNodes: number;
};

export async function checkWorkflow(name: string): Promise<WorkflowCheck> {
  const loaded = await loadWorkflow(name);
  const info = await objectInfo();
  const replaced = slotRefs(loaded.slots);

  const problems: string[] = [];

  for (const [nodeId, node] of Object.entries(loaded.workflow)) {
    const spec = info[node.class_type];
    if (!spec) {
      problems.push(`node ${nodeId}: ${node.class_type} is not installed in this ComfyUI`);
      continue;
    }

    const inputSpecs = { ...spec.input?.required, ...spec.input?.optional };
    for (const [inputName, value] of Object.entries(node.inputs)) {
      // Combo choices are strings; anything else is a number, a link, or text.
      if (typeof value !== "string") continue;
      if (replaced.has(`${nodeId}:${inputName}`)) continue;

      const choices = inputSpecs[inputName]?.[0];
      if (!Array.isArray(choices) || !choices.every((entry) => typeof entry === "string")) {
        continue;
      }
      if (choices.includes(value)) continue;

      problems.push(
        choices.length === 0
          ? `node ${nodeId} (${node.class_type}): ${inputName} "${value}" — this ComfyUI has nothing installed to choose from`
          : `node ${nodeId} (${node.class_type}): ${inputName} "${value}" is not among the ${choices.length} choices this ComfyUI offers`,
      );
    }
  }

  return { ok: problems.length === 0, problems, checkedNodes: Object.keys(loaded.workflow).length };
}
