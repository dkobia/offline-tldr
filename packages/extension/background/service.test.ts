import { describe, expect, it } from "vitest";
import { outputTokenCap, type SummaryRequest } from "@offline-tldr/core";
import type {
  EngineStatus,
  Settings,
  SummarizeEvent,
  SummarizePortEvent,
  TabSummaryState,
} from "@offline-tldr/shared";
import type { ActiveTab, MessageHandler, Platform, PlatformPort } from "../platform/types";
import { DEFAULT_SETTINGS } from "../lib/settings";
import type { EngineClient } from "./engines";
import { EngineError } from "./engines";
import { startBackground } from "./service";

// ---- Fakes --------------------------------------------------------------------------

class FakePort implements PlatformPort {
  readonly name = "summarize";
  readonly received: SummarizePortEvent[] = [];
  private messageCallbacks: ((message: unknown) => void)[] = [];
  private disconnectCallbacks: (() => void)[] = [];

  postMessage(message: unknown): void {
    this.received.push(message as SummarizePortEvent);
  }
  onMessage(callback: (message: unknown) => void): void {
    this.messageCallbacks.push(callback);
  }
  onDisconnect(callback: () => void): void {
    this.disconnectCallbacks.push(callback);
  }
  disconnect(): void {
    for (const callback of this.disconnectCallbacks) {
      callback();
    }
  }
  /** Simulates the panel sending a command into the background. */
  send(message: unknown): void {
    for (const callback of this.messageCallbacks) {
      callback(message);
    }
  }
  /** The run events streamed to this port, unwrapped. */
  runEvents(): SummarizeEvent[] {
    return this.received.flatMap((event) => (event.type === "tab-event" ? [event.event] : []));
  }
  /** The state snapshots answering this port's watches. */
  snapshots(): (TabSummaryState | null)[] {
    return this.received.flatMap((event) => (event.type === "tab-state" ? [event.state] : []));
  }
}

interface FakePlatformOptions {
  activeTabId?: number | undefined;
  /** Responses for consecutive sendTabMessage calls; an Error entry rejects. */
  tabResponses?: (unknown | Error)[];
  /** Pre-seeded storage.session contents (simulates a background restart). */
  session?: Record<string, unknown>;
  /** Hold session writes open until releaseSessionWrites() (simulates slow storage). */
  gateSessionWrites?: boolean;
}

class FakePlatform implements Platform {
  readonly name = "chrome";
  readonly storage = new Map<string, unknown>();
  readonly session = new Map<string, unknown>();
  readonly injectedTabs: number[] = [];
  readonly tabMessages: unknown[] = [];
  readonly tabMessageTargets: number[] = [];
  private messageHandler: MessageHandler | undefined;
  private connectCallback: ((port: PlatformPort) => void) | undefined;
  private tabRemovedListener: ((tabId: number) => void) | undefined;
  private readonly tabResponses: (unknown | Error)[];
  private readonly activeTabId: number | undefined;
  private sessionGateOpen: boolean;
  private pendingSessionWrites: (() => void)[] = [];
  private inFlightSessionWrites = 0;
  /** High-water mark of concurrent session writes; 1 means writes are serialized. */
  maxInFlightSessionWrites = 0;

