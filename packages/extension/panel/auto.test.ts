import { describe, expect, it } from "vitest";
import type { ActivePage } from "@offline-tldr/shared";
import { autoRunKey, createAutoRun, type AutoRunDeps } from "./auto";

describe("autoRunKey", () => {
  it("keys a loaded http(s) page by tab and URL", () => {
    expect(autoRunKey({ tabId: 7, url: "https://example.com/a", complete: true })).toBe("7|https://example.com/a");
    expect(autoRunKey({ tabId: 7, url: "http://example.com/a", complete: true })).toBe("7|http://example.com/a");
  });

  it("changes with the tab and with the URL", () => {
    const a = autoRunKey({ tabId: 1, url: "https://example.com/a", complete: true });
    expect(autoRunKey({ tabId: 2, url: "https://example.com/a", complete: true })).not.toBe(a);
    expect(autoRunKey({ tabId: 1, url: "https://example.com/b", complete: true })).not.toBe(a);
    expect(autoRunKey({ tabId: 1, url: "https://example.com/a?p=2", complete: true })).not.toBe(a);
  });

  it("ignores the fragment, so in-page jumps are not new pages", () => {
    const a = autoRunKey({ tabId: 1, url: "https://example.com/a", complete: true });
    expect(autoRunKey({ tabId: 1, url: "https://example.com/a#section-2", complete: true })).toBe(a);
  });

  it("returns null while the page is still loading", () => {
    expect(autoRunKey({ tabId: 1, url: "https://example.com", complete: false })).toBeNull();
  });

  it("returns null without a page", () => {
    expect(autoRunKey(null)).toBeNull();
  });

  it("returns null for non-http(s) and malformed URLs", () => {
    expect(autoRunKey({ tabId: 1, url: "about:blank", complete: true })).toBeNull();
    expect(autoRunKey({ tabId: 1, url: "file:///tmp/page.html", complete: true })).toBeNull();
    expect(autoRunKey({ tabId: 1, url: "not a url", complete: true })).toBeNull();
  });
});

// ---- createAutoRun ------------------------------------------------------------------

function page(tabId: number, path = "/"): ActivePage {
  return { tabId, url: `https://example.com${path}`, complete: true };
}

/**
 * Test double for the controller's effects. getPage answers from a queue of
 * results (an entry may be a promise, letting tests hold an evaluation open);
 * hasState answers from the set of URLs the background is said to hold state
 * for; start only records.
 */
function makeDeps() {
  const state = {
    enabled: true,
    started: [] as ActivePage[],
    lookups: 0,
    stateChecks: 0,
    /** URLs the background already has an entry for. */
    settled: new Set<string>(),
    pages: [] as (ActivePage | null | Promise<ActivePage | null>)[],
  };
  const deps: AutoRunDeps = {
    enabled: () => state.enabled,
    getPage: () => {
      state.lookups += 1;
      return Promise.resolve(state.pages.shift() ?? null);
    },
    hasState: (checked) => {
      state.stateChecks += 1;
      return Promise.resolve(state.settled.has(checked.url));
    },
    start: (started) => {
      state.started.push(started);
    },
  };
  return { deps, state };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createAutoRun", () => {
  it("starts a run for an eligible page and dedupes repeated triggers for it", async () => {
    const { deps, state } = makeDeps();
    const auto = createAutoRun(deps);
    state.pages = [page(1), page(1)];
    auto.trigger();
    await flush();
    auto.trigger();
    await flush();
    expect(state.started).toEqual([page(1)]);
  });

  it("starts over when the page changes", async () => {
    const { deps, state } = makeDeps();
    const auto = createAutoRun(deps);
    state.pages = [page(1, "/a"), page(1, "/b")];
    auto.trigger();
    await flush();
    auto.trigger();
    await flush();
    expect(state.started).toEqual([page(1, "/a"), page(1, "/b")]);
  });

  it("queues a trigger arriving mid-evaluation instead of dropping it", async () => {
    const { deps, state } = makeDeps();
    const auto = createAutoRun(deps);
    let release!: (value: ActivePage | null) => void;
    state.pages = [new Promise((resolve) => (release = resolve)), page(2)];
    auto.trigger();
    await flush();
    // The first lookup is still pending; this trigger must not be lost.
    auto.trigger();
    release(page(1));
    await flush();
    expect(state.lookups).toBe(2);
    expect(state.started).toEqual([page(1), page(2)]);
  });

  it("skips a page the background already has state for, and stops asking about it", async () => {
    const { deps, state } = makeDeps();
    const auto = createAutoRun(deps);
    state.settled.add(page(1, "/seen").url);
    state.pages = [page(1, "/seen"), page(1, "/seen")];
    auto.trigger();
    await flush();
    auto.trigger();
    await flush();
    expect(state.started).toEqual([]);
    // The settled page's key was remembered: the second trigger deduped
    // before reaching another state lookup.
    expect(state.stateChecks).toBe(1);
  });

  it("leaves the key on an ineligible page, so returning does not re-run", async () => {
    const { deps, state } = makeDeps();
    const auto = createAutoRun(deps);
    // Summarize page 1, visit an ineligible destination (new tab,
    // browser-internal page), come back: the run belongs to the tab now and
    // must not restart.
    state.pages = [page(1), null, page(1)];
    auto.trigger();
    await flush();
    auto.trigger();
    await flush();
    auto.trigger();
    await flush();
    expect(state.started).toEqual([page(1)]);
  });

  it("does not re-run a page recorded via noteManualRun (the manual button)", async () => {
    const { deps, state } = makeDeps();
    const auto = createAutoRun(deps);
    auto.noteManualRun(Promise.resolve(page(1)));
    await flush();
    state.pages = [page(1)];
    auto.trigger();
    await flush();
    expect(state.started).toEqual([]);
  });

  it("discards a manual-run record that resolves after the controller moved on", async () => {
    const { deps, state } = makeDeps();
    const auto = createAutoRun(deps);
    let release!: (value: ActivePage | null) => void;
    // Manual run on page 1 begins; before its lookup resolves, an auto run
    // for page 2 takes over.
    auto.noteManualRun(new Promise((resolve) => (release = resolve)));
    state.pages = [page(2)];
    auto.trigger();
    await flush();
    expect(state.started).toEqual([page(2)]);
    release(page(1));
    await flush();
    // Page 2 is still the current key: a repeat trigger must not restart it...
    state.pages = [page(2)];
    auto.trigger();
    await flush();
    expect(state.started).toEqual([page(2)]);
    // ...and returning to page 1 must run it (the stale record did not stick).
    state.pages = [page(1)];
    auto.trigger();
    await flush();
    expect(state.started).toEqual([page(2), page(1)]);
  });

  it("does nothing while disabled", async () => {
    const { deps, state } = makeDeps();
    state.enabled = false;
    const auto = createAutoRun(deps);
    state.pages = [page(1)];
    auto.trigger();
    await flush();
    expect(state.lookups).toBe(0);
    expect(state.started).toEqual([]);
  });

  it("does not start a run when disabled during a pending page lookup", async () => {
    const { deps, state } = makeDeps();
    const auto = createAutoRun(deps);
    let release!: (value: ActivePage | null) => void;
    state.pages = [new Promise((resolve) => (release = resolve))];
    auto.trigger();
    await flush();
    state.enabled = false;
    release(page(1));
    await flush();
    expect(state.started).toEqual([]);
  });
});
