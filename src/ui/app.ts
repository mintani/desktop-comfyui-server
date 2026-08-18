/**
 * Management UI. Plain DOM on purpose — this ships with zero runtime
 * dependencies so the server stays a single `bun run` away from working.
 *
 * One page is shown at a time, chosen from the sidebar and remembered in the
 * hash. Polled state repaints the read-only parts; anything the user is typing
 * into is left alone until they save or revert.
 */

import { LANGS, lang, locale, onLangChange, setLang, t } from "./i18n";
import type { Key, Lang } from "./i18n";

type RunMode = "accepting" | "local" | "paused";

type Slot = { nodeId: string; input: string; label: string };

type WorkflowSlots = {
  image: Slot | null;
  positive: Slot | null;
  negative: Slot | null;
  seed: Slot[];
  length: Slot | null;
  frameRate: Slot | null;
};

type WorkflowSummary = {
  name: string;
  valid: boolean;
  error?: string;
  nodeCount?: number;
  slots?: WorkflowSlots;
  overridden?: string[];
};

type RunOutput = {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
  kind: "image" | "video" | "audio" | "file";
};

type JobRecord = {
  id: string;
  source: "ui" | "upstream";
  origin?: string;
  workflow: string;
  state: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  promptId?: string;
  outputs?: RunOutput[];
  error?: string;
  interrupted?: boolean;
};

type UpstreamView = {
  id: string;
  name: string;
  url: string;
  hostId: string;
  enabled: boolean;
  hasSecret: boolean;
};

type State = {
  comfy: {
    url: string;
    comfyStatus: "available" | "busy" | "unavailable";
    queueRunning: number;
    queuePending: number;
    checkedAt: number;
  };
  comfyProcess: {
    managed: boolean;
    pid: number | null;
    startedAt: number | null;
    error: string | null;
    log: string[];
    command: string;
    dir: string;
  };
  workflows: WorkflowSummary[];
  workflowDir: string;
  activeWorkflow: string | null;
  agent: {
    running: boolean;
    autoUpdate: boolean;
    upstreams: {
      name: string;
      url: string;
      hostId: string;
      heartbeat: { ok: boolean; at: number; pendingJobs?: number } | null;
    }[];
  };
  upstreams: UpstreamView[];
  settings: { comfyDir: string; comfyCommand: string };
  mode: RunMode;
  accepting: {
    accepting: boolean;
    blockedBy: "mode" | "paused" | "schedule" | null;
    pausedUntil: number | null;
    schedule: { enabled: boolean; from: string; to: string };
  };
  desktop: { autostart: boolean; closeAction: "tray" | "quit" };
  jobs: JobRecord[];
};

const POLL_MS = 2000;
const PAGES = ["settings", "generate"] as const;
type Page = (typeof PAGES)[number];

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

const nodes = {
  comfyUrl: el("comfy-url"),
  comfyPower: el<HTMLButtonElement>("comfy-power"),
  comfyPower2: el<HTMLButtonElement>("comfy-power-2"),
  comfyProcess: el("comfy-process"),
  vitals: el("vitals"),
  workflows: el("workflows"),
  workflowDir: el("workflow-dir"),
  servers: el("servers"),
  serversNote: el("servers-note"),
  jobs: el("jobs"),
  form: el<HTMLFormElement>("run-form"),
  select: el<HTMLSelectElement>("run-workflow"),
  submit: el<HTMLButtonElement>("run-submit"),
  note: el("run-note"),
  reload: el<HTMLButtonElement>("reload"),
  interrupt: el<HTMLButtonElement>("interrupt"),
  uploadForm: el<HTMLFormElement>("upload-form"),
  uploadFile: el<HTMLInputElement>("upload-file"),
  uploadName: el<HTMLInputElement>("upload-name"),
  uploadNote: el("upload-note"),
  settingsForm: el<HTMLFormElement>("settings-form"),
  comfyDir: el<HTMLInputElement>("comfy-dir"),
  comfyCommand: el<HTMLInputElement>("comfy-command"),
  settingsNote: el("settings-note"),
  desktopOpen: el<HTMLButtonElement>("desktop-open"),
  desktopPanel: el("desktop-panel"),
  modeOpen: el<HTMLButtonElement>("mode-open"),
  modePanel: el("mode-panel"),
  modeDot: el("mode-dot"),
  modeLabel: el("mode-label"),
  modeGate: el("mode-gate"),
  modeNote: el("mode-note"),
  acceptPause: el("accept-pause"),
  acceptPauseState: el("accept-pause-state"),
  acceptEnabled: el<HTMLInputElement>("accept-enabled"),
  acceptFrom: el<HTMLInputElement>("accept-from"),
  acceptTo: el<HTMLInputElement>("accept-to"),
  acceptNote: el("accept-note"),
  desktopAutostart: el<HTMLInputElement>("desktop-autostart"),
  desktopNote: el("desktop-note"),
};

function esc(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? t("time.minutes", { minutes, seconds }) : t("time.seconds", { seconds });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(locale());
}

/** Whole minutes still to go. Never zero: seconds left is still time left. */
function minutesLeft(until: number): number {
  return Math.max(1, Math.ceil((until - Date.now()) / 60_000));
}

