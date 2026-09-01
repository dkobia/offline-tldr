// Builds the extension for one browser target: node scripts/build.mjs <chrome|firefox>
//
// - Bundles background, content, and panel entry points with esbuild.
// - Aliases "@platform" to the target's platform implementation, so only
//   packages/extension/platform/ differs between browsers.
// - Merges manifests/base.json with manifests/<target>.json into the output.

import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (target !== "chrome" && target !== "firefox") {
  console.error("usage: node scripts/build.mjs <chrome|firefox>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "packages", "extension");
const outdir = path.join(root, "dist", target);

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    background: path.join(ext, "background", "index.ts"),
    content: path.join(ext, "content", "index.ts"),
    panel: path.join(ext, "panel", "main.ts"),
  },
  outdir,
  bundle: true,
  format: "esm",
  target: ["chrome120", "firefox121"],
  sourcemap: true,
  alias: {
    "@platform": path.join(ext, "platform", `${target}.ts`),
  },
});

// Stamp the platform class at build time so per-target CSS (e.g. the Firefox
// popup's fixed size) applies at parse time, before Firefox's one-shot popup
// measurement - a deferred module script adds the class too late.
const panelHtml = await readFile(path.join(ext, "panel", "index.html"), "utf8");
await writeFile(
  path.join(outdir, "panel.html"),
  panelHtml.replace('<html lang="en">', `<html lang="en" class="platform-${target}">`),
);
await cp(path.join(ext, "panel", "panel.css"), path.join(outdir, "panel.css"));
await cp(path.join(ext, "panel", "fonts"), path.join(outdir, "fonts"), { recursive: true });
await cp(path.join(root, "images", "icons"), path.join(outdir, "icons"), { recursive: true });

const base = JSON.parse(await readFile(path.join(root, "manifests", "base.json"), "utf8"));
const overlay = JSON.parse(await readFile(path.join(root, "manifests", `${target}.json`), "utf8"));
const manifest = merge(base, overlay);
await writeFile(path.join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`built ${target} -> ${path.relative(root, outdir)}`);

function merge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object") {
    return b;
  }
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = key in a ? merge(a[key], value) : value;
  }
  return out;
}
