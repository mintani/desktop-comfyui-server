/**
 * Write one version everywhere it lives: package.json, tauri.conf.json and
 * Cargo.toml. The release workflow refuses to build when the three disagree,
 * so they are only ever changed together, here.
 *
 *   bun run bump 0.2.0
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: bun run bump <major.minor.patch>   e.g. bun run bump 0.2.0");
  process.exit(1);
}

/** Targeted replace, not JSON.parse/stringify — the file keeps its own shape. */
async function bump(path: string, pattern: RegExp, replacement: string): Promise<void> {
  const file = join(ROOT, path);
  const text = await Bun.file(file).text();
  const next = text.replace(pattern, replacement);
  if (next === text) {
    console.error(`no version found in ${path}`);
    process.exit(1);
  }
  await Bun.write(file, next);
  console.log(`${path} → ${version}`);
}

await bump("package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
await bump("src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
await bump("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${version}"`);