/**
 * The shared secret, when the server was started with one. Handed over once as
 * `?token=…` on the address, then kept here so the address can be tidied up.
 */
const TOKEN_KEY = "ui-token";

function readToken(): string {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // Private mode — it lasts for this tab only.
    }
    history.replaceState(null, "", location.pathname + location.hash);
    return fromUrl;
  }

  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

let token = readToken();

function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function outputUrl(output: RunOutput): string {
  const query = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder,
    type: output.type,
  });
  // An <img> or <video> cannot carry a header, so this one goes in the URL.
  if (token) query.set("token", token);
  return `/api/output?${query}`;
}

async function post<T = unknown>(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; error?: string; data?: T }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        ...authHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json().catch(() => ({}))) as { error?: string } & T;
    return res.ok
      ? { ok: true, data: parsed }
      : { ok: false, error: parsed.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Replace markup only when it actually changed. Re-rendering on every poll
 * would restart any `<video>` the user is watching and make selections flicker.
 */
const lastHtml = new Map<string, string>();

function renderIfChanged(target: HTMLElement, key: string, html: string): void {
  if (lastHtml.get(key) === html) return;
  lastHtml.set(key, html);
  target.innerHTML = html;
}

function setNote(target: HTMLElement, text: string, isError = false): void {
  target.textContent = text;
  target.classList.toggle("error", isError);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Settings is the landing page; running a workflow by hand is the sideline. */
function currentPage(): Page {
  const hash = location.hash.replace(/^#\/?/, "");
  return (PAGES as readonly string[]).includes(hash) ? (hash as Page) : "settings";
}

function showPage(): void {
  const page = currentPage();
  for (const section of document.querySelectorAll<HTMLElement>("[data-page]")) {
    section.hidden = section.dataset["page"] !== page;
  }
  for (const link of document.querySelectorAll<HTMLElement>("[data-page-link]")) {
    link.classList.toggle("on", link.dataset["pageLink"] === page);
  }
}

window.addEventListener("hashchange", showPage);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function chip(key: string, value: string, tone?: string): string {
  const dot = tone ? `<span class="dot ${tone}"></span>` : "";
  return `<span class="chip">${dot}<span class="key">${key}</span><span class="mono">${value}</span></span>`;
}

function comfyStatusLabel(status: State["comfy"]["comfyStatus"]): string {
  if (status === "available") return t("comfy.available");
  if (status === "busy") return t("comfy.busy");
  return t("comfy.unavailable");
}

function renderVitals(state: State): void {
  const { comfy, comfyProcess, agent } = state;
  const tone =
    comfy.comfyStatus === "available" ? "ok" : comfy.comfyStatus === "busy" ? "run" : "bad";

  const total = agent.upstreams.length;
  const healthy = agent.upstreams.filter((server) => server.heartbeat?.ok).length;
  const agentTone = healthy === total ? "ok" : healthy > 0 ? "warn" : "bad";

  // What is holding jobs back beats the mode here: "accepting" with a pause
  // running is not what anyone glancing at the bar wants to be told.
  const gate = state.accepting;
  const work =
    gate.blockedBy === "paused" && gate.pausedUntil !== null
      ? { label: t("accept.paused", { minutes: minutesLeft(gate.pausedUntil) }), tone: "idle" }
      : gate.blockedBy === "schedule"
        ? { label: t("accept.outside"), tone: "idle" }
        : { label: modeLabel(state.mode), tone: MODE_TONE[state.mode] };

  const chips = [
    chip(t("vitals.comfy"), esc(comfyStatusLabel(comfy.comfyStatus)), tone),
    chip(t("vitals.running"), pad(comfy.queueRunning)),
    chip(t("vitals.pending"), pad(comfy.queuePending)),
    total === 0
      ? chip(t("vitals.agent"), t("vitals.standalone"))
      : chip(t("vitals.agent"), `${pad(healthy)}/${pad(total)}`, agentTone),
    chip(t("vitals.work"), work.label, work.tone),
  ];

  if (comfyProcess.managed) {
    chips.push(chip(t("vitals.process"), `pid ${comfyProcess.pid ?? "?"}`, "run"));
  }

  renderIfChanged(nodes.vitals, "vitals", chips.join(""));
}

function renderComfyProcess(state: State): void {
  const { comfyProcess } = state;

  nodes.comfyPower.textContent = comfyProcess.managed ? t("comfy.stop") : t("comfy.start");
  nodes.comfyPower2.textContent = comfyProcess.managed ? t("process.stop") : t("process.start");
  nodes.comfyPower.disabled = !comfyProcess.dir;
  nodes.comfyPower2.disabled = !comfyProcess.dir;
  nodes.comfyPower.title = comfyProcess.dir ? comfyProcess.command : t("comfy.needsDir");

  const lines: string[] = [];
  if (!comfyProcess.dir) {
    lines.push(`<p class="empty">${t("process.noDir")}</p>`);
  } else {
    lines.push(
      `<p class="meta">${esc(comfyProcess.command)}</p>`,
      `<p class="meta">${
        comfyProcess.managed
          ? t("process.startedAt", {
              time: formatTime(comfyProcess.startedAt ?? Date.now()),
              pid: comfyProcess.pid ?? "?",
            })
          : t("process.foreign")
      }</p>`,
    );
  }
  if (comfyProcess.error) lines.push(`<p class="error">${esc(comfyProcess.error)}</p>`);
  if (comfyProcess.log.length > 0) {
    lines.push(`<pre class="log">${esc(comfyProcess.log.join("\n"))}</pre>`);
  }

  renderIfChanged(nodes.comfyProcess, "comfy-process", lines.join(""));
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function slotTags(summary: WorkflowSummary): string {
  const slots = summary.slots;
  if (!slots) return "";
  const overridden = new Set(summary.overridden ?? []);

  const entries: [string, boolean][] = [
    ["image", Boolean(slots.image)],
    ["positive", Boolean(slots.positive)],
    ["negative", Boolean(slots.negative)],
    ["seed", slots.seed.length > 0],
    ["length", Boolean(slots.length)],
    ["frameRate", Boolean(slots.frameRate)],
  ];

  const tags = entries.map(([key, present]) => {
    const cls = overridden.has(key) ? "tag over" : present ? "tag on" : "tag";
    const suffix = key === "seed" && present ? ` ×${slots.seed.length}` : "";
    const title = overridden.has(key)
      ? t("slot.override")
      : present
        ? t("slot.detected")
        : t("slot.missing");
    return `<span class="${cls}" title="${title}">${esc(key)}${suffix}</span>`;
  });

  return `<div class="slots">${tags.join("")}</div>`;
}

function renderWorkflows(state: State): void {
  nodes.workflowDir.textContent = t("workflows.dir", { dir: state.workflowDir });

  if (state.workflows.length === 0) {
    renderIfChanged(nodes.workflows, "workflows", `<p class="empty">${t("workflows.empty")}</p>`);
    return;
  }

  const html = state.workflows
    .map((summary) => {
      const active = summary.name === state.activeWorkflow;
      const head = `
        <div class="entry-head">
          <span class="name">${esc(summary.name)}</span>
          ${active ? `<span class="state"><span class="dot run"></span>${t("workflows.active")}</span>` : ""}
          <span class="spacer"></span>
          ${
            active || !summary.valid
              ? ""
              : `<button type="button" class="ghost" data-activate="${esc(summary.name)}">${t("workflows.makeActive")}</button>`
          }
          <button type="button" class="ghost danger" data-remove-workflow="${esc(summary.name)}">${t("workflows.delete")}</button>
        </div>`;

      if (!summary.valid) {
        return `<div class="entry">${head}<p class="error">${esc(summary.error)}</p></div>`;
      }

      return `<div class="entry">
        ${head}
        <p class="meta">${t("workflows.nodes", { count: summary.nodeCount ?? 0 })}</p>
        ${slotTags(summary)}
      </div>`;
    })
    .join("");

  renderIfChanged(nodes.workflows, "workflows", `<div class="ledger">${html}</div>`);
}

// ---------------------------------------------------------------------------
// Upstream servers — an editor, so polling must not overwrite what is typed
// ---------------------------------------------------------------------------

type UpstreamTest = { ok: boolean; ms: number; pendingJobs?: number; error?: string };

/**
 * A row as it stands on screen: the stored server, the secret box (blank means
 * "keep the stored one"), and the last test of it. `testing` is held on the row
 * rather than globally so testing one server leaves the others alone.
 */
type ServerRow = UpstreamView & { secret: string; testing?: boolean; test?: UpstreamTest };

let serverRows: ServerRow[] | null = null;
let serversDirty = false;

function heartbeatFor(state: State, row: ServerRow): string {
  const live = state.agent.upstreams.find((server) => server.url === row.url);
  if (!live) return `<span class="state">${t("servers.notStarted")}</span>`;
  const beat = live.heartbeat;
  if (!beat) return `<span class="state"><span class="dot"></span>${t("servers.waiting")}</span>`;
  const waiting =
    beat.pendingJobs === undefined ? "" : ` · ${t("servers.queued", { count: beat.pendingJobs })}`;
  return `<span class="state"><span class="dot ${beat.ok ? "ok" : "bad"}"></span>${
    beat.ok ? t("servers.up") : t("servers.down")
  }${waiting}</span>`;
}

/** The last test of this row, in its own words. Nothing until one is run. */
function testResultFor(row: ServerRow): string {
  if (row.testing) return `<p class="meta">${t("servers.testing")}</p>`;
  if (!row.test) return "";

  if (!row.test.ok) {
    return `<p class="error">${t("servers.testFailed", {
      error: esc(row.test.error ?? ""),
    })}</p>`;
  }
  const queued =
    row.test.pendingJobs === undefined
      ? ""
      : ` · ${t("servers.queued", { count: row.test.pendingJobs })}`;
  return `<p class="meta">${t("servers.testOk", { ms: row.test.ms })}${queued}</p>`;
}

function renderServers(state: State): void {
  const rows = serverRows ?? [];

  if (rows.length === 0) {
    nodes.servers.innerHTML = `<p class="empty">${t("servers.empty")}</p>`;
    return;
  }

  nodes.servers.innerHTML = `<div class="ledger">${rows
    .map(
      (row, index) => `
      <div class="entry" data-server="${index}">
        <div class="entry-head">
          <span class="mono muted">${pad(index + 1)}</span>
          ${heartbeatFor(state, row)}
          <span class="spacer"></span>
          <button type="button" class="ghost" data-test-server="${index}">${t(
            "servers.test",
          )}</button>
          <button type="button" class="ghost" data-move="${index}" data-dir="-1" ${
            index === 0 ? "disabled" : ""
          } title="${t("servers.higher")}">↑</button>
          <button type="button" class="ghost" data-move="${index}" data-dir="1" ${
            index === rows.length - 1 ? "disabled" : ""
          } title="${t("servers.lower")}">↓</button>
          <button type="button" class="ghost danger" data-remove-server="${index}">${t(
            "servers.remove",
          )}</button>
        </div>
        <div class="row">
          <label class="field">
            <span>${t("servers.name")}</span>
            <input type="text" data-field="name" value="${esc(row.name)}" placeholder="staging" />
          </label>
          <label class="field">
            <span>${t("servers.url")}</span>
            <input type="text" data-field="url" value="${esc(
              row.url,
            )}" placeholder="https://queue.example.com" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span>${t("servers.hostId")}</span>
            <input type="text" data-field="hostId" value="${esc(row.hostId)}" />
          </label>
          <label class="field">
            <span>${t("servers.secret")}</span>
            <input type="password" data-field="secret" value="${esc(row.secret)}" placeholder="${
              row.hasSecret ? t("servers.secretUnchanged") : t("servers.secretRequired")
            }" />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" data-field="enabled" ${row.enabled ? "checked" : ""} />
          <span>${t("servers.enabled")}</span>
        </label>
        ${testResultFor(row)}
      </div>`,
    )
    .join("")}</div>`;
}

/**
 * Ask one server for a heartbeat now and keep the answer on its row. What is on
 * screen is sent, so a secret typed a moment ago is what gets tried.
 */
async function testServer(index: number): Promise<void> {
  const row = serverRows?.[index];
  if (!row || !latestState) return;

  row.testing = true;
  row.test = undefined;
  renderServers(latestState);

  const result = await post<UpstreamTest>("/api/upstreams/test", {
    id: row.id || undefined,
    url: row.url,
    hostId: row.hostId,
    // Blank means the stored one, exactly as saving reads it.
    secret: row.secret,
  });

  row.testing = false;
  // A request the server refused outright — a row with no URL yet — is the same
  // kind of answer as one it sent: it belongs on the row, not in the console.
  row.test = result.ok
    ? (result.data ?? { ok: true, ms: 0 })
    : { ok: false, ms: 0, error: result.error ?? "" };
  if (latestState) renderServers(latestState);
}

/** Copy what is on screen back into the model before any structural change. */
function readServerInputs(): void {
  if (!serverRows) return;

  for (const entry of nodes.servers.querySelectorAll<HTMLElement>("[data-server]")) {
    const row = serverRows[Number(entry.dataset["server"])];
    if (!row) continue;
    for (const input of entry.querySelectorAll<HTMLInputElement>("[data-field]")) {
      const field = input.dataset["field"];
      if (field === "enabled") row.enabled = input.checked;
      else if (field === "name") row.name = input.value;
      else if (field === "url") row.url = input.value;
      else if (field === "hostId") row.hostId = input.value;
      else if (field === "secret") row.secret = input.value;
    }
  }
}

function syncServers(state: State): void {
  if (serversDirty && serverRows) return;
  serverRows = state.upstreams.map((server) => ({ ...server, secret: "" }));
  renderServers(state);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function renderOutputs(outputs: RunOutput[]): string {
  const media = outputs
    .map((output) => {
      const url = outputUrl(output);
      const name = esc(output.filename);
      if (output.kind === "video") {
        return `<video src="${url}" controls preload="metadata" title="${name}"></video>`;
      }
      if (output.kind === "image") {
        return `<a href="${url}" target="_blank" rel="noreferrer"><img src="${url}" alt="${name}" /></a>`;
      }
      if (output.kind === "audio") return `<audio src="${url}" controls title="${name}"></audio>`;
      return `<a href="${url}" target="_blank" rel="noreferrer">${name}</a>`;
    })
    .join("");
  return `<div class="outputs">${media}</div>`;
}

function jobStateLabel(state: JobRecord["state"]): string {
  if (state === "running") return t("jobs.running");
  if (state === "succeeded") return t("jobs.succeeded");
  return t("jobs.failed");
}

/**
 * Failures worded by ComfyUI or an upstream server are shown as they came;
 * the one this tool writes itself is said in the reader's language.
 */
function jobError(job: JobRecord): string {
  if (job.interrupted) return `<p class="error">${t("jobs.interrupted")}</p>`;
  return job.error ? `<p class="error">${esc(job.error)}</p>` : "";
}

function jobEntry(job: JobRecord, withDelete: boolean): string {
  const tone = job.state === "running" ? "run" : job.state === "succeeded" ? "ok" : "bad";
  const origin =
    job.source === "upstream"
      ? ` · ${esc(job.origin ?? t("jobs.upstream"))}`
      : ` · ${t("jobs.ui")}`;
  const timing =
    job.state === "running"
      ? `<span data-started="${job.startedAt}">${formatDuration(Date.now() - job.startedAt)}</span>`
      : formatDuration((job.finishedAt ?? job.startedAt) - job.startedAt);

  return `<div class="entry">
    <div class="entry-head">
      <span class="name">${esc(job.workflow)}</span>
      <span class="state"><span class="dot ${tone}"></span>${esc(jobStateLabel(job.state))}</span>
      <span class="spacer"></span>
      ${
        withDelete && job.state !== "running"
          ? `<button type="button" class="ghost danger" data-remove-job="${esc(job.id)}">${t("jobs.delete")}</button>`
          : ""
      }
    </div>
    <p class="meta">${formatTime(job.startedAt)} · ${timing}${origin}${
      job.promptId ? ` · ${t("jobs.prompt", { id: esc(job.promptId.slice(0, 8)) })}` : ""
    }</p>
    ${jobError(job)}
    ${job.outputs?.length ? renderOutputs(job.outputs) : ""}
  </div>`;
}

function renderJobs(state: State): void {
  if (state.jobs.length === 0) {
    renderIfChanged(nodes.jobs, "jobs", `<p class="empty">${t("jobs.empty")}</p>`);
    return;
  }
  const html = state.jobs.map((job) => jobEntry(job, true)).join("");
  renderIfChanged(nodes.jobs, "jobs", `<div class="ledger">${html}</div>`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let settingsDirty = false;

function syncSettings(state: State): void {
  if (settingsDirty) return;
  nodes.comfyDir.value = state.settings.comfyDir;
  nodes.comfyCommand.value = state.settings.comfyCommand;
}

// ---------------------------------------------------------------------------
// Header menus
// ---------------------------------------------------------------------------

type Popover = { button: HTMLElement; panel: HTMLElement };

const MODE_POPOVER: Popover = { button: nodes.modeOpen, panel: nodes.modePanel };
const DESKTOP_POPOVER: Popover = { button: nodes.desktopOpen, panel: nodes.desktopPanel };
const POPOVERS = [MODE_POPOVER, DESKTOP_POPOVER];

/** One at a time, and `null` closes them all. */
function openPopover(target: Popover | null): void {
  for (const popover of POPOVERS) {
    const open = popover === target;
    popover.panel.hidden = !open;
    popover.button.setAttribute("aria-expanded", String(open));
  }
  if (target !== DESKTOP_POPOVER) setNote(nodes.desktopNote, "");
  if (target !== MODE_POPOVER) setNote(nodes.modeNote, "");
}

function toggle(popover: Popover): void {
  openPopover(popover.panel.hidden ? popover : null);
}

// ---------------------------------------------------------------------------
// Run mode — what this machine will start
// ---------------------------------------------------------------------------

const MODE_TONE: Record<RunMode, string> = {
  accepting: "ok",
  local: "idle",
  paused: "bad",
};

function modeLabel(mode: RunMode): string {
  return t(`mode.${mode}` as Key);
}

function syncMode(state: State): void {
  nodes.modeDot.className = `dot ${MODE_TONE[state.mode]}`;
  nodes.modeLabel.textContent = modeLabel(state.mode);

  // All three states say what ComfyUI is to do, so with no ComfyUI answering
  // there is nothing to choose between. The stored one still shows, greyed:
  // hiding it would lose the only place that says what this machine is set to.
  const up = state.comfy.comfyStatus !== "unavailable";
  nodes.modeOpen.disabled = !up;
  nodes.modeOpen.title = up ? t("mode.label") : t("mode.needsComfy");
  if (!up && !nodes.modePanel.hidden) openPopover(null);

  for (const option of document.querySelectorAll<HTMLElement>("[data-mode]")) {
    option.setAttribute("aria-pressed", String(option.dataset["mode"] === state.mode));
  }

  const gate = state.accepting;
  nodes.modeGate.textContent =
    gate.blockedBy === "paused" && gate.pausedUntil !== null
      ? t("accept.gatePaused", { minutes: minutesLeft(gate.pausedUntil) })
      : gate.blockedBy === "schedule"
        ? t("accept.gateSchedule", { from: gate.schedule.from, to: gate.schedule.to })
        : "";
}

// ---------------------------------------------------------------------------
// Accepting — when the mode is allowed to claim
// ---------------------------------------------------------------------------

/** Held while a control is in flight, so a poll cannot flip it back. */
let acceptBusy = false;

function syncAccepting(state: State): void {
  const { pausedUntil, schedule } = state.accepting;

  nodes.acceptPauseState.textContent =
    pausedUntil === null
      ? t("accept.notPaused")
      : t("accept.pausedUntil", {
          time: formatTime(pausedUntil),
          minutes: minutesLeft(pausedUntil),
        });

  // Nothing to resume from when nothing is on hold.
  for (const button of nodes.acceptPause.querySelectorAll<HTMLButtonElement>('[data-pause="0"]')) {
    button.disabled = pausedUntil === null;
  }

  if (acceptBusy) return;
  nodes.acceptEnabled.checked = schedule.enabled;
  // A time is saved as soon as it changes, so the only field worth leaving
  // alone is the one being typed into.
  if (document.activeElement !== nodes.acceptFrom) nodes.acceptFrom.value = schedule.from;
  if (document.activeElement !== nodes.acceptTo) nodes.acceptTo.value = schedule.to;
}

/** Send one change, then let the next poll confirm it. */
async function saveAccepting(path: string, body: unknown): Promise<void> {
  acceptBusy = true;
  const result = await post(path, body);
  acceptBusy = false;

  setNote(
    nodes.acceptNote,
    result.ok ? t("accept.saved") : (result.error ?? t("accept.saveFailed")),
    !result.ok,
  );
  void poll();
}

// ---------------------------------------------------------------------------
// Desktop menu — the same switches the tray menu carries
// ---------------------------------------------------------------------------

/** Held while a switch is in flight, so a poll cannot flip it back. */
let desktopBusy = false;

function syncDesktop(state: State): void {
  if (desktopBusy) return;
  nodes.desktopAutostart.checked = state.desktop.autostart;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-action]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset["closeAction"] === state.desktop.closeAction),
    );
  }
}

