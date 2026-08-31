// Background orchestration: engine configuration, summarization routing, and
// the per-tab summary store. The background owns each tab's summary state
// (issue #7); the panel is a view over the active tab's entry, watching it
// through the summarize port. Parameterized over Platform and the engine
// factory so it is testable with fakes; the entry point (index.ts) wires in
// the real implementations.
//
// MV3 constraint honored by startBackground: no top-level await, and all
// listeners are registered synchronously when it is called at load. The store
// is mirrored to storage.session so a service-worker restart keeps finished
// summaries; handlers that touch it await the restore first.

import type { Platform, PlatformPort } from "../platform/types";
import { DEFAULT_INPUT_CHAR_BUDGET, fitToBudget, pageKey } from "@offline-tldr/core";
import {
  SUMMARIZE_PORT,
  type BackgroundRequest,
  type ExtractArticleResponse,
  type GetActivePageResponse,
  type GetPageUrlResponse,
  type GetSettingsResponse,
  type GetTabStateResponse,
  type ProbeEngineResponse,
  type Settings,
  type SummarizeCommand,
  type SummarizeErrorCode,
  type SummarizeEvent,
  type SummarizePortEvent,
  type TabSummaryState,
} from "@offline-tldr/shared";
import { normalizeSettings } from "../lib/settings";
import { EngineError, type EngineClient } from "./engines";

const SETTINGS_KEY = "settings";
const TAB_STATE_KEY = "tab-state";
/** Streaming chunks arrive fast; batch their session-storage writes. */
const PERSIST_THROTTLE_MS = 300;

/** Page identity for invalidation; raw URL for the rare non-http(s) page (file://). */
function urlKey(url: string): string {
  return pageKey(url) ?? url;
}

export interface BackgroundDeps {
  platform: Platform;
  createEngine: (settings: Settings) => EngineClient;
}

