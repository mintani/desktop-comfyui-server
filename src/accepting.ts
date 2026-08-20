/**
 * When this machine takes work from a job server.
 *
 * The run mode is a decision someone made, so nothing here changes it. A
 * schedule or a pause is a gate in front of claiming instead: the mode still
 * says "accepting", and this says whether right now counts. Keeping the two
 * apart is what lets the tray go on showing what was chosen while the machine
 * quietly stops and starts claiming on its own.
 *
 * Local runs and ComfyUI itself are untouched by any of it. The point is to
 * lend the GPU out on a timetable, not to stop being able to use it.
 */

import type { AcceptSchedule, Settings } from "./settings";

/** The furthest ahead a pause may be set, so a slip cannot lend nothing for a week. */
export const MAX_PAUSE_MINUTES = 24 * 60;

const MINUTE_MS = 60_000;

/** Why nothing is being claimed, or `null` when it is. */
export type AcceptBlock =
  /** The mode is not `accepting`. */
  | "mode"
  /** Paused for a while, and the while is not up. */
  | "paused"
  /** Outside the daily window. */
  | "schedule";

export type AcceptState = {
  accepting: boolean;
  blockedBy: AcceptBlock | null;
  /** When the pause runs out, or `null` when not paused. */
  pausedUntil: number | null;
  schedule: AcceptSchedule;
};

/** True for a `HH:MM` a day actually contains. */
export function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && minutesOfDay(value) !== null;
}

/** `HH:MM` as minutes since midnight, or `null` when it is not one. */
function minutesOfDay(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Whether `now` falls inside the daily window, in this machine's own time zone
 * — the window is written by whoever sits at it.
 *
 * A window whose end is before its start crosses midnight, which is the usual
 * shape of "while I am asleep", so it is read that way rather than refused. Two
 * equal ends would describe an empty day; the only useful reading is all of it.
 */
export function withinSchedule(schedule: AcceptSchedule, now: Date): boolean {
  if (!schedule.enabled) return true;

  const from = minutesOfDay(schedule.from);
  const to = minutesOfDay(schedule.to);
  // A window that cannot be read is not a reason to stop working.
  if (from === null || to === null || from === to) return true;

  const current = now.getHours() * 60 + now.getMinutes();
  return from < to ? current >= from && current < to : current >= from || current < to;
}

/** What the agent, the API and the header all read to decide the same thing. */
export function acceptState(settings: Settings, now = Date.now()): AcceptState {
  const pausedUntil =
    settings.pauseUntil !== null && settings.pauseUntil > now ? settings.pauseUntil : null;

  const blockedBy: AcceptBlock | null =
    settings.mode !== "accepting"
      ? "mode"
      : pausedUntil !== null
        ? "paused"
        : withinSchedule(settings.schedule, new Date(now))
          ? null
          : "schedule";

  return { accepting: blockedBy === null, blockedBy, pausedUntil, schedule: settings.schedule };
}

/**
 * The timestamp a pause of `minutes` ends at, or `null` for no pause. Stored
 * rather than counted down in memory, so a restart in the middle of a pause
 * does not resume claiming early.
 */
export function pauseUntil(minutes: number, now = Date.now()): number | null {
  return minutes > 0 ? now + minutes * MINUTE_MS : null;
}