/** Send one switch, then let the next poll confirm it. */
async function saveDesktop(path: string, body: unknown): Promise<void> {
  desktopBusy = true;
  const result = await post(path, body);
  desktopBusy = false;

  setNote(
    nodes.desktopNote,
    result.ok ? t("desktop.saved") : (result.error ?? t("desktop.saveFailed")),
    !result.ok,
  );
  void poll();
}

// ---------------------------------------------------------------------------
// Run form
// ---------------------------------------------------------------------------

let selectKey = "";

function syncForm(state: State): void {
  const valid = state.workflows.filter((summary) => summary.valid).map((summary) => summary.name);
  const key = valid.join(" ");

  // Assigning a value the select has no option for silently blanks it, which
  // would then read back as "no workflow" — so only ever pick from `valid`.
  const pick = (...candidates: (string | null)[]): string =>
    candidates.find((name): name is string => name !== null && valid.includes(name)) ??
    valid[0] ??
    "";

  if (key !== selectKey) {
    selectKey = key;
    const previous = nodes.select.value;
    nodes.select.innerHTML = valid
      .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
      .join("");
    nodes.select.value = pick(previous, state.activeWorkflow);
  } else if (!valid.includes(nodes.select.value)) {
    nodes.select.value = pick(state.activeWorkflow);
  }

  const paused = state.mode === "paused";
  nodes.submit.disabled = valid.length === 0 || paused;
  nodes.submit.title = paused ? t("run.paused") : "";

  const selected = state.workflows.find((summary) => summary.name === nodes.select.value);
  const slots = selected?.slots;

  for (const field of document.querySelectorAll<HTMLElement>("[data-slot]")) {
    const slotKey = field.dataset["slot"];
    if (!slotKey) continue;
    const present = !slots
      ? false
      : slotKey === "seed"
        ? slots.seed.length > 0
        : Boolean(slots[slotKey as keyof WorkflowSlots]);

    field.classList.toggle("disabled", !present);
    // Disabled controls are left out of FormData, which is what we want: a
    // parameter with no slot must not be sent at all.
    const input = field.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    if (input) input.disabled = !present;
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let latestState: State | null = null;

function render(state: State): void {
  latestState = state;
  nodes.comfyUrl.textContent = state.comfy.url;
  renderVitals(state);
  renderComfyProcess(state);
  renderWorkflows(state);
  syncServers(state);
  renderJobs(state);
  syncSettings(state);
  syncMode(state);
  syncAccepting(state);
  syncDesktop(state);
  syncForm(state);
}

async function poll(): Promise<void> {
  try {
    const res = await fetch("/api/state", { headers: authHeaders() });
    if (res.status === 401) {
      renderIfChanged(
        nodes.vitals,
        "vitals",
        chip(t("vitals.access"), esc(t("vitals.tokenNeeded")), "bad"),
      );
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render((await res.json()) as State);
  } catch {
    renderIfChanged(
      nodes.vitals,
      "vitals",
      chip(t("vitals.comfy"), t("vitals.unreachable"), "bad"),
    );
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

type ThemeMode = "light" | "dark" | "system";

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const themeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")];

function currentTheme(): ThemeMode {
  const mode = document.documentElement.dataset["theme"];
  return mode === "dark" || mode === "system" ? mode : "light";
}

function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle(
    "dark",
    mode === "dark" || (mode === "system" && prefersDark.matches),
  );
  document.documentElement.dataset["theme"] = mode;

  try {
    localStorage.setItem("theme", mode);
  } catch {
    // Private mode — the choice simply will not survive a reload.
  }

  for (const button of themeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset["themeChoice"] === mode));
  }
}

for (const button of themeButtons) {
  button.addEventListener("click", () => {
    applyTheme((button.dataset["themeChoice"] ?? "light") as ThemeMode);
  });
}

// Only follow the OS while the user has actually asked for "system".
prefersDark.addEventListener("change", () => {
  if (currentTheme() === "system") applyTheme("system");
});

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

// Built from the list rather than written into the markup, so a new language
// is one entry in `i18n.ts` and nothing else.
el("lang-toggle").innerHTML = LANGS.map(
  (entry) =>
    `<button type="button" data-lang-choice="${entry.code}" title="${entry.name}" aria-pressed="false">${entry.label}</button>`,
).join("");

const langButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-lang-choice]")];

for (const button of langButtons) {
  button.addEventListener("click", () => setLang(button.dataset["langChoice"] as Lang));
}

/**
 * Everything drawn from state has to be built again in the new language. The
 * cached markup is dropped first, or `renderIfChanged` would see no change and
 * leave the old words in place.
 */
onLangChange(() => {
  for (const button of langButtons) {
    button.setAttribute("aria-pressed", String(button.dataset["langChoice"] === lang()));
  }

  // Notes report something that has already happened, so they are cleared
  // rather than translated after the fact.
  for (const note of [
    nodes.note,
    nodes.uploadNote,
    nodes.settingsNote,
    nodes.serversNote,
    nodes.acceptNote,
  ]) {
    setNote(note, "");
  }

  lastHtml.clear();
  if (!latestState) return;
  readServerInputs();
  render(latestState);
  renderServers(latestState);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

nodes.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  nodes.submit.disabled = true;
  setNote(nodes.note, t("run.queueing"));

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: authHeaders(),
      body: new FormData(nodes.form),
    });
    const body = (await res.json()) as { jobId?: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setNote(nodes.note, t("run.queued"));
  } catch (err) {
    setNote(nodes.note, err instanceof Error ? err.message : String(err), true);
  } finally {
    nodes.submit.disabled = false;
    void poll();
  }
});