  constructor(options: FakePlatformOptions = {}) {
    this.activeTabId = "activeTabId" in options ? options.activeTabId : 1;
    this.tabResponses = options.tabResponses ?? [];
    this.sessionGateOpen = !options.gateSessionWrites;
    for (const [key, value] of Object.entries(options.session ?? {})) {
      this.session.set(key, value);
    }
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    return (this.storage.get(key) as T | undefined) ?? fallback;
  }
  async setSetting<T>(key: string, value: T): Promise<void> {
    this.storage.set(key, value);
  }
  async getSessionValue<T>(key: string, fallback: T): Promise<T> {
    return (this.session.get(key) as T | undefined) ?? fallback;
  }
  async setSessionValue<T>(key: string, value: T): Promise<void> {
    this.inFlightSessionWrites += 1;
    this.maxInFlightSessionWrites = Math.max(this.maxInFlightSessionWrites, this.inFlightSessionWrites);
    if (!this.sessionGateOpen) {
      await new Promise<void>((resolve) => this.pendingSessionWrites.push(resolve));
    }
    // storage.session structured-clones; mirror that so later mutations of
    // live objects cannot mask missing writes.
    this.session.set(key, structuredClone(value));
    this.inFlightSessionWrites -= 1;
  }
  /** Opens the write gate and completes writes as they are issued. */
  releaseSessionWrites(): void {
    this.sessionGateOpen = true;
    this.pendingSessionWrites.splice(0).forEach((resolve) => resolve());
  }
  sendMessage(): Promise<unknown> {
    throw new Error("not used by the background");
  }
  async sendTabMessage(tabId: number, message: unknown): Promise<unknown> {
    this.tabMessageTargets.push(tabId);
    this.tabMessages.push(message);
    const next = this.tabResponses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
  connect(): PlatformPort {
    throw new Error("not used by the background");
  }
  onConnect(callback: (port: PlatformPort) => void): void {
    this.connectCallback = callback;
  }
  async getActiveTab(): Promise<ActiveTab | undefined> {
    return this.activeTabId === undefined ? undefined : { id: this.activeTabId, complete: true };
  }
  onActiveTabChanged(): void {}
  onTabRemoved(listener: (tabId: number) => void): void {
    this.tabRemovedListener = listener;
  }
  async injectContentScript(tabId: number): Promise<void> {
    this.injectedTabs.push(tabId);
  }
  initPanelBehavior(): void {}

  /** Simulates a one-shot message from the panel; undefined = unhandled. */
  dispatch(message: unknown): Promise<unknown> | undefined {
    if (!this.messageHandler) {
      throw new Error("no message handler registered");
    }
    return this.messageHandler(message, undefined);
  }
  /** Simulates the panel opening a port. */
  openPort(): FakePort {
    if (!this.connectCallback) {
      throw new Error("no connect callback registered");
    }
    const port = new FakePort();
    this.connectCallback(port);
    return port;
  }
  /** Simulates a tab closing. */
  removeTab(tabId: number): void {
    this.tabRemovedListener?.(tabId);
  }
  /** The per-tab store as last mirrored to storage.session. */
  persistedStates(): Record<string, TabSummaryState> {
    return (this.session.get("tab-state") as Record<string, TabSummaryState> | undefined) ?? {};
  }
}

class FakeEngine implements EngineClient {
  readonly name = "fake";
  requests: SummaryRequest[] = [];
  signals: (AbortSignal | undefined)[] = [];
  /** What contextLength() reports; null mimics a runtime that cannot say. */
  contextTokens: number | null = null;

  constructor(
    private readonly chunks: string[] = [],
    private readonly failure?: Error,
    private readonly probeStatus: EngineStatus = { state: "ok", models: ["m"] },
    /** Resolved between chunks so tests can interleave (e.g. cancel mid-stream). */
    private readonly gate: () => Promise<void> = async () => {},
  ) {}

  get signal(): AbortSignal | undefined {
    return this.signals.at(-1);
  }

  async probe(): Promise<EngineStatus> {
    return this.probeStatus;
  }

  async contextLength(): Promise<number | null> {
    return this.contextTokens;
  }

