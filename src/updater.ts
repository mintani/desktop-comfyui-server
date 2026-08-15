/**
 * Self-update helpers. Only the *check* happens here, as a read-only
 * `git fetch`; the `git pull` that touches the working tree is left to the
 * launcher script after the process exits, so it can never run while a job is
 * in flight. On finding an update the agent exits with {@link RESTART_EXIT_CODE}
 * and the launcher pulls and relaunches.
 */

/** Exit code the launcher watches for to pull and restart. */
export const RESTART_EXIT_CODE = 42;

/**
 * Run git with a hard timeout. `GIT_TERMINAL_PROMPT=0` makes it fail fast
 * rather than block on a credential prompt, which would stall the poll loop.
 */
async function git(args: string[], timeoutMs = 30_000): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const exit = await proc.exited;
    if (exit !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      throw new Error(`git ${args.join(" ")} failed (exit ${exit}): ${stderr}`);
    }
    return (await new Response(proc.stdout).text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when the tracked upstream branch has commits the checkout lacks. Throws
 * when git is unavailable, offline, or no upstream is configured; callers
 * should treat a throw as "no update" and keep running.
 */
export async function remoteHasUpdate(): Promise<boolean> {
  await git(["fetch", "--quiet"]);
  const local = await git(["rev-parse", "HEAD"]);
  const upstream = await git(["rev-parse", "@{u}"]);
  return Boolean(local && upstream && local !== upstream);
}
