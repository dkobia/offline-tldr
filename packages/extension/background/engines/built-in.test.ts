import type { SummaryRequest } from "@offline-tldr/core";
import { describe, expect, it, vi } from "vitest";
import type { BuiltInAvailability, BuiltInModel, BuiltInSession, BuiltInSessionOptions } from "../../platform/types";
import { BuiltInEngine } from "./built-in";
import { createEngineClient } from "./index";

const request: SummaryRequest = {
  article: { title: "T", text: "Some article text." },
  format: "bullets",
  maxWords: 100,
};

interface Exchange {
  options: BuiltInSessionOptions;
  user: string;
  signal: AbortSignal | undefined;
}

function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** A model that streams `chunks` for each prompt (or throws) and records every exchange and destroy. */
function fakeModel(
  availability: BuiltInAvailability,
  answer: (exchange: Exchange) => string[] | Error = () => ["Hello", " world"],
  contextWindow: number | null = 6144,
) {
  const exchanges: Exchange[] = [];
  let created = 0;
  let destroyed = 0;
  const model: BuiltInModel = {
    availability: vi.fn(async () => availability),
    create: vi.fn(async (options = {}): Promise<BuiltInSession> => {
      created++;
      return {
        contextWindow,
        async *stream(user, signal) {
          const exchange: Exchange = { options, user, signal };
          exchanges.push(exchange);
          const result = answer(exchange);
          if (result instanceof Error) {
            throw result;
          }
          yield* result;
        },
        destroy: () => void destroyed++,
      };
    }),
  };
  return { model, exchanges, created: () => created, destroyed: () => destroyed };
}

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iterable) {
    out += chunk;
  }
  return out;
}

describe("BuiltInEngine", () => {
  it("does not reason, so the budget reserves no thinking headroom", () => {
    expect(new BuiltInEngine(undefined).reasoning).toBe(false);
  });

  it("probes the browser's availability into engine states", async () => {
    expect(await new BuiltInEngine(undefined).probe()).toEqual({ state: "unsupported" });
    for (const [availability, state] of [
      ["available", { state: "ok", models: ["Gemini Nano"] }],
      ["downloadable", { state: "downloadable" }],
      ["downloading", { state: "downloading" }],
      ["unavailable", { state: "unsupported" }],
    ] as const) {
      expect(await new BuiltInEngine(fakeModel(availability).model).probe()).toEqual(state);
    }
    const failing: BuiltInModel = { availability: async () => Promise.reject(new Error("boom")), create: vi.fn() };
    expect(await new BuiltInEngine(failing).probe()).toEqual({ state: "error", detail: "boom" });
  });

  it("reads the context window off a throwaway session, only when the model is there", async () => {
    const { model, created, destroyed } = fakeModel("available");
    expect(await new BuiltInEngine(model).contextLength()).toBe(6144);
    expect(created()).toBe(1);
    expect(destroyed()).toBe(1);
    expect(vi.mocked(model.create).mock.calls[0]![0]).toEqual({});

    const { model: unknown } = fakeModel("available", undefined, null);
    expect(await new BuiltInEngine(unknown).contextLength()).toBeNull();

    // A model that is not there must not be created: that would be the download.
    const { model: downloadable } = fakeModel("downloadable");
    expect(await new BuiltInEngine(downloadable).contextLength()).toBeNull();
    expect(downloadable.create).not.toHaveBeenCalled();
    expect(await new BuiltInEngine(undefined).contextLength()).toBeNull();

    const broken: BuiltInModel = { availability: async () => "available", create: async () => Promise.reject(new Error("no")) };
    expect(await new BuiltInEngine(broken).contextLength()).toBeNull();
  });

  it("summarizes in one session: system prompt at creation, the user prompt streamed, then destroy", async () => {
    const { model, exchanges, destroyed } = fakeModel("available");
    const engine = new BuiltInEngine(model);
    const signal = new AbortController().signal;
    expect(await collect(engine.summarize(request, signal))).toBe("Hello world");
    expect(exchanges).toHaveLength(1);
    const [exchange] = exchanges;
    expect(exchange!.options.system).toContain("summarization assistant");
    expect(exchange!.options.signal).toBe(signal);
    expect(exchange!.user).toContain("Some article text.");
    expect(exchange!.user).toContain("Title: T");
    expect(exchange!.signal).toBe(signal);
    expect(destroyed()).toBe(1);
  });

  it("destroys the session when the consumer stops early", async () => {
    const { model, destroyed } = fakeModel("available", () => ["a", "b", "c"]);
    for await (const chunk of new BuiltInEngine(model).summarize(request)) {
      if (chunk === "a") {
        break;
      }
    }
    expect(destroyed()).toBe(1);
  });

  it("refuses with model-unavailable until the model is there, without creating a session", async () => {
    for (const [availability, message] of [
      ["downloadable", "Chrome’s built-in model isn’t downloaded yet"],
      ["downloading", "Chrome is still downloading its built-in model"],
      ["unavailable", "Chrome’s built-in model isn’t available on this device"],
    ] as const) {
      const { model } = fakeModel(availability);
      await expect(collect(new BuiltInEngine(model).summarize(request))).rejects.toMatchObject({ code: "model-unavailable", message });
      expect(model.create).not.toHaveBeenCalled();
    }
    await expect(collect(new BuiltInEngine(undefined).summarize(request))).rejects.toMatchObject({ code: "model-unavailable" });
  });

  it("explains a page the context cannot hold, one the model refuses, and wraps other failures", async () => {
    const { model: full, destroyed } = fakeModel("available", () => namedError("QuotaExceededError", "too big"));
    await expect(collect(new BuiltInEngine(full).summarize(request))).rejects.toMatchObject({
      code: "engine-error",
      message: "The page is too long for Chrome’s built-in model.",
    });
    expect(destroyed()).toBe(1);

    const { model: refusing } = fakeModel("available", () => namedError("NotSupportedError", "language"));
    await expect(collect(new BuiltInEngine(refusing).summarize(request))).rejects.toMatchObject({
      code: "engine-error",
      message: "Chrome’s built-in model refused this page (language).",
    });

    const { model: broken } = fakeModel("available", () => new Error("model crashed"));
    await expect(collect(new BuiltInEngine(broken).summarize(request))).rejects.toMatchObject({ code: "engine-error", message: "model crashed" });

    const failingCreate: BuiltInModel = { availability: async () => "available", create: async () => Promise.reject(new Error("no session")) };
    await expect(collect(new BuiltInEngine(failingCreate).summarize(request))).rejects.toMatchObject({ code: "engine-error", message: "no session" });
  });
});

describe("createEngineClient", () => {
  it("builds the built-in engine without touching the endpoint", () => {
    const { model } = fakeModel("available");
    const settings = { engine: "builtin" as const, endpoint: "https://not-local.example", model: "", apiKey: "", format: "bullets" as const, maxWords: 150, autoSummarize: false };
    expect(createEngineClient(settings, { builtIn: model })).toBeInstanceOf(BuiltInEngine);
    expect(createEngineClient(settings).name).toBe("builtin");
  });
});
