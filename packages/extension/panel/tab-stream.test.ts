import { describe, expect, it } from "vitest";
import type { SummarizePortEvent, TabSummaryState } from "@offline-tldr/shared";
import { applyRunEvent, createTabStream, emptyView, viewFromState, type RunView } from "./tab-stream";

function snapshot(tabId: number, watchId: number, state: TabSummaryState | null = null): SummarizePortEvent {
  return { type: "tab-state", tabId, watchId, state };
}

function chunk(tabId: number, text: string): SummarizePortEvent {
  return { type: "tab-event", tabId, event: { type: "chunk", text } };
}

const DONE_STATE: TabSummaryState = {
  url: "https://example.com/a",
  status: { kind: "done" },
  title: "T",
  truncated: true,
  markdown: "Old summary",
  auto: true,
};

describe("viewFromState", () => {
  it("maps null to the empty view", () => {
    expect(viewFromState(null)).toEqual(emptyView());
  });

  it("maps a stored state onto the view, running only while the run streams", () => {
    expect(viewFromState(DONE_STATE)).toEqual({
      running: false,
      auto: true,
      title: "T",
      truncated: true,
      markdown: "Old summary",
    });
    expect(viewFromState({ ...DONE_STATE, status: { kind: "running", phase: "summarizing" } }).running).toBe(true);
    expect(viewFromState({ ...DONE_STATE, status: { kind: "error", code: "no-content", message: "" } }).running).toBe(false);
  });
});

describe("applyRunEvent", () => {
  const oldView: RunView = { running: false, auto: true, title: "T", truncated: true, markdown: "Old summary" };

  it("resets the accumulation when a run opens, adopting the new run's mode", () => {
    // The old view came from an auto run; the new run is manual (and vice
    // versa below), so its errors must render with the new run's treatment.
    expect(applyRunEvent(oldView, { type: "phase", phase: "extracting", auto: false })).toEqual({
      ...emptyView(),
      running: true,
      auto: false,
    });
    expect(applyRunEvent({ ...oldView, auto: false }, { type: "phase", phase: "extracting", auto: true })).toEqual({
      ...emptyView(),
      running: true,
      auto: true,
    });
  });

  it("clears the summary body on the article event, so a missed reset cannot merge two runs", () => {
    // A watcher can attach between "extracting" and "article": its snapshot
    // carries the previous summary and the reset event is already gone.
    const next = applyRunEvent(oldView, { type: "article", title: "New", truncated: false });
    expect(next.markdown).toBe("");
    const streamed = applyRunEvent(next, { type: "chunk", text: "Fresh" });
    expect(streamed.markdown).toBe("Fresh");
  });

  it("appends chunks and keeps the rest of the view", () => {
    const view = { ...emptyView(), running: true, markdown: "a" };
    expect(applyRunEvent(view, { type: "chunk", text: "b" })).toEqual({ ...view, markdown: "ab" });
  });

  it("keeps content on the summarizing phase and marks the view running", () => {
    const view = { ...oldView, markdown: "partial" };
    expect(applyRunEvent(view, { type: "phase", phase: "summarizing" })).toEqual({ ...view, running: true });
  });

  it("stops running on done and error, keeping what streamed", () => {
    const view = { ...emptyView(), running: true, markdown: "kept" };
    expect(applyRunEvent(view, { type: "done" })).toEqual({ ...view, running: false });
    expect(applyRunEvent(view, { type: "error", code: "engine-error", message: "x" })).toEqual({
      ...view,
      running: false,
    });
  });
});

describe("createTabStream", () => {
  it("ignores run events until the watch's snapshot has arrived", () => {
    const stream = createTabStream();
    const watchId = stream.beginWatch(1);
    expect(stream.classify(chunk(1, "early"))).toBe("ignore");
    expect(stream.classify(snapshot(1, watchId))).toBe("snapshot");
    expect(stream.classify(chunk(1, "late"))).toBe("run-event");
  });

  it("ignores snapshots from a superseded watch", () => {
    const stream = createTabStream();
    const first = stream.beginWatch(1);
    const second = stream.beginWatch(2);
    // The slow snapshot for tab 1 arrives after the panel moved to tab 2.
    expect(stream.classify(snapshot(1, first))).toBe("ignore");
    expect(stream.classify(chunk(2, "x"))).toBe("ignore");
    expect(stream.classify(snapshot(2, second))).toBe("snapshot");
    expect(stream.classify(chunk(2, "x"))).toBe("run-event");
  });

  it("re-watching the same tab requires a fresh snapshot before events apply", () => {
    const stream = createTabStream();
    const first = stream.beginWatch(1);
    expect(stream.classify(snapshot(1, first))).toBe("snapshot");
    // SPA navigation: same tab, new watch. Events posted for the old page
    // before the background handled the re-watch must not leak through.
    const second = stream.beginWatch(1);
    expect(stream.classify(chunk(1, "stale"))).toBe("ignore");
    expect(stream.classify(snapshot(1, first))).toBe("ignore");
    expect(stream.classify(snapshot(1, second))).toBe("snapshot");
    expect(stream.classify(chunk(1, "fresh"))).toBe("run-event");
  });

  it("ignores events for tabs other than the watched one", () => {
    const stream = createTabStream();
    const watchId = stream.beginWatch(1);
    expect(stream.classify(snapshot(1, watchId))).toBe("snapshot");
    expect(stream.classify(chunk(2, "other"))).toBe("ignore");
    expect(stream.classify(snapshot(2, watchId))).toBe("ignore");
  });

  it("drops everything after clear until a new watch begins", () => {
    const stream = createTabStream();
    const watchId = stream.beginWatch(1);
    expect(stream.classify(snapshot(1, watchId))).toBe("snapshot");
    stream.clear();
    expect(stream.watchedTabId()).toBeNull();
    expect(stream.classify(chunk(1, "x"))).toBe("ignore");
    expect(stream.classify(snapshot(1, watchId))).toBe("ignore");
  });
});
