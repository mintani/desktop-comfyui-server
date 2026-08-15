/**
 * Build the server into the single file the desktop app ships beside itself.
 *
 * Tauri finds a sidecar by name plus the target triple — `comfyui-server-
 * x86_64-unknown-linux-gnu` — so the triple has to be in the filename, and
 * `rustc -vV` is where it comes from. Anyone building the app has rustc.
 *
 * The result carries the Bun runtime, so it is about 100 MB. That is the cost
 * of the app being the same server as `bun run start` rather than a second
 * implementation of it.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);
const OUT_DIR = join(ROOT, "src-tauri", "binaries");

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr.trim() || `exit ${code}`}`);
  return stdout;
}

async function targetTriple(): Promise<string> {
  let report: string;
  try {
    report = await run(["rustc", "-vV"]);
  } catch (err) {
    throw new Error(
      "rustc is needed to name the sidecar for the platform it runs on. Install Rust from https://rustup.rs.",
      { cause: err },
    );
  }

  const host = /^host:\s*(\S+)$/m.exec(report)?.[1];
  if (!host) throw new Error("`rustc -vV` printed no host triple");
  return host;
}

const triple = await targetTriple();
const name = `comfyui-server-${triple}${triple.includes("windows") ? ".exe" : ""}`;

await mkdir(OUT_DIR, { recursive: true });
await run([
  "bun",
  "build",
  "--compile",
  join(ROOT, "src", "index.ts"),
  "--outfile",
  join(OUT_DIR, name),
]);

console.log(`[sidecar] ${join("src-tauri", "binaries", name)}`);
