/**
 * Recent jobs, newest first.
 *
 * The upstream server still owns job durability — this is the local record of
 * what this machine did, kept so the history survives a restart and can be
 * cleared from the UI. Writes are debounced because a running job updates its
 * row every time it changes state.
 */

import { readFile, writeFile } from "node:fs/promises";
import { JOBS_FILE } from "./config";
import type { JobRecord, JobSource, RunOutput } from "./types";

const MAX_JOBS = 200;
const WRITE_DELAY_MS = 500;

let jobs: JobRecord[] = [];
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadJobs(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(JOBS_FILE, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return;

    // A job that was running when the process died is not running now.
    jobs = (parsed as JobRecord[]).map((job) =>
      job.state === "running"
        ? {
            ...job,
            state: "failed",
            // Both: the file stays readable on its own, the UI translates.
            interrupted: true,
            error: "interrupted by a restart",
            finishedAt: Date.now(),
          }
        : job,
    );
  } catch {
    jobs = [];
  }
}

function persist(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeFile(JOBS_FILE, `${JSON.stringify(jobs, null, 2)}\n`).catch((err: unknown) => {
      console.error(
        "[jobs] could not write the history:",
        err instanceof Error ? err.message : err,
      );
    });
  }, WRITE_DELAY_MS);
}

export function startJob(input: {
  id: string;
  source: JobSource;
  workflow: string;
  origin?: string;
}): JobRecord {
  const job: JobRecord = { ...input, state: "running", startedAt: Date.now() };
  jobs.unshift(job);
  if (jobs.length > MAX_JOBS) jobs.length = MAX_JOBS;
  persist();
  return job;
}

export function markQueued(job: JobRecord, promptId: string): void {
  job.promptId = promptId;
  persist();
}

export function completeJob(job: JobRecord, outputs: RunOutput[]): void {
  job.state = "succeeded";
  job.outputs = outputs;
  job.finishedAt = Date.now();
  persist();
}

export function failJob(job: JobRecord, error: string): void {
  job.state = "failed";
  job.error = error;
  job.finishedAt = Date.now();
  persist();
}

export function listJobs(): JobRecord[] {
  return jobs;
}

export function runningJob(): JobRecord | undefined {
  return jobs.find((job) => job.state === "running");
}

/** Returns false when the id is unknown, so the caller can answer 404. */
export function removeJob(id: string): boolean {
  const index = jobs.findIndex((job) => job.id === id);
  if (index === -1) return false;
  jobs.splice(index, 1);
  persist();
  return true;
}

/** Clears finished jobs. A job still running is left alone. */
export function clearFinishedJobs(): number {
  const before = jobs.length;
  jobs = jobs.filter((job) => job.state === "running");
  persist();
  return before - jobs.length;
}
