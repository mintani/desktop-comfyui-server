/**
 * Workflow introspection.
 *
 * Workflows are supplied by the user, so no node id can be hardcoded. Instead
 * the graph is read back: image loaders are found by class, prompts by walking
 * a sampler's `positive` / `negative` links back to whatever node actually
 * holds the text, seeds by input name. Detection is best-effort by design and
 * every slot can be overridden from a `<workflow>.slots.json` sidecar.
 */

export type ApiNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

/** ComfyUI API format: a flat map of node id to node. */
export type ApiWorkflow = Record<string, ApiNode>;

export type Slot = {
  nodeId: string;
  input: string;
  /** Node title for display, from `_meta.title` or the class name. */
  label: string;
};

export type WorkflowSlots = {
  /** Every image loader, in node-id order; input images are written in that order. */
  images: Slot[];
  positive: Slot | null;
  negative: Slot | null;
  /** All seed-ish inputs; they are set together so a run is reproducible. */
  seed: Slot[];
  /** Frame count on video workflows. */
  length: Slot | null;
  frameRate: Slot | null;
};

export type SlotRef = { nodeId: string; input: string };

/** Sidecar overrides. A key set to `null` disables that parameter. */
export type SlotOverrides = Partial<{
  images: SlotRef[] | null;
  /** The older single form: one image, the same as a one-item `images`. */
  image: SlotRef | null;
  positive: SlotRef | null;
  negative: SlotRef | null;
  seed: SlotRef[] | null;
  length: SlotRef | null;
  frameRate: SlotRef | null;
}>;

/** A wired input: `[sourceNodeId, outputIndex]`. */
type Link = [string, number];

function isLink(value: unknown): value is Link {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

/**
 * Validate and narrow raw JSON to the API format.
 *
 * Throws with a message meant to be shown to the user — the common mistake is
 * saving the editor format, which has `nodes` / `links` arrays instead.
 */
export function parseApiWorkflow(raw: unknown): ApiWorkflow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("not a JSON object");
  }
  if (Array.isArray((raw as { nodes?: unknown }).nodes)) {
    throw new Error(
      "editor-format workflow — re-export it with Workflow → Export (API) in ComfyUI",
    );
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) throw new Error("workflow has no nodes");

  // No prototype, so a node called `__proto__` or `constructor` is just a node.
  const workflow: ApiWorkflow = Object.create(null) as ApiWorkflow;
  for (const [id, node] of entries) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      throw new Error(`node "${id}" is not an object`);
    }
    const { class_type, inputs } = node as Partial<ApiNode>;
    if (typeof class_type !== "string") {
      throw new Error(`node "${id}" has no class_type`);
    }
    if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
      throw new Error(`node "${id}" has no inputs object`);
    }
    workflow[id] = node as ApiNode;
  }
  return workflow;
}

function makeSlot(workflow: ApiWorkflow, nodeId: string, input: string): Slot {
  const node = workflow[nodeId];
  return { nodeId, input, label: node?._meta?.title ?? node?.class_type ?? nodeId };
}

const IMAGE_LOADER_CLASSES = new Set(["LoadImage", "LoadImageMask", "LoadImageOutput"]);

/**
 * Every image loader, in node-id order — the order input images are written
 * in, so a workflow that compares two pictures takes them as its two loaders
 * are numbered. Custom packs wrap the loader under their own name, so a looser
 * match is tried before giving up, but only one tier is taken: a `LoadImage`
 * beside a custom loader means the custom one is there for something else.
 */
function detectImages(workflow: ApiWorkflow): Slot[] {
  const candidates = Object.entries(workflow).filter(
    ([, node]) => typeof node.inputs["image"] === "string",
  );
  const exact = candidates.filter(([, node]) => IMAGE_LOADER_CLASSES.has(node.class_type));
  const loose = candidates.filter(([, node]) => /load.*image/i.test(node.class_type));
  const picked = exact.length > 0 ? exact : loose.length > 0 ? loose : candidates.slice(0, 1);
  return picked.map(([id]) => makeSlot(workflow, id, "image"));
}

const SEED_INPUTS = ["seed", "noise_seed"] as const;

function detectSeeds(workflow: ApiWorkflow): Slot[] {
  const slots: Slot[] = [];
  for (const [id, node] of Object.entries(workflow)) {
    for (const key of SEED_INPUTS) {
      if (typeof node.inputs[key] === "number") slots.push(makeSlot(workflow, id, key));
    }
  }
  return slots;
}

