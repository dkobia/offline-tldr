# AGENTS.md

## What Offline TL;DR is

Offline TL;DR is a browser extension that extracts, condenses, and synthesizes web page content entirely on the user's machine.
Summarization runs against an on-device model: the browser's built-in model on Chrome (Gemini Nano, through the Prompt API), or a local inference runtime - Ollama, LM Studio, llama.cpp server, and other localhost endpoints.
No page content, no browsing context, and no telemetry ever leaves the device.

Naming: "Offline TL;DR" in prose and UI, `offline-tldr` everywhere else (repo, packages, filenames).
Never mix forms.

## Layout

```
packages/
  core/            # pure logic, no browser APIs; extraction, chunking, engine contract
  extension/
    platform/      # the only files that differ per browser, behind the Platform interface (storage, tabs, the built-in model)
    background/    # engine configuration, summarization request routing
    content/       # thin: hands the page Document to core's extractor
    panel/         # summary view + settings (sidepanel on Chrome, popup on Firefox)
  shared/          # protocol types only (type-only import of core)
manifests/         # base.json + chrome.json / firefox.json overlays, merged at build
fixtures/          # static HTML pages core is unit-tested against
scripts/           # esbuild build (scripts/build.mjs <chrome|firefox>)
```

## Commands

```sh
pnpm install
pnpm build            # dist/chrome + dist/firefox
pnpm build:chrome     # or build:firefox
pnpm test
pnpm typecheck
```

Load `dist/chrome` via chrome://extensions (Load unpacked) and `dist/firefox` via about:debugging (Load Temporary Add-on).

## Releasing

- Bump `version` in `manifests/base.json` and the three `packages/*/package.json` files in its own small PR, merge it, then create a GitHub Release on that commit with a matching tag (`v0.2.0`) and release notes.
  The Publish workflow (`.github/workflows/publish.yml`) runs typecheck, tests, and the build first and checks the release tag against the manifest; only when that verify job passes does it pack `dist/chrome` and publish it to the Chrome Web Store with `wdzeng/chrome-extension`.
  Feature PRs do not bump the version; merging to `main` never publishes.
- Running the workflow by hand defaults to upload-only, which stages a draft in the developer dashboard without publishing.
- Store credentials live only as GitHub Actions secrets (`PUBLISHER_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`); never commit them.
- Firefox is not yet listed; `pnpm build:firefox` produces the loadable `dist/firefox`.

## Invariants

- `packages/core` is pure logic. Standard DOM types (`Document`, `Element`) are fine; `chrome.*` / `browser.*` and network calls never.
  This keeps core testable against static HTML fixtures without a browser.
- Browser-specific code lives only in `packages/extension/platform/`, behind the `Platform` interface.
  The build aliases `@platform` to the right implementation per target.
  That includes the browser's built-in model: Chrome's Prompt API (`LanguageModel`, typed in `platform/language-model.d.ts`) is wrapped by `platform/built-in-model.ts` as `Platform.builtInModel`, and Firefox has none.
  The engine client (`background/engines/built-in.ts`) and the panel's download button reach the model only through that seam.
- All inference is local. No code path may send page content, prompts, or metadata to a remote host.
  Engine endpoints are localhost only; adding a permission or host beyond that needs explicit justification.
  The browser's built-in model runs inside the browser and needs no permission and no endpoint; the one network activity is Chrome's own download of the model, which the extension never starts silently: the panel offers it, the user clicks, and the background uses only a model that is already there.
- Zero telemetry. No analytics, no error reporting services, no update pings beyond what browser stores do themselves.
- Engines implement the `SummarizationEngine` contract defined in core; the extension owns the concrete clients (two HTTP clients and the built-in model's).
  The built-in model is the default where the browser has one (`defaultSettings` in `lib/settings.ts`), so a fresh install summarizes without installing anything; a saved engine choice is never overridden.
  It needs no model name and no endpoint; `isServerEngine` is the one rule for which settings apply.
  Its context is small, and it does not think: `EngineClient.reasoning` tells the budget whether to reserve thinking headroom, so the built-in model gets the page its window can hold.
- Manifest changes go in `manifests/base.json` unless genuinely browser-specific.

## Testing

- Vitest: `pnpm test` (or `pnpm test:watch`). Tests are colocated as `*.test.ts` next to the code they cover.
- Core is tested against `fixtures/*.html` parsed with linkedom - no browser required.
  New extraction behavior needs a fixture plus a test asserting the expected output.
- Behavior changes require new or updated tests.
- Exercise per-browser code through the `Platform` interface; don't mock `chrome.*` / `browser.*` inline.

## Style

- TypeScript strict mode, ESM throughout. Match the surrounding code's conventions.
- Keep dependencies minimal; justify any new one.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm build` before committing.