// The selector doubles as the active workflow, so upstream jobs follow it too.
nodes.select.addEventListener("change", async () => {
  const name = nodes.select.value;
  if (!name) return;
  await post("/api/workflows/active", { name });
  void poll();
});

nodes.reload.addEventListener("click", async () => {
  await post("/api/workflows/reload");
  selectKey = "";
  lastHtml.clear();
  setNote(nodes.uploadNote, t("upload.reloaded"));
  void poll();
});

nodes.interrupt.addEventListener("click", async () => {
  const result = await post("/api/interrupt");
  setNote(
    nodes.note,
    result.ok ? t("run.interruptSent") : (result.error ?? t("run.interruptFailed")),
    !result.ok,
  );
  void poll();
});

nodes.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = nodes.uploadFile.files?.[0];
  if (!file) {
    setNote(nodes.uploadNote, t("upload.pickFile"), true);
    return;
  }

  const form = new FormData();
  form.append("workflow", file);
  if (nodes.uploadName.value.trim()) form.append("name", nodes.uploadName.value.trim());

  setNote(nodes.uploadNote, t("upload.uploading"));
  try {
    const res = await fetch("/api/workflows/upload", {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    const body = (await res.json()) as { workflow?: WorkflowSummary; error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setNote(nodes.uploadNote, t("upload.saved", { name: body.workflow?.name ?? "" }));
    nodes.uploadForm.reset();
    lastHtml.delete("workflows");
  } catch (err) {
    setNote(nodes.uploadNote, err instanceof Error ? err.message : String(err), true);
  }
  void poll();
});

nodes.workflows.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;

  const activate = target.closest<HTMLElement>("[data-activate]")?.dataset["activate"];
  if (activate) {
    await post("/api/workflows/active", { name: activate });
    void poll();
    return;
  }

  const remove = target.closest<HTMLElement>("[data-remove-workflow]")?.dataset["removeWorkflow"];
  if (remove && confirm(t("workflows.deleteConfirm", { name: remove }))) {
    const result = await post("/api/workflows/delete", { name: remove });
    if (!result.ok) setNote(nodes.uploadNote, result.error ?? t("workflows.deleteFailed"), true);
    selectKey = "";
    lastHtml.delete("workflows");
    void poll();
  }
});

