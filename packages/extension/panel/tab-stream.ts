// Pure policy for the panel's view over the summarize port: which port events
// apply to the tab currently on screen, and how run events fold into the
// displayed view. DOM-free so the re-watch races (rapid tab switches, SPA
// navigations, stale snapshots, events racing a snapshot) are unit-testable;
// main.ts only paints the result.

import type { SummarizeEvent, SummarizePortEvent, TabSummaryState } from "@offline-tldr/shared";

/** What the panel shows for the watched tab. */
export interface RunView {
  running: boolean;
  /** Whether an auto run produced it; auto runs render expected errors quietly. */
  auto: boolean;
  title: string;
  truncated: boolean;
  markdown: string;
}

export function emptyView(): RunView {
  return { running: false, auto: false, title: "", truncated: false, markdown: "" };
}

export function viewFromState(state: TabSummaryState | null): RunView {
  if (!state) {
    return emptyView();
  }
  return {
    running: state.status.kind === "running",
    auto: state.auto,
    title: state.title,
    truncated: state.truncated,
    markdown: state.markdown,
  };
}

/**
 * Folds one run event into the view. "extracting" opens a run (ours, or one
 * another surface started for this tab) and resets the accumulation to that
 * run's mode; the article event clears the summary body again in case the
 * reset was missed (a snapshot of the previous summary arriving between the
 * two events).
 */
export function applyRunEvent(view: RunView, event: SummarizeEvent): RunView {
  switch (event.type) {
    case "phase":
      return event.phase === "extracting" ? { ...emptyView(), running: true, auto: event.auto } : { ...view, running: true };
    case "article":
      return { ...view, title: event.title, truncated: event.truncated, markdown: "" };
    case "chunk":
      return { ...view, markdown: view.markdown + event.text };
    case "done":
    case "error":
      return { ...view, running: false };
  }
}

export interface TabStream {
  /** Starts watching a tab; returns the watchId the watch command must carry. */
  beginWatch(tabId: number): number;
  /** Stops watching (no active tab). */
  clear(): void;
  watchedTabId(): number | null;
  /**
   * Classifies a port event against the current watch: the snapshot
   * answering it (which marks the stream synced), a run event for the
   * watched tab, or noise to drop - snapshots from superseded watches,
   * events for other tabs, and events that raced ahead of the snapshot and
   * are already folded into it.
   */
  classify(event: SummarizePortEvent): "snapshot" | "run-event" | "ignore";
}

export function createTabStream(): TabStream {
  let watchedTabId: number | null = null;
  let watchId = 0;
  let synced = false;

  return {
    beginWatch(tabId: number): number {
      watchedTabId = tabId;
      synced = false;
      watchId += 1;
      return watchId;
    },
    clear(): void {
      watchedTabId = null;
      synced = false;
    },
    watchedTabId: () => watchedTabId,
    classify(event: SummarizePortEvent): "snapshot" | "run-event" | "ignore" {
      if (event.type === "tab-state") {
        if (event.watchId !== watchId || event.tabId !== watchedTabId) {
          return "ignore";
        }
        synced = true;
        return "snapshot";
      }
      return synced && event.tabId === watchedTabId ? "run-event" : "ignore";
    },
  };
}
