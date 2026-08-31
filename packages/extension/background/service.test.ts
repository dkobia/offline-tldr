import { describe, expect, it } from "vitest";
import type { SummaryRequest } from "@offline-tldr/core";
import type { EngineStatus, Settings, SummarizeEvent } from "@offline-tldr/shared";
import type { ActiveTab, MessageHandler, Platform, PlatformPort } from "../platform/types";
import { DEFAULT_SETTINGS } from "../lib/settings";
import type { EngineClient } from "./engines";
import { EngineError } from "./engines";
import { startBackground } from "./service";

// ---- Fakes --------------------------------------------------------------------------

class FakePort implements PlatformPort {
  readonly name = "summarize";
  readonly received: SummarizeEvent[] = [];
  private messageCallbacks: ((message: unknown) => void)[] = [];
  private disconnectCallbacks: (() => void)[] = [];

  postMessage(message: unknown): void {
    this.received.push(message as SummarizeEvent);
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
  /** Simulates the panel sending a message into the background. */
  send(message: unknown): void {
    for (const callback of this.messageCallbacks) {
      callback(message);
    }
  }
}

interface FakePlatformOptions {
  activeTabId?: number | undefined;
  /** Responses for consecutive sendTabMessage calls; an Error entry rejects. */
  tabResponses?: (unknown | Error)[];
}

class FakePlatform implements Platform {
  readonly name = "chrome";
  readonly storage = new Map<string, unknown>();
  readonly injectedTabs: number[] = [];
  readonly tabMessages: unknown[] = [];
  readonly tabMessageTargets: number[] = [];
  private messageHandler: MessageHandler | undefined;
  private connectCallback: ((port: PlatformPort) => void) | undefined;
  private readonly tabResponses: (unknown | Error)[];
  private readonly activeTabId: number | undefined;

  constructor(options: FakePlatformOptions = {}) {
    this.activeTabId = "activeTabId" in options ? options.activeTabId : 1;
    this.tabResponses = options.tabResponses ?? [];
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    return (this.storage.get(key) as T | undefined) ?? fallback;
  }
  async setSetting<T>(key: string, value: T): Promise<void> {
    this.storage.set(key, value);
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
}

class FakeEngine implements EngineClient {
  readonly name = "fake";
  requests: SummaryRequest[] = [];
  signal: AbortSignal | undefined;

  constructor(
    private readonly chunks: string[] = [],
    private readonly failure?: Error,
    private readonly probeStatus: EngineStatus = { state: "ok", models: ["m"] },
    /** Resolved between chunks so tests can interleave (e.g. disconnect mid-stream). */
    private readonly gate: () => Promise<void> = async () => {},
  ) {}

  async probe(): Promise<EngineStatus> {
    return this.probeStatus;
  }