el("server-add").addEventListener("click", () => {
  readServerInputs();
  serverRows = [
    ...(serverRows ?? []),
    { id: "", name: "", url: "", hostId: "", enabled: true, hasSecret: false, secret: "" },
  ];
  serversDirty = true;
  if (latestState) renderServers(latestState);
});

nodes.servers.addEventListener("input", () => {
  serversDirty = true;
});

nodes.servers.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;

  const move = target.closest<HTMLElement>("[data-move]");
  if (move && serverRows) {
    readServerInputs();
    const from = Number(move.dataset["move"]);
    const to = from + Number(move.dataset["dir"]);
    if (to >= 0 && to < serverRows.length) {
      const [row] = serverRows.splice(from, 1);
      serverRows.splice(to, 0, row!);
      serversDirty = true;
      if (latestState) renderServers(latestState);
    }
    return;
  }

  const test = target.closest<HTMLElement>("[data-test-server]");
  if (test && serverRows) {
    readServerInputs();
    void testServer(Number(test.dataset["testServer"]));
    return;
  }

  const remove = target.closest<HTMLElement>("[data-remove-server]");
  if (remove && serverRows) {
    readServerInputs();
    serverRows.splice(Number(remove.dataset["removeServer"]), 1);
    serversDirty = true;
    if (latestState) renderServers(latestState);
  }
});