  async *summarize(request: SummaryRequest, signal?: AbortSignal): AsyncIterable<string> {
    this.requests.push(request);
    this.signals.push(signal);
    if (this.failure) {
      throw this.failure;
    }
    for (const chunk of this.chunks) {
      await this.gate();
      if (signal?.aborted) {
        return;
      }
      yield chunk;
    }
  }
}

const PAGE_URL = "https://example.com/article";
const URL_RESPONSE = { url: PAGE_URL };
const ARTICLE = { ok: true, article: { title: "T", text: "Body. ".repeat(50).trim() } };

function start(platform: FakePlatform, engine: EngineClient): { engineSettings: Settings[] } {
  const engineSettings: Settings[] = [];
  startBackground({
    platform,
    createEngine: (settings) => {
      engineSettings.push(settings);
      return engine;
    },
  });
  return { engineSettings };
}

/** Opens a port, watches the tab, starts a run, and waits for it to settle. */
async function summarizeAndWait(platform: FakePlatform, tabId = 1): Promise<FakePort> {
  const port = platform.openPort();
  port.send({ type: "watch", tabId, url: PAGE_URL, watchId: 1 });
  port.send({ type: "start", tabId, auto: false });
  await waitForSettled(port);
  return port;
}

async function waitForSettled(port: FakePort): Promise<void> {
  await waitFor(() => port.runEvents().some((event) => event.type === "done" || event.type === "error"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!predicate()) {
    throw new Error("condition never became true");
  }
}

// ---- Tests --------------------------------------------------------------------------

describe("messages", () => {
  it("returns normalized default settings when storage is empty", async () => {
    const platform = new FakePlatform();
    start(platform, new FakeEngine());
    expect(await platform.dispatch({ type: "get-settings" })).toEqual({ settings: DEFAULT_SETTINGS });
  });

  it("normalizes on save and persists", async () => {
    const platform = new FakePlatform();
    start(platform, new FakeEngine());
    const saved = (await platform.dispatch({
      type: "save-settings",
      settings: { ...DEFAULT_SETTINGS, endpoint: "http://evil.example.com", maxWords: 5 },
    })) as { settings: Settings };
    expect(saved.settings.endpoint).toBe("http://localhost:11434");
    expect(saved.settings.maxWords).toBe(30);
    expect(await platform.dispatch({ type: "get-settings" })).toEqual({ settings: saved.settings });
  });

  it("probes with normalized settings and returns the engine status", async () => {
    const platform = new FakePlatform();
    const { engineSettings } = start(platform, new FakeEngine([], undefined, { state: "forbidden" }));
    const response = await platform.dispatch({
      type: "probe-engine",
      settings: { ...DEFAULT_SETTINGS, endpoint: "http://localhost:11434/" },
    });
    expect(response).toEqual({ status: { state: "forbidden" } });
    expect(engineSettings[0]?.endpoint).toBe("http://localhost:11434");
  });

  it("leaves unknown messages unhandled", () => {
    const platform = new FakePlatform();
    start(platform, new FakeEngine());
    expect(platform.dispatch({ type: "mystery" })).toBeUndefined();
  });
});

describe("get-active-page", () => {
  it("returns the active tab with the URL its content script reports", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE] });
    start(platform, new FakeEngine());
    expect(await platform.dispatch({ type: "get-active-page" })).toEqual({
      page: { tabId: 1, url: PAGE_URL, complete: true },
    });
    expect(platform.tabMessages).toEqual([{ type: "get-page-url" }]);
  });

  it("injects the content script and retries when the tab has no listener", async () => {
    const platform = new FakePlatform({
      tabResponses: [new Error("no listener"), { url: "https://example.com/late" }],
    });
    start(platform, new FakeEngine());
    expect(await platform.dispatch({ type: "get-active-page" })).toEqual({
      page: { tabId: 1, url: "https://example.com/late", complete: true },
    });
    expect(platform.injectedTabs).toEqual([1]);
  });

  it("returns a null page when there is no active tab or the content script stays unreachable", async () => {
    const noTab = new FakePlatform({ activeTabId: undefined });
    start(noTab, new FakeEngine());
    expect(await noTab.dispatch({ type: "get-active-page" })).toEqual({ page: null });

    const unreachable = new FakePlatform({
      tabResponses: [new Error("no listener"), new Error("still no listener")],
    });
    start(unreachable, new FakeEngine());
    expect(await unreachable.dispatch({ type: "get-active-page" })).toEqual({ page: null });
  });
});

describe("input budget", () => {
  const LONG_ARTICLE = { ok: true, article: { title: "T", text: "x".repeat(30_000) } };

  it("fits the article to the fixed default when the runtime reports no context", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, LONG_ARTICLE] });
    const engine = new FakeEngine(["ok"]);
    start(platform, engine);
    const port = await summarizeAndWait(platform);
    expect(port.runEvents()).toContainEqual({ type: "article", title: "T", truncated: true });
    expect(engine.requests[0]?.article.text).toHaveLength(20_000);
    expect(platform.persistedStates()["1"]?.truncated).toBe(true);
  });

  it("sends the whole article when the loaded model's context has room for it", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, LONG_ARTICLE] });
    const engine = new FakeEngine(["ok"]);
    engine.contextTokens = 32_768;
    start(platform, engine);
    const port = await summarizeAndWait(platform);
    expect(port.runEvents()).toContainEqual({ type: "article", title: "T", truncated: false });
    expect(engine.requests[0]?.article.text).toHaveLength(30_000);
  });

  it("shrinks both the article and the output cap for a small loaded context", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, LONG_ARTICLE] });
    const engine = new FakeEngine(["ok"]);
    engine.contextTokens = 4096;
    start(platform, engine);
    await summarizeAndWait(platform);
    const request = engine.requests[0]!;
    expect(request.article.text.length).toBeLessThan(20_000);
    expect(request.maxOutputTokens).toBeLessThan(outputTokenCap(DEFAULT_SETTINGS.maxWords));
    expect(Math.ceil(request.article.text.length / 4) + request.maxOutputTokens!).toBeLessThan(4096);
  });

  it("requests the full output cap when the context has room", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    const engine = new FakeEngine(["ok"]);
    engine.contextTokens = 32_768;
    start(platform, engine);
    await summarizeAndWait(platform);
    expect(engine.requests[0]?.maxOutputTokens).toBe(outputTokenCap(DEFAULT_SETTINGS.maxWords));
  });
});