/**
 * Walk backwards from `startId` to the first node that holds literal text.
 * Conditioning is often piped through wrappers (guidance, zero-out, combine),
 * so the text is rarely one hop away.
 */
function traceToText(
  workflow: ApiWorkflow,
  startId: string,
  seen: Set<string> = new Set(),
): Slot | null {
  if (seen.has(startId)) return null;
  seen.add(startId);

  const node = workflow[startId];
  if (!node) return null;
  if (typeof node.inputs["text"] === "string") return makeSlot(workflow, startId, "text");

  for (const value of Object.values(node.inputs)) {
    if (!isLink(value)) continue;
    const found = traceToText(workflow, value[0], seen);
    if (found) return found;
  }
  return null;
}

function detectPrompts(workflow: ApiWorkflow): { positive: Slot | null; negative: Slot | null } {
  for (const node of Object.values(workflow)) {
    const positiveLink = node.inputs["positive"];
    const negativeLink = node.inputs["negative"];
    if (!isLink(positiveLink) && !isLink(negativeLink)) continue;

    const positive = isLink(positiveLink) ? traceToText(workflow, positiveLink[0]) : null;
    let negative = isLink(negativeLink) ? traceToText(workflow, negativeLink[0]) : null;

    // A negative branch built from the positive conditioning (ConditioningZeroOut
    // and friends) traces back to the same text node. Writing both would make the
    // negative prompt overwrite the positive one, so drop it.
    if (negative && positive && negative.nodeId === positive.nodeId) negative = null;

    if (positive || negative) return { positive, negative };
  }
  return { positive: null, negative: null };
}

function detectNumeric(workflow: ApiWorkflow, input: string): Slot | null {
  for (const [id, node] of Object.entries(workflow)) {
    if (typeof node.inputs[input] === "number") return makeSlot(workflow, id, input);
  }
  return null;
}

export function detectSlots(workflow: ApiWorkflow): WorkflowSlots {
  const { positive, negative } = detectPrompts(workflow);
  return {
    images: detectImages(workflow),
    positive,
    negative,
    seed: detectSeeds(workflow),
    length: detectNumeric(workflow, "length"),
    frameRate: detectNumeric(workflow, "frame_rate"),
  };
}

function resolveRef(workflow: ApiWorkflow, ref: SlotRef, key: string): Slot {
  if (typeof ref?.nodeId !== "string" || typeof ref?.input !== "string") {
    throw new Error(`override "${key}" needs both nodeId and input`);
  }
  if (!workflow[ref.nodeId]) {
    throw new Error(
      `override "${key}" points at node "${ref.nodeId}", which is not in the workflow`,
    );
  }
  return makeSlot(workflow, ref.nodeId, ref.input);
}

/**
 * Merge sidecar overrides over the detected slots. Keys absent from the
 * sidecar keep their detected value; keys set to `null` are disabled.
 *
 * Throws when an override names a node that does not exist — a silent no-op
 * here would surface much later as a run that ignored its parameters.
 */
export function applyOverrides(
  workflow: ApiWorkflow,
  detected: WorkflowSlots,
  overrides: SlotOverrides,
): { slots: WorkflowSlots; overridden: string[] } {
  const slots: WorkflowSlots = { ...detected };
  const overridden: string[] = [];

  for (const key of ["positive", "negative", "length", "frameRate"] as const) {
    const ref = overrides[key];
    if (ref === undefined) continue;
    slots[key] = ref === null ? null : resolveRef(workflow, ref, key);
    overridden.push(key);
  }

  const lists = [
    ["images", imageOverride(overrides)],
    ["seed", overrides.seed],
  ] as const;
  for (const [key, refs] of lists) {
    if (refs === undefined) continue;
    if (refs !== null && !Array.isArray(refs)) {
      throw new Error(`override "${key}" must be an array of { nodeId, input }`);
    }
    slots[key] = refs === null ? [] : refs.map((ref) => resolveRef(workflow, ref, key));
    overridden.push(key);
  }

  return { slots, overridden };
}

/** `image`, the older single form, reads as a one-item `images`. */
function imageOverride(overrides: SlotOverrides): SlotRef[] | null | undefined {
  if (overrides.images !== undefined) return overrides.images;
  if (overrides.image === undefined) return undefined;
  return overrides.image === null ? null : [overrides.image];
}

/** Current literal value at a slot, when it is a plain number rather than a link. */
export function readNumber(workflow: ApiWorkflow, slot: Slot | null): number | null {
  if (!slot) return null;
  const value = workflow[slot.nodeId]?.inputs[slot.input];
  return typeof value === "number" ? value : null;
}