el("servers-save").addEventListener("click", async () => {
  readServerInputs();
  setNote(nodes.serversNote, t("servers.saving"));

  const result = await post("/api/upstreams", {
    upstreams: (serverRows ?? []).map((row) => ({
      id: row.id || undefined,
      name: row.name,
      url: row.url,
      hostId: row.hostId,
      // Blank means "keep the stored one"; the UI never receives secrets.
      secret: row.secret,
      enabled: row.enabled,
    })),
  });

  if (!result.ok) {
    setNote(nodes.serversNote, result.error ?? t("servers.saveFailed"), true);
    return;
  }
  serversDirty = false;
  setNote(nodes.serversNote, t("servers.saved"));
  void poll();
});

el("servers-revert").addEventListener("click", () => {
  serversDirty = false;
  setNote(nodes.serversNote, "");
  if (latestState) syncServers(latestState);
});

el("jobs-clear").addEventListener("click", async () => {
  if (!confirm(t("jobs.clearConfirm"))) return;
  await post("/api/jobs/clear");
  lastHtml.delete("jobs");
  void poll();
});

nodes.jobs.addEventListener("click", async (event) => {
  const id = (event.target as HTMLElement).closest<HTMLElement>("[data-remove-job]")?.dataset[
    "removeJob"
  ];
  if (!id) return;
  await post("/api/jobs/delete", { id });
  lastHtml.delete("jobs");
  void poll();
});

