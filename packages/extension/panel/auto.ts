// Auto-summarize policy: which active pages qualify for an automatic run, the
// identity key that dedupes repeated triggers, and the controller that turns a
// stream of "the page may have changed" signals into start effects.
// DOM-free and platform-free so every rule is unit-testable; main.ts only
// supplies the effects.
//
// Runs belong to tabs, not to the panel (issue #7): switching away no longer
// cancels anything - the background's single-run policy supersedes an
// in-flight run only when a new one starts.

import { pageKey } from "@offline-tldr/core";
import type { ActivePage } from "@offline-tldr/shared";

/**
 * Identity of the page an auto run would summarize, or null when it should
 * not run: no page (browser-internal tabs have no content script to report
 * one), still loading (extraction would see a partial page), or a
 * non-http(s) URL. The key changes with either the tab or its URL, so
 * switching tabs and navigating both read as "a different page", while
 * repeated triggers for the same page dedupe to one run. The fragment is
 * ignored (pageKey): in-page jumps and scroll-position replaceState churn
 * are not new content.
 */
export function autoRunKey(page: ActivePage | null): string | null {
  if (!page || !page.complete) {
    return null;
  }
  const key = pageKey(page.url);
  return key === null ? null : `${page.tabId}|${key}`;
}

export interface AutoRunDeps {
  /** Whether auto mode may run at all (switch on, engine able to summarize). */
  enabled(): boolean;
  /** The active page, or null when the extension cannot see one. */
  getPage(): Promise<ActivePage | null>;
  /**
   * Whether the background already holds state for this tab and page - a
   * finished summary, a stored error, or a run still streaming. Such a page
   * is settled: auto mode shows what exists instead of running again.
   */
  hasState(page: ActivePage): Promise<boolean>;
  /** Starts an auto run for this page. */
  start(page: ActivePage): void;
}

export interface AutoRun {
  /** Signals that the active page may have changed. */
  trigger(): void;
  /**
   * Records the page of a run started outside the controller (the manual
   * button) once its lookup resolves, so a spurious same-page trigger does
   * not restart a run the user just started or stopped. A result that
   * arrives after the controller has moved on (started another run
   * meanwhile) is stale and discarded.
   */
  noteManualRun(lookup: Promise<ActivePage | null>): void;
}

/**
 * Serializes trigger handling: one evaluation at a time, and a trigger that
 * arrives mid-evaluation queues a re-evaluation instead of being dropped, so
 * a navigation during the page lookup is never missed.
 *
 * Policy per evaluation: an ineligible page does nothing (the panel shows
 * whatever the tab's state is); an eligible page already keyed or already
 * settled in the background is skipped; anything else starts a run.
 */
export function createAutoRun(deps: AutoRunDeps): AutoRun {
  let lastKey: string | null = null;
  let evaluating = false;
  let queued = false;
  /** Bumped by every started run; stale noteManualRun results compare against it. */
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
    if (!page || key === null || key === lastKey) {
      return;
    }
    if (await deps.hasState(page)) {
      // Settled elsewhere (revisited tab, resumed run); remember the key so
      // repeated triggers for it stop asking.
      lastKey = key;
      return;
    }
    if (!deps.enabled()) {
      return;
    }
    generation += 1;
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
      generation += 1;
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
