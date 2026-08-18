/**
 * How far along the run in flight is, read from ComfyUI's WebSocket.
 *
 * Over HTTP there are two facts and nothing between them: a prompt was queued,
 * and later it was done. A run that takes minutes therefore looks the same at
 * 5% as at 95%, which is the difference between slow and stuck. ComfyUI does
 * say — over `/ws`, addressed to the client id the prompt was queued with — so
 * prompts go out carrying {@link CLIENT_ID} and this listens as that client.
 *
 * All of it is best effort. A socket that drops takes no run with it: the prompt
 * belongs to ComfyUI by then, and the only loss is hearing about steps until the
 * reconnect lands.
 */

import { COMFY_URL } from "./config";

/** This process, to ComfyUI: on the prompt body and on the socket alike. */
export const CLIENT_ID = crypto.randomUUID();

const RECONNECT_MS = 5000;

/**
 * Progress this old is not progress. ComfyUI says when a run ends, but a socket
 * that died mid-run says nothing at all, and a bar frozen at 60% is worse than
 * no bar.
 */
const STALE_MS = 60_000;

export type RunProgress = {
  /** Empty when ComfyUI did not name one; the UI then shows no bar. */
  promptId: string;
  /** Steps done and steps expected, as ComfyUI counts them. */
  value: number;
  max: number;
  /** The node being executed, when a message named it. */
  node: string | null;
  at: number;
};

let latest: RunProgress | null = null;
let socket: WebSocket | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let watching = false;

export function latestProgress(): RunProgress | null {
  if (latest && Date.now() - latest.at > STALE_MS) latest = null;
  return latest;
}

type Message = {
  type?: string;
  data?: {
    value?: number;
    max?: number;
    node?: string | null;
    prompt_id?: string;
  };
};

/** Unknown message types are ignored: ComfyUI sends plenty this does not need. */
function handle(raw: string): void {
  let message: Message;
  try {
    message = JSON.parse(raw) as Message;
  } catch {
    return;
  }
  const data = message.data ?? {};

  switch (message.type) {
    case "progress": {
      if (typeof data.value !== "number" || typeof data.max !== "number") return;
      latest = {
        promptId: data.prompt_id ?? latest?.promptId ?? "",
        value: data.value,
        max: data.max,
        node: data.node ?? null,
        at: Date.now(),
      };
      return;
    }

    // A node started, or — with no node — the queue went quiet. The step count
    // belonged to the node that just ended either way, so it is dropped.
    case "executing": {
      if (data.node === null || data.node === undefined) latest = null;
      else if (latest) latest = { ...latest, node: data.node, at: Date.now() };
      return;
    }

    case "execution_success":
    case "execution_error":
    case "execution_interrupted":
      latest = null;
      return;

    default:
      return;
  }
}

function connect(): void {
  if (!watching) return;

  const retry = (): void => {
    socket = null;
    latest = null;
    // ComfyUI being down is the normal case here rather than an error, so this
    // says nothing and simply comes back. `timer` also makes the pair of events
    // a failed connect fires — error, then close — schedule one attempt.
    if (!watching || timer) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, RECONNECT_MS);
  };

  try {
    socket = new WebSocket(`${COMFY_URL.replace(/^http/, "ws")}/ws?clientId=${CLIENT_ID}`);
  } catch {
    retry();
    return;
  }

  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") handle(event.data);
  });
  socket.addEventListener("close", retry);
  socket.addEventListener("error", retry);
}

export function startProgressWatch(): void {
  if (watching) return;
  watching = true;
  connect();
}

export function stopProgressWatch(): void {
  watching = false;
  if (timer) clearTimeout(timer);
  timer = null;
  socket?.close();
  socket = null;
  latest = null;
}