nodes.settingsForm.addEventListener("input", () => {
  settingsDirty = true;
});

nodes.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setNote(nodes.settingsNote, t("comfy.saving"));

  const result = await post("/api/settings", {
    comfyDir: nodes.comfyDir.value,
    comfyCommand: nodes.comfyCommand.value,
  });

  if (!result.ok) {
    setNote(nodes.settingsNote, result.error ?? t("comfy.saveFailed"), true);
    return;
  }
  settingsDirty = false;
  setNote(nodes.settingsNote, t("comfy.saved"));
  void poll();
});

async function toggleComfy(): Promise<void> {
  const managed = latestState?.comfyProcess.managed ?? false;
  nodes.comfyPower.disabled = true;
  nodes.comfyPower2.disabled = true;

  const result = await post(managed ? "/api/comfy/stop" : "/api/comfy/start");
  if (!result.ok) setNote(nodes.settingsNote, result.error ?? t("process.failed"), true);
  await poll();
}

nodes.comfyPower.addEventListener("click", () => void toggleComfy());
nodes.comfyPower2.addEventListener("click", () => void toggleComfy());

nodes.desktopOpen.addEventListener("click", () => toggle(DESKTOP_POPOVER));
nodes.modeOpen.addEventListener("click", () => toggle(MODE_POPOVER));

