// Auto-summarize policy: which active pages qualify for an automatic run, the
// identity key that dedupes repeated triggers, and the controller that turns a
// stream of "the page may have changed" signals into cancel/start effects.
// DOM-free and platform-free so every rule is unit-testable; main.ts only
// supplies the effects.

import type { ActivePage } from "@offline-tldr/shared";

/**
 * Identity of the page an auto run would summarize, or null when it should
 * not run: no page (browser-internal tabs have no content script to report
 * one), still loading (extraction would see a partial page), or a
 * non-http(s) URL. The key changes with either the tab or its URL, so
 * switching tabs and navigating both read as "a different page", while
 * repeated triggers for the same page dedupe to one run. The fragment is
 * ignored: in-page jumps and scroll-position replaceState churn are not new
 * content.
 */
export function autoRunKey(page: ActivePage | null): string | null {
  if (!page || !page.complete) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  url.hash = "";
  return `${page.tabId}|${url.href}`;
}

export interface AutoRunDeps {
  /** Whether auto mode may run at all (switch on, engine able to summarize). */
  enabled(): boolean;
  /** The active page, or null when the extension cannot see one. */
  getPage(): Promise<ActivePage | null>;
  /** Cancels the in-flight run, if any; true when one was actually canceled. */
  cancel(): boolean;
  /** Starts an auto run for this page. */
  start(page: ActivePage): void;
}

export interface AutoRun {
  /** Signals that the active page may have changed. */
  trigger(): void;
  /**
   * Records the page of a run started outside the controller (the manual
   * button) once its lookup resolves. A result that arrives after the
   * controller has moved on (canceled or started another run meanwhile) is
   * stale and discarded.
   */
  noteManualRun(lookup: Promise<ActivePage | null>): void;
}

/**
 * Serializes trigger handling: one evaluation at a time, and a trigger that
 * arrives mid-evaluation queues a re-evaluation instead of being dropped, so
 * a navigation during the page lookup is never missed.
 *
 * Policy per evaluation: when the active page differs from the last run's,
 * cancel whatever is still running (the panel must not keep working on a page
 * the user left); a canceled page forgets its key so returning to it re-runs.
 * Then start a run only for an eligible page - an ineligible destination (new
 * tab, browser-internal page) keeps the last finished summary on screen.
 */
export function createAutoRun(deps: AutoRunDeps): AutoRun {
  let lastKey: string | null = null;
  let evaluating = false;
  let queued = false;
  /** Bumped by every mutating evaluation; stale noteManualRun results compare against it. */
  let generation = 0;

  async function evaluate(): Promise<void> {
    if (!deps.enabled()) {
      return;
    }
    const page = await deps.getPage();
    // Re-check: the switch may have been flipped off (or the engine lost)
    // while the lookup was pending.
    if (!deps.enabled()) {
      return;
    }
    const key = autoRunKey(page);
    if (key === lastKey) {
      return;
    }
    generation += 1;
    if (deps.cancel()) {
      lastKey = null;
    }
    if (!page || !key) {
      return;
    }
    lastKey = key;
    deps.start(page);
  }

  return {
    trigger(): void {
      if (evaluating) {
        queued = true;
        return;
      }
      evaluating = true;
      void (async () => {
        try {
          do {
            queued = false;
            await evaluate();
          } while (queued);
        } finally {
          evaluating = false;
        }
      })();
    },
    noteManualRun(lookup: Promise<ActivePage | null>): void {
      const startedAt = generation;
      void lookup.then(
        (page) => {
          if (generation !== startedAt) {
            return;
          }
          lastKey = autoRunKey(page) ?? lastKey;
        },
        () => {},
      );
    },
  };
}
