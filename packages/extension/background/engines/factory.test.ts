import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "@offline-tldr/shared";
import { createEngineClient } from "./index";
import type { FetchFn } from "./types";

const base: Settings = {
  engine: "ollama",
  endpoint: "http://localhost:11434",
  model: "llama3.2",
  format: "bullets",
  maxWords: 150,
  autoSummarize: false,
};

describe("createEngineClient", () => {
  it("creates the native client for ollama and the compat client otherwise", () => {
    expect(createEngineClient(base).name).toBe("ollama");
    expect(createEngineClient({ ...base, engine: "lmstudio", endpoint: "http://localhost:1234" }).name).toBe("lmstudio");
    expect(createEngineClient({ ...base, engine: "llamacpp", endpoint: "http://localhost:8080" }).name).toBe("llamacpp");
    expect(createEngineClient({ ...base, engine: "custom", endpoint: "http://localhost:9999" }).name).toBe("custom");
  });

  it("refuses to build a client for a non-local endpoint", () => {
    expect(() => createEngineClient({ ...base, endpoint: "http://summaries.example.com" })).toThrowError(
      /not local/,
    );
  });
});

describe("default fetch binding", () => {
  // Browsers (unlike Node) throw "Illegal invocation" when fetch is called
  // with a `this` other than the global object, e.g. via `this.fetchFn(...)`.
  // This stub reproduces that so the default-fetch path is exercised the way
  // a service worker would run it.
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each(["ollama", "lmstudio"] as const)("probes %s without an injected fetch", async (engine) => {
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        return Promise.reject(new TypeError("Illegal invocation"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ models: [], data: [] }), { status: 200 }),
      );
    } as FetchFn;

    const client = createEngineClient({ ...base, engine, endpoint: "http://localhost:11434" });
    expect(await client.probe()).toEqual({ state: "ok", models: [] });
  });
});
