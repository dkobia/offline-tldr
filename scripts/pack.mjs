// Packs a store-ready zip for one browser target: node scripts/pack.mjs <chrome|firefox>
//
// Runs the build, then zips dist/<target> with manifest.json at the zip root,
// excluding sourcemaps. Output: dist/offline-tldr-<target>-<version>.zip

import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (target !== "chrome" && target !== "firefox") {
  console.error("usage: node scripts/pack.mjs <chrome|firefox>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist", target);

run(process.execPath, [path.join(root, "scripts", "build.mjs"), target]);

const manifest = JSON.parse(await readFile(path.join(outdir, "manifest.json"), "utf8"));
const zipPath = path.join(root, "dist", `offline-tldr-${target}-${manifest.version}.zip`);

await rm(zipPath, { force: true });
run("zip", ["-r", zipPath, ".", "-x", "*.map"], { cwd: outdir });

console.log(`packed ${path.relative(root, zipPath)}`);

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