  async *summarize(request: SummaryRequest, signal?: AbortSignal): AsyncIterable<string> {
    this.requests.push(request);
    this.signal = signal;
    if (this.failure) {
      throw this.failure;
    }
    for (const chunk of this.chunks) {
      await this.gate();
      yield chunk;
    }
  }
}

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

async function summarizeAndWait(platform: FakePlatform): Promise<FakePort> {
  const port = platform.openPort();
  port.send({ type: "start" });
  await waitFor(() => port.received.some((event) => event.type === "done" || event.type === "error"));
  return port;
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
    const platform = new FakePlatform({ tabResponses: [{ url: "https://example.com/article" }] });
    start(platform, new FakeEngine());
    expect(await platform.dispatch({ type: "get-active-page" })).toEqual({
      page: { tabId: 1, url: "https://example.com/article", complete: true },
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

describe("summarize port", () => {
  it("streams phases, article, chunks, and done in order", async () => {
    const platform = new FakePlatform({ tabResponses: [ARTICLE] });
    const engine = new FakeEngine(["Hello ", "world"]);
    start(platform, engine);
    const port = await summarizeAndWait(platform);
    expect(port.received).toEqual([
      { type: "phase", phase: "extracting" },
      { type: "article", title: "T", truncated: false },
      { type: "phase", phase: "summarizing" },
      { type: "chunk", text: "Hello " },
      { type: "chunk", text: "world" },
      { type: "done" },
    ]);
    expect(engine.requests[0]?.article.title).toBe("T");
  });

  it("reports empty-summary when the stream ends without any content", async () => {
    const platform = new FakePlatform({ tabResponses: [ARTICLE] });
    start(platform, new FakeEngine([]));
    const port = await summarizeAndWait(platform);
    expect(port.received.at(-1)).toMatchObject({ type: "error", code: "empty-summary" });
    expect(port.received.some((event) => event.type === "done")).toBe(false);
  });

  it("injects the content script and retries when the tab has no listener", async () => {
    const platform = new FakePlatform({
      tabResponses: [new Error("Could not establish connection"), ARTICLE],
    });
    start(platform, new FakeEngine(["ok"]));
    const port = await summarizeAndWait(platform);
    expect(platform.injectedTabs).toEqual([1]);
    expect(platform.tabMessages).toHaveLength(2);
    expect(port.received.at(-1)).toEqual({ type: "done" });
  });

  it("reports page-unsupported when injection does not help", async () => {
    const platform = new FakePlatform({
      tabResponses: [new Error("no listener"), new Error("still no listener")],
    });
    start(platform, new FakeEngine(["never"]));
    const port = await summarizeAndWait(platform);
    expect(port.received.at(-1)).toMatchObject({ type: "error", code: "page-unsupported" });
    expect(port.received.some((event) => event.type === "chunk")).toBe(false);
  });

  it("extracts the tab named in the start message instead of the active tab", async () => {
    const platform = new FakePlatform({ tabResponses: [ARTICLE] });
    start(platform, new FakeEngine(["ok"]));
    const port = platform.openPort();
    port.send({ type: "start", tabId: 42 });
    await waitFor(() => port.received.some((event) => event.type === "done" || event.type === "error"));
    expect(platform.tabMessageTargets).toEqual([42]);
    expect(port.received.at(-1)).toEqual({ type: "done" });
  });

  it("reports page-unsupported when there is no active tab", async () => {
    const platform = new FakePlatform({ activeTabId: undefined });
    start(platform, new FakeEngine());
    const port = await summarizeAndWait(platform);
    expect(port.received.at(-1)).toMatchObject({ type: "error", code: "page-unsupported" });
  });

  it("reports no-content when extraction finds nothing", async () => {
    const platform = new FakePlatform({ tabResponses: [{ ok: false, error: "no-content" }] });
    start(platform, new FakeEngine(["never"]));
    const port = await summarizeAndWait(platform);
    expect(port.received.at(-1)).toMatchObject({ type: "error", code: "no-content" });
  });

  it("forwards EngineError codes to the panel", async () => {
    const platform = new FakePlatform({ tabResponses: [ARTICLE] });
    start(platform, new FakeEngine([], new EngineError("origin-forbidden", "403")));
    const port = await summarizeAndWait(platform);
    expect(port.received.at(-1)).toEqual({ type: "error", code: "origin-forbidden", message: "403" });
  });

  it("stops posting and aborts the engine when the panel disconnects mid-stream", async () => {
    const platform = new FakePlatform({ tabResponses: [ARTICLE] });
    let release: (() => void) | undefined;
    const gate = () => new Promise<void>((resolve) => (release = resolve));
    const engine = new FakeEngine(["one", "two"], undefined, { state: "ok", models: [] }, gate);
    start(platform, engine);

    const port = platform.openPort();
    port.send({ type: "start" });
    await waitFor(() => release !== undefined);

    port.disconnect();
    expect(engine.signal?.aborted).toBe(true);

    const before = port.received.length;
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(port.received).toHaveLength(before);
    expect(port.received.some((event) => event.type === "chunk" || event.type === "done")).toBe(false);
  });
});
