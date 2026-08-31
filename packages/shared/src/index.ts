// Protocol types shared between the extension surfaces (background, content, panel).
// Type-only imports from core are allowed; runtime imports are not.

import type { ExtractedArticle, SummaryFormat } from "@offline-tldr/core";

export type { ExtractedArticle, SummaryFormat, SummaryRequest } from "@offline-tldr/core";

/** Which local runtime the extension talks to. */
export type EngineKind = "ollama" | "lmstudio" | "llamacpp" | "custom";

export interface Settings {
  engine: EngineKind;
  /** Base URL of the local server, e.g. "http://localhost:11434". Localhost only. */
  endpoint: string;
  /** Model identifier as the server knows it, e.g. "llama3.2" or "phi3". */
  model: string;
  format: SummaryFormat;
  /** Soft cap on summary length, in words. */
  maxWords: number;
  /** Summarize automatically while the panel is open and the active page changes. */
  autoSummarize: boolean;
}

/** Result of probing the configured engine endpoint. */
export type EngineStatus =
  | { state: "ok"; models: string[] }
  | { state: "unreachable"; detail?: string }
  /** Reachable but the server rejects browser-extension origins (Ollama without OLLAMA_ORIGINS). */
  | { state: "forbidden" }
  | { state: "error"; detail: string };

// ---- Panel/content -> background one-shot messages ----------------------------------

export type BackgroundRequest =
  | { type: "get-settings" }
  | { type: "save-settings"; settings: Settings }
  | { type: "probe-engine"; settings: Settings }
  | { type: "get-active-page" }
  | { type: "get-tab-state"; tabId: number; url: string };

export interface GetSettingsResponse {
  settings: Settings;
}

export interface ProbeEngineResponse {
  status: EngineStatus;
}

/**
 * The page the user is looking at. The URL comes from the tab's content
 * script (location.href), not from the tabs API: without the "tabs"
 * permission Chrome scrubs tabs.Tab.url, and content-script match patterns
 * deliberately do not lift that (scriptable hosts are not explicit hosts).
 */
export interface ActivePage {
  tabId: number;
  url: string;
  /** True once the tab has finished loading. */
  complete: boolean;
}

/** Null when there is no active tab or its content script is unreachable (browser-internal pages). */
export interface GetActivePageResponse {
  page: ActivePage | null;
}

// ---- Background -> content ----------------------------------------------------------

export interface ExtractArticleRequest {
  type: "extract-article";
}

export type ExtractArticleResponse =
  | { ok: true; article: ExtractedArticle }
  | { ok: false; error: "no-content" };

export interface GetPageUrlRequest {
  type: "get-page-url";
}

export interface GetPageUrlResponse {
  url: string;
}

// ---- Content -> extension pages -----------------------------------------------------

/**
 * Broadcast by the content script on same-document (SPA) navigations, which
 * never reach tabs.onUpdated as a load. Nobody needs to answer it; the open
 * panel reacts, the background ignores it.
 */
export interface PageChangedNotice {
  type: "page-changed";
}

// ---- Per-tab summary state ----------------------------------------------------------

/**
 * Everything the background remembers about one tab's summary, the panel's
 * source of truth when it activates a tab. Shaped so a chat context can be
 * added later without reworking the keying.
 */
export interface TabSummaryState {
  /** URL the run was started for; a tab showing a different page invalidates the entry. */
  url: string;
  status:
    | { kind: "running"; phase: "extracting" | "summarizing" }
    | { kind: "done" }
    | { kind: "error"; code: SummarizeErrorCode; message: string };
  title: string;
  truncated: boolean;
  /** Summary markdown accumulated so far (complete once status is done). */
  markdown: string;
  /** Whether an auto run produced it; auto runs render expected errors quietly. */
  auto: boolean;
}

export interface GetTabStateResponse {
  state: TabSummaryState | null;
}

// ---- Summarize stream (panel <-> background over a long-lived port) -----------------

export const SUMMARIZE_PORT = "summarize";

/**
 * Commands the panel sends over the port. `watch` subscribes the port to one
 * tab's run events and answers with a `tab-state` snapshot; the panel's
 * `watchId` is echoed back so a snapshot from a superseded watch is
 * discardable. `url` is the page the panel believes the tab shows; when the
 * panel cannot see one (browser-internal pages) the background asks the tab
 * itself. Runs are keyed to tabs, not ports: disconnecting only unsubscribes,
 * and `cancel` is how a run is actually stopped.
 */
export type SummarizeCommand =
  | { type: "watch"; tabId: number; url?: string; watchId: number }
  | { type: "start"; tabId: number; auto: boolean }
  | { type: "cancel"; tabId: number };

/** Events the background posts to a port: the snapshot answering a watch, then per-tab run deltas. */
export type SummarizePortEvent =
  | { type: "tab-state"; watchId: number; tabId: number; state: TabSummaryState | null }
  | { type: "tab-event"; tabId: number; event: SummarizeEvent };

export type SummarizeErrorCode =
  | "page-unsupported"
  | "no-content"
  | "engine-unreachable"
  | "origin-forbidden"
  | "model-missing"
  | "empty-summary"
  | "engine-error";

export type SummarizeEvent =
  /** "extracting" opens a run; it carries the run's mode so a watcher synced to an older snapshot adopts it. */
  | { type: "phase"; phase: "extracting"; auto: boolean }
  | { type: "phase"; phase: "summarizing" }
  | { type: "article"; title: string; truncated: boolean }
  | { type: "chunk"; text: string }
  | { type: "done" }
  | { type: "error"; code: SummarizeErrorCode; message: string };