// Anywhere outside closes them, which is what a menu is expected to do.
document.addEventListener("click", (event) => {
  const target = event.target as Node;
  const inside = POPOVERS.some(
    (popover) => popover.panel.contains(target) || popover.button.contains(target),
  );
  if (!inside) openPopover(null);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") openPopover(null);
});

nodes.modePanel.addEventListener("click", async (event) => {
  const mode = (event.target as HTMLElement).closest<HTMLElement>("[data-mode]")?.dataset["mode"];
  if (!mode) return;

  // The only one that destroys work: it shuts ComfyUI down, so a generation in
  // flight dies with it. The other two are free to undo, and are not asked
  // about. The panel stays open on a refusal, so nothing looks like it happened.
  if (mode === "paused") {
    if (!confirm(t("mode.stopConfirm"))) return;
    // The request waits for ComfyUI to actually be gone, which is not instant.
    setNote(nodes.modeNote, t("mode.stopping"));
  }

  const result = await post("/api/mode", { mode });
  if (!result.ok) {
    setNote(nodes.modeNote, result.error ?? t("mode.saveFailed"), true);
    return;
  }
  openPopover(null);
  void poll();
});

nodes.desktopAutostart.addEventListener("change", () => {
  void saveDesktop("/api/desktop", { autostart: nodes.desktopAutostart.checked });
});

nodes.desktopPanel.addEventListener("click", (event) => {
  const choice = (event.target as HTMLElement).closest<HTMLElement>("[data-close-action]")?.dataset[
    "closeAction"
  ];
  if (choice) void saveDesktop("/api/desktop", { closeAction: choice });
});

nodes.acceptPause.addEventListener("click", (event) => {
  const minutes = (event.target as HTMLElement).closest<HTMLElement>("[data-pause]")?.dataset[
    "pause"
  ];
  if (minutes === undefined) return;
  void saveAccepting("/api/accept/pause", { minutes: Number(minutes) });
});

nodes.acceptEnabled.addEventListener("change", () => {
  void saveAccepting("/api/accept/schedule", { enabled: nodes.acceptEnabled.checked });
});

// Both go together: a window is the pair, and sending one of them alone would
// save a half-edited window on the way to the other field.
for (const input of [nodes.acceptFrom, nodes.acceptTo]) {
  input.addEventListener("change", () => {
    void saveAccepting("/api/accept/schedule", {
      from: nodes.acceptFrom.value,
      to: nodes.acceptTo.value,
    });
  });
}

// Ticking elapsed time for running jobs, kept out of the render pass so it
// never rewrites the job list.
setInterval(() => {
  for (const span of document.querySelectorAll<HTMLElement>("[data-started]")) {
    const started = Number(span.dataset["started"]);
    if (Number.isFinite(started)) span.textContent = formatDuration(Date.now() - started);
  }
}, 1000);

applyTheme(currentTheme());
setLang(lang());
showPage();
void poll();
setInterval(() => void poll(), POLL_MS);
