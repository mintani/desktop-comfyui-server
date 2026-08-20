/**
 * Things worth telling a person about, kept as a small ring the UI reads from
 * `/api/state` and turns into OS notifications.
 *
 * The server records facts — kind and parameters — and whoever displays them
 * writes the sentence, in the reader's language. Ids are time-based so a
 * watcher's "seen up to here" survives this process restarting; the ring is
 * short because anything older is history, and history is what the log and the
 * Runs page are for.
 */

export type UiEventKind =
  | "job-failed"
  | "upstream-down"
  | "upstream-up"
  | "comfy-crashed"
  | "comfy-gave-up";

export type UiEvent = {
  id: number;
  at: number;
  kind: UiEventKind;
  /** What the event is about — workflow, server name, error — for the message. */
  params: Record<string, string>;
};

const MAX_EVENTS = 20;

const events: UiEvent[] = [];
let nextId = 0;

export function pushEvent(kind: UiEventKind, params: Record<string, string> = {}): void {
  // Monotonic and larger than any id a previous run handed out.
  nextId = Math.max(nextId + 1, Date.now());
  events.push({ id: nextId, at: Date.now(), kind, params });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function listEvents(): UiEvent[] {
  return events;
}
