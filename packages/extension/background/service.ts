// Background orchestration: engine configuration and summarization routing
// between the content script and the local inference endpoint. Parameterized
// over Platform and the engine factory so it is testable with fakes; the
// entry point (index.ts) wires in the real implementations.
//
// MV3 constraint honored by startBackground: no top-level await, and all
// listeners are registered synchronously when it is called at load.

import type { Platform, PlatformPort } from "../platform/types";
import { DEFAULT_INPUT_CHAR_BUDGET, fitToBudget } from "@offline-tldr/core";
import {
  SUMMARIZE_PORT,
  type BackgroundRequest,
  type ExtractArticleResponse,
  type GetActivePageResponse,
  type GetPageUrlResponse,
  type GetSettingsResponse,
  type ProbeEngineResponse,
  type Settings,
  type SummarizeEvent,
  type SummarizeStart,
} from "@offline-tldr/shared";
import { normalizeSettings } from "../lib/settings";
import { EngineError, type EngineClient } from "./engines";

const SETTINGS_KEY = "settings";

export interface BackgroundDeps {
  platform: Platform;
  createEngine: (settings: Settings) => EngineClient;
}

export function startBackground({ platform, createEngine }: BackgroundDeps): void {
  platform.initPanelBehavior();

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
      default:
        return undefined;
    }
  });

  platform.onConnect((port) => {
    if (port.name !== SUMMARIZE_PORT) {
      return;
    }
    const abort = new AbortController();
    port.onDisconnect(() => abort.abort());
    port.onMessage((message) => {
      const start = message as SummarizeStart;
      if (start?.type === "start") {
        void runSummarize(port, abort.signal, start.tabId);
      }
    });
  });

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

  async function runSummarize(port: PlatformPort, signal: AbortSignal, requestedTabId?: number): Promise<void> {
    const post = (event: SummarizeEvent) => {
      if (signal.aborted) {
        return;
      }
      try {
        port.postMessage(event);
      } catch {
        // The panel closed mid-stream; the abort listener will stop the run.
      }
    };

    try {
      const settings = await loadSettings();

      post({ type: "phase", phase: "extracting" });
      const tabId = requestedTabId ?? (await platform.getActiveTab())?.id;
      if (tabId === undefined) {
        post({ type: "error", code: "page-unsupported", message: "No active tab." });
        return;
      }

      let extracted: ExtractArticleResponse;
      try {
        extracted = await extractFromTab(tabId);
      } catch {
        post({ type: "error", code: "page-unsupported", message: "This page cannot be read." });
        return;
      }
      if (!extracted?.ok) {
        post({ type: "error", code: "no-content", message: "No readable article text found on this page." });
        return;
      }

      const fitted = fitToBudget(extracted.article.text, DEFAULT_INPUT_CHAR_BUDGET);
      post({ type: "article", title: extracted.article.title, truncated: fitted.truncated });
      post({ type: "phase", phase: "summarizing" });

      const engine = createEngine(settings);
      const stream = engine.summarize(
        {
          article: { ...extracted.article, text: fitted.text },
          format: settings.format,
          maxWords: settings.maxWords,
        },
        signal,
      );
      let sawContent = false;
      for await (const chunk of stream) {
        sawContent = true;
        post({ type: "chunk", text: chunk });
      }
      if (!sawContent) {
        // Thinking models can spend the whole output budget reasoning and end
        // the stream cleanly with no summary; surface that instead of a
        // silent, empty "done".
        post({ type: "error", code: "empty-summary", message: "The model finished without producing any summary text." });
        return;
      }
      post({ type: "done" });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      if (error instanceof EngineError) {
        post({ type: "error", code: error.code, message: error.message });
      } else {
        post({ type: "error", code: "engine-error", message: String(error) });
      }
    }
  }
}