export function startBackground({ platform, createEngine }: BackgroundDeps): void {
  platform.initPanelBehavior();

  const tabStates = new Map<number, TabSummaryState>();
  /** Ports watching a tab's run events; a port watches at most one tab. */
  const watchers = new Map<PlatformPort, number>();
  /** The one in-flight run; local engines are resource-hungry, so starting a run supersedes any other. */
  let activeRun: { tabId: number; abort: AbortController } | null = null;
  const ready = restore();

  platform.onTabRemoved((tabId) => {
    void ready.then(() => dropTabState(tabId));
  });

  platform.onMessage((message) => {
    const request = message as BackgroundRequest;
    switch (request?.type) {
      case "get-settings":
        return loadSettings().then((settings): GetSettingsResponse => ({ settings }));
      case "save-settings": {
        const settings = normalizeSettings(request.settings);
        return platform.setSetting(SETTINGS_KEY, settings).then((): GetSettingsResponse => ({ settings }));
      }
      case "probe-engine":
        return probeEngine(normalizeSettings(request.settings));
      case "get-active-page":
        return getActivePage();
      case "get-tab-state":
        return readTabState(request.tabId, request.url).then((state): GetTabStateResponse => ({ state }));
      default:
        return undefined;
    }
  });

  platform.onConnect((port) => {
    if (port.name !== SUMMARIZE_PORT) {
      return;
    }
    port.onDisconnect(() => watchers.delete(port));
    port.onMessage((message) => {
      const command = message as SummarizeCommand;
      switch (command?.type) {
        case "watch":
          void handleWatch(port, command);
          break;
        case "start":
          void startRun(command.tabId, command.auto);
          break;
        case "cancel":
          void ready.then(() => {
            if (activeRun?.tabId === command.tabId) {
              stopActiveRun();
            }
          });
          break;
      }
    });
  });

  // ---- Per-tab summary store --------------------------------------------------------

  async function restore(): Promise<void> {
    const stored = await platform.getSessionValue<Record<string, TabSummaryState>>(TAB_STATE_KEY, {});
    for (const [tabId, state] of Object.entries(stored)) {
      // A run does not survive a background restart; only finished entries return.
      if (state.status.kind !== "running") {
        tabStates.set(Number(tabId), state);
      }
    }
  }

  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let persistChain: Promise<void> = Promise.resolve();

  function persistNow(): void {
    clearTimeout(persistTimer);
    persistTimer = undefined;
    const snapshot = Object.fromEntries([...tabStates].map(([tabId, state]) => [String(tabId), state]));
    // Chained so a slow earlier write can never land after a newer snapshot;
    // the restore path trusts the last write.
    persistChain = persistChain.then(() => platform.setSessionValue(TAB_STATE_KEY, snapshot)).catch(() => {});
  }

  function persistSoon(): void {
    persistTimer ??= setTimeout(persistNow, PERSIST_THROTTLE_MS);
  }

  /**
   * The tab's stored state, validated against the page the tab currently
   * shows: a mismatch means the tab navigated, so the entry (and its run) is
   * stale and dropped. Without a caller-supplied URL the tab is asked; when
   * even that fails the page is unreadable right now (browser-internal,
   * mid-load), so nothing is shown but the entry is kept.
   */
  async function readTabState(tabId: number, url?: string): Promise<TabSummaryState | null> {
    await ready;
    const state = tabStates.get(tabId);
    if (!state) {
      return null;
    }
    let currentUrl = url;
    if (currentUrl === undefined) {
      try {
        currentUrl = ((await askTab(tabId, { type: "get-page-url" })) as GetPageUrlResponse).url;
      } catch {
        return null;
      }
    }
    if (urlKey(currentUrl) !== urlKey(state.url)) {
      dropTabState(tabId);
      return null;
    }
    return state;
  }

  function dropTabState(tabId: number): void {
    if (activeRun?.tabId === tabId) {
      activeRun.abort.abort();
      activeRun = null;
    }
    if (tabStates.delete(tabId)) {
      persistNow();
    }
  }

  /** Aborts the in-flight run and forgets its unfinished entry, so revisiting that tab can run again. */
  function stopActiveRun(): void {
    if (!activeRun) {
      return;
    }
    activeRun.abort.abort();
    if (tabStates.get(activeRun.tabId)?.status.kind === "running") {
      tabStates.delete(activeRun.tabId);
      persistNow();
    }
    activeRun = null;
  }

  function broadcast(tabId: number, event: SummarizeEvent): void {
    const message: SummarizePortEvent = { type: "tab-event", tabId, event };
    for (const [port, watched] of watchers) {
      if (watched !== tabId) {
        continue;
      }
      try {
        port.postMessage(message);
      } catch {
        watchers.delete(port);
      }
    }
  }

  async function handleWatch(port: PlatformPort, { tabId, url, watchId }: Extract<SummarizeCommand, { type: "watch" }>): Promise<void> {
    // Subscribe before the (possibly slow) read; the panel ignores run events
    // until the snapshot arrives, and the snapshot folds them in.
    watchers.set(port, tabId);
    const state = await readTabState(tabId, url);
    const message: SummarizePortEvent = { type: "tab-state", watchId, tabId, state };
    try {
      port.postMessage(message);
    } catch {
      watchers.delete(port);
    }
  }

  // ---- Settings and probing ---------------------------------------------------------

  async function loadSettings(): Promise<Settings> {
    return normalizeSettings(await platform.getSetting<unknown>(SETTINGS_KEY, undefined));
  }

  async function probeEngine(settings: Settings): Promise<ProbeEngineResponse> {
    try {
      return { status: await createEngine(settings).probe() };
    } catch (error) {
      return { status: { state: "error", detail: String(error) } };
    }
  }

  /**
   * Asks the tab's content script something. When the tab predates the
   * extension's install or reload it has no content script yet (declared
   * scripts only reach pages loaded afterwards), so inject it and retry once.
   */
  async function askTab(tabId: number, message: unknown): Promise<unknown> {
    try {
      return await platform.sendTabMessage(tabId, message);
    } catch {
      await platform.injectContentScript(tabId);
      return platform.sendTabMessage(tabId, message);
    }
  }

  async function extractFromTab(tabId: number): Promise<ExtractArticleResponse> {
    return (await askTab(tabId, { type: "extract-article" })) as ExtractArticleResponse;
  }

  /**
   * The active tab plus its URL as its content script sees it. Null when the
   * content script is unreachable even after injection (browser-internal
   * pages, tabs the extension has no access to) - callers treat that as "not
   * a summarizable page".
   */
  async function getActivePage(): Promise<GetActivePageResponse> {
    const tab = await platform.getActiveTab();
    if (!tab) {
      return { page: null };
    }
    try {
      const { url } = (await askTab(tab.id, { type: "get-page-url" })) as GetPageUrlResponse;
      return { page: { tabId: tab.id, url, complete: tab.complete } };
    } catch {
      return { page: null };
    }
  }

  // ---- Summarize runs ---------------------------------------------------------------

  async function startRun(tabId: number, auto: boolean): Promise<void> {
    await ready;
    stopActiveRun();
    const abort = new AbortController();
    const run = { tabId, abort };
    activeRun = run;
    try {
      await runSummarize(tabId, auto, abort.signal);
    } finally {
      if (activeRun === run) {
        activeRun = null;
      }
      persistNow();
    }
  }

  async function runSummarize(tabId: number, auto: boolean, signal: AbortSignal): Promise<void> {
    let state: TabSummaryState | null = null;

    const post = (event: SummarizeEvent) => {
      if (!signal.aborted) {
        broadcast(tabId, event);
      }
    };
    /** Mutates the tab's entry; a no-op once aborted (a superseding run may own the slot now). */
    const write = (mutate: (state: TabSummaryState) => void, { urgent = true } = {}) => {
      if (signal.aborted || !state) {
        return;
      }
      mutate(state);
      if (urgent) {
        persistNow();
      } else {
        persistSoon();
      }
    };
    const fail = (code: SummarizeErrorCode, message: string) => {
      // Stored (when the page is known) so auto mode does not retry-loop it.
      write((entry) => {
        entry.status = { kind: "error", code, message };
      });
      post({ type: "error", code, message });
    };

    try {
      const settings = await loadSettings();

      let url: string;
      try {
        url = ((await askTab(tabId, { type: "get-page-url" })) as GetPageUrlResponse).url;
      } catch {
        // No page to key an entry on; the error only reaches watching panels.
        post({ type: "error", code: "page-unsupported", message: "This page cannot be read." });
        return;
      }
      if (signal.aborted) {
        return;
      }
      // The entry replaces any previous state for the tab BEFORE "extracting"
      // is broadcast: a watcher attaching mid-run must never see an old
      // snapshot without the reset event that follows it, or it would append
      // the new run's chunks to the old summary.
      state = { url, status: { kind: "running", phase: "extracting" }, title: "", truncated: false, markdown: "", auto };
      tabStates.set(tabId, state);
      persistNow();
      post({ type: "phase", phase: "extracting", auto });

      let extracted: ExtractArticleResponse;
      try {
        extracted = await extractFromTab(tabId);
      } catch {
        fail("page-unsupported", "This page cannot be read.");
        return;
      }
      if (!extracted?.ok) {
        fail("no-content", "No readable article text found on this page.");
        return;
      }

      const article = extracted.article;
      const fitted = fitToBudget(article.text, DEFAULT_INPUT_CHAR_BUDGET);
      write((entry) => {
        entry.title = article.title;
        entry.truncated = fitted.truncated;
        entry.status = { kind: "running", phase: "summarizing" };
      });
      post({ type: "article", title: article.title, truncated: fitted.truncated });
      post({ type: "phase", phase: "summarizing" });

      const engine = createEngine(settings);
      const stream = engine.summarize(
        {
          article: { ...article, text: fitted.text },
          format: settings.format,
          maxWords: settings.maxWords,
        },
        signal,
      );
      let sawContent = false;
      for await (const chunk of stream) {
        sawContent = true;
        write(
          (entry) => {
            entry.markdown += chunk;
          },
          { urgent: false },
        );
        post({ type: "chunk", text: chunk });
      }
      if (!sawContent) {
        // Thinking models can spend the whole output budget reasoning and end
        // the stream cleanly with no summary; surface that instead of a
        // silent, empty "done".
        fail("empty-summary", "The model finished without producing any summary text.");
        return;
      }
      write((entry) => {
        entry.status = { kind: "done" };
      });
      post({ type: "done" });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      if (error instanceof EngineError) {
        fail(error.code, error.message);
      } else {
        fail("engine-error", String(error));
      }
    }
  }
}