describe("summarize runs", () => {
  it("streams phases, article, chunks, and done in order", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    const engine = new FakeEngine(["Hello ", "world"]);
    start(platform, engine);
    const port = await summarizeAndWait(platform);
    expect(port.snapshots()).toEqual([null]);
    expect(port.runEvents()).toEqual([
      { type: "phase", phase: "extracting", auto: false },
      { type: "phase", phase: "summarizing" },
      { type: "article", title: "T", truncated: false },
      { type: "chunk", text: "Hello " },
      { type: "chunk", text: "world" },
      { type: "done" },
    ]);
    expect(engine.requests[0]?.article.title).toBe("T");
  });

  it("serializes session writes so a slow write cannot land after a newer snapshot", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE], gateSessionWrites: true });
    start(platform, new FakeEngine(["S1"]));
    const port = await summarizeAndWait(platform);
    expect(port.runEvents().at(-1)).toEqual({ type: "done" });

    // The first write is still held open, so nothing may have landed and no
    // later snapshot may have been written around it.
    expect(platform.persistedStates()).toEqual({});
    expect(platform.maxInFlightSessionWrites).toBe(1);

    platform.releaseSessionWrites();
    await waitFor(() => platform.persistedStates()["1"]?.status.kind === "done");
    expect(platform.maxInFlightSessionWrites).toBe(1);
    expect(platform.persistedStates()["1"]?.markdown).toBe("S1");
  });

  it("stores the finished summary and mirrors it to session storage", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    start(platform, new FakeEngine(["Hello ", "world"]));
    await summarizeAndWait(platform);
    expect(platform.persistedStates()["1"]).toEqual({
      url: PAGE_URL,
      status: { kind: "done" },
      title: "T",
      truncated: false,
      markdown: "Hello world",
      auto: false,
    });
  });

  it("answers a later watch of the same page with the stored summary", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    start(platform, new FakeEngine(["Hi"]));
    await summarizeAndWait(platform);

    const revisit = platform.openPort();
    revisit.send({ type: "watch", tabId: 1, url: PAGE_URL, watchId: 5 });
    await waitFor(() => revisit.received.length > 0);
    expect(revisit.received[0]).toEqual({
      type: "tab-state",
      watchId: 5,
      tabId: 1,
      state: expect.objectContaining({ status: { kind: "done" }, markdown: "Hi" }),
    });
  });

  it("ignores the fragment when validating the stored URL", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    start(platform, new FakeEngine(["Hi"]));
    await summarizeAndWait(platform);

    const state = (await platform.dispatch({ type: "get-tab-state", tabId: 1, url: `${PAGE_URL}#section-2` })) as {
      state: TabSummaryState | null;
    };
    expect(state.state?.markdown).toBe("Hi");
  });

  it("drops the entry when the tab shows a different page", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    start(platform, new FakeEngine(["Hi"]));
    await summarizeAndWait(platform);

    const revisit = platform.openPort();
    revisit.send({ type: "watch", tabId: 1, url: "https://example.com/elsewhere", watchId: 2 });
    await waitFor(() => revisit.received.length > 0);
    expect(revisit.snapshots()).toEqual([null]);
    expect(platform.persistedStates()).toEqual({});
  });

  it("drops the entry when the tab closes", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    start(platform, new FakeEngine(["Hi"]));
    await summarizeAndWait(platform);
    platform.removeTab(1);
    await waitFor(() => Object.keys(platform.persistedStates()).length === 0);
  });

  it("snapshots an in-flight run for a re-attaching watcher and keeps streaming to it", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    const releases: (() => void)[] = [];
    const gate = () => new Promise<void>((resolve) => releases.push(resolve));
    start(platform, new FakeEngine(["one", "two"], undefined, { state: "ok", models: [] }, gate));

    const first = platform.openPort();
    first.send({ type: "watch", tabId: 1, url: PAGE_URL, watchId: 1 });
    first.send({ type: "start", tabId: 1, auto: false });
    await waitFor(() => releases.length === 1);
    releases[0]?.();
    await waitFor(() => first.runEvents().some((event) => event.type === "chunk"));
    first.disconnect();

    // The panel reopens mid-run: the snapshot carries what streamed so far.
    const second = platform.openPort();
    second.send({ type: "watch", tabId: 1, url: PAGE_URL, watchId: 1 });
    await waitFor(() => second.received.length > 0);
    expect(second.snapshots()[0]).toEqual(
      expect.objectContaining({ status: { kind: "running", phase: "summarizing" }, markdown: "one" }),
    );

    await waitFor(() => releases.length === 2);
    releases[1]?.();
    await waitForSettled(second);
    expect(second.runEvents()).toEqual([
      { type: "chunk", text: "two" },
      { type: "done" },
    ]);
  });

  it("orders the reset event after a snapshot taken during a re-run's setup", async () => {
    let releaseUrl!: (value: unknown) => void;
    const delayedUrl = new Promise((resolve) => (releaseUrl = resolve));
    const platform = new FakePlatform({
      tabResponses: [URL_RESPONSE, ARTICLE, delayedUrl, ARTICLE],
    });
    start(platform, new FakeEngine(["S1"]));
    const port = await summarizeAndWait(platform);

    // Re-run the same tab; while its URL lookup is pending, a panel attaches
    // and receives the old finished snapshot.
    port.send({ type: "start", tabId: 1, auto: false });
    await waitFor(() => platform.tabMessages.length === 3);
    const reattached = platform.openPort();
    reattached.send({ type: "watch", tabId: 1, url: PAGE_URL, watchId: 1 });
    await waitFor(() => reattached.snapshots().length === 1);
    expect(reattached.snapshots()[0]).toEqual(expect.objectContaining({ status: { kind: "done" }, markdown: "S1" }));

    releaseUrl(URL_RESPONSE);
    await waitForSettled(reattached);
    // The reset ("extracting") reaches the watcher after its snapshot; were
    // it broadcast before the entry replacement, the watcher would append the
    // new chunks to the old summary.
    expect(reattached.runEvents()).toEqual([
      { type: "phase", phase: "extracting", auto: false },
      { type: "phase", phase: "summarizing" },
      { type: "article", title: "T", truncated: false },
      { type: "chunk", text: "S1" },
      { type: "done" },
    ]);
  });

  it("keeps a run going when the panel disconnects", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    const releases: (() => void)[] = [];
    const gate = () => new Promise<void>((resolve) => releases.push(resolve));
    const engine = new FakeEngine(["one"], undefined, { state: "ok", models: [] }, gate);
    start(platform, engine);

    const port = platform.openPort();
    port.send({ type: "watch", tabId: 1, url: PAGE_URL, watchId: 1 });
    port.send({ type: "start", tabId: 1, auto: false });
    await waitFor(() => releases.length === 1);
    port.disconnect();
    expect(engine.signal?.aborted).toBe(false);

    releases[0]?.();
    await waitFor(() => platform.persistedStates()["1"]?.status.kind === "done");
  });

  it("cancel aborts the run and forgets the unfinished entry", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    const releases: (() => void)[] = [];
    const gate = () => new Promise<void>((resolve) => releases.push(resolve));
    const engine = new FakeEngine(["one", "two"], undefined, { state: "ok", models: [] }, gate);
    start(platform, engine);

    const port = platform.openPort();
    port.send({ type: "watch", tabId: 1, url: PAGE_URL, watchId: 1 });
    port.send({ type: "start", tabId: 1, auto: false });
    await waitFor(() => releases.length === 1);
    port.send({ type: "cancel", tabId: 1 });
    await waitFor(() => engine.signal?.aborted === true);
    expect(platform.persistedStates()).toEqual({});

    const before = port.runEvents().length;
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(port.runEvents()).toHaveLength(before);
  });

  it("starting a run supersedes the in-flight one and forgets its entry", async () => {
    const platform = new FakePlatform({
      tabResponses: [URL_RESPONSE, ARTICLE, { url: "https://example.com/other" }, ARTICLE],
    });
    const releases: (() => void)[] = [];
    const gate = () => new Promise<void>((resolve) => releases.push(resolve));
    const engine = new FakeEngine(["one", "two"], undefined, { state: "ok", models: [] }, gate);
    start(platform, engine);

    const port = platform.openPort();
    port.send({ type: "watch", tabId: 1, url: PAGE_URL, watchId: 1 });
    port.send({ type: "start", tabId: 1, auto: false });
    await waitFor(() => releases.length === 1);

    port.send({ type: "start", tabId: 2, auto: true });
    await waitFor(() => engine.signals[0]?.aborted === true);
    // Let both the aborted and the superseding run proceed to their ends.
    const pump = setInterval(() => releases.splice(0).forEach((release) => release()), 1);
    try {
      await waitFor(() => platform.persistedStates()["2"]?.status.kind === "done");
    } finally {
      clearInterval(pump);
    }
    expect(platform.persistedStates()["1"]).toBeUndefined();
    expect(platform.persistedStates()["2"]?.auto).toBe(true);
  });

  it("streams a tab's events only to ports watching that tab", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    start(platform, new FakeEngine(["Hi"]));
    const other = platform.openPort();
    other.send({ type: "watch", tabId: 9, url: PAGE_URL, watchId: 1 });
    await waitFor(() => other.received.length > 0);

    await summarizeAndWait(platform);
    expect(other.runEvents()).toEqual([]);
  });

  it("injects the content script and retries when the tab has no listener", async () => {
    const platform = new FakePlatform({
      tabResponses: [new Error("Could not establish connection"), URL_RESPONSE, ARTICLE],
    });
    start(platform, new FakeEngine(["ok"]));
    const port = await summarizeAndWait(platform);
    expect(platform.injectedTabs).toEqual([1]);
    expect(port.runEvents().at(-1)).toEqual({ type: "done" });
  });

  it("reports page-unsupported, storing nothing, when the page stays unreadable", async () => {
    const platform = new FakePlatform({
      tabResponses: [new Error("no listener"), new Error("still no listener")],
    });
    start(platform, new FakeEngine(["never"]));
    const port = await summarizeAndWait(platform);
    expect(port.runEvents().at(-1)).toMatchObject({ type: "error", code: "page-unsupported" });
    expect(platform.persistedStates()).toEqual({});
  });

  it("stores no-content errors so auto mode does not retry the page", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, { ok: false, error: "no-content" }] });
    start(platform, new FakeEngine(["never"]));
    const port = await summarizeAndWait(platform);
    expect(port.runEvents().at(-1)).toMatchObject({ type: "error", code: "no-content" });
    expect(platform.persistedStates()["1"]?.status).toMatchObject({ kind: "error", code: "no-content" });
  });

  it("reports empty-summary when the stream ends without any content", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    start(platform, new FakeEngine([]));
    const port = await summarizeAndWait(platform);
    expect(port.runEvents().at(-1)).toMatchObject({ type: "error", code: "empty-summary" });
    expect(port.runEvents().some((event) => event.type === "done")).toBe(false);
  });

  it("forwards EngineError codes to the panel and stores them", async () => {
    const platform = new FakePlatform({ tabResponses: [URL_RESPONSE, ARTICLE] });
    start(platform, new FakeEngine([], new EngineError("origin-forbidden", "403")));
    const port = await summarizeAndWait(platform);
    expect(port.runEvents().at(-1)).toEqual({ type: "error", code: "origin-forbidden", message: "403" });
    expect(platform.persistedStates()["1"]?.status).toMatchObject({ kind: "error", code: "origin-forbidden" });
  });
});

describe("restart restore", () => {
  const doneState: TabSummaryState = {
    url: PAGE_URL,
    status: { kind: "done" },
    title: "T",
    truncated: false,
    markdown: "Kept",
    auto: false,
  };
  const runningState: TabSummaryState = {
    url: "https://example.com/other",
    status: { kind: "running", phase: "summarizing" },
    title: "",
    truncated: false,
    markdown: "half",
    auto: true,
  };

  it("restores finished entries and drops orphaned running ones", async () => {
    const platform = new FakePlatform({
      session: { "tab-state": { "1": doneState, "2": runningState } },
    });
    start(platform, new FakeEngine());

    const kept = (await platform.dispatch({ type: "get-tab-state", tabId: 1, url: PAGE_URL })) as {
      state: TabSummaryState | null;
    };
    expect(kept.state).toEqual(doneState);

    const orphaned = (await platform.dispatch({
      type: "get-tab-state",
      tabId: 2,
      url: "https://example.com/other",
    })) as { state: TabSummaryState | null };
    expect(orphaned.state).toBeNull();
  });
});
