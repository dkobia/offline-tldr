import { describe, expect, it, vi } from "vitest";
import { builtInModelOf, contextWindowOf, downloadFraction } from "./built-in-model";

/** Node has no ProgressEvent; a plain event carrying the same fields is what the wrapper reads. */
function progressEvent(fields: { loaded?: number; total?: number }): Event {
  return Object.assign(new Event("downloadprogress"), fields);
}

function textStream(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function fakeApi(availability: LanguageModelAvailability, chunks = ["Hello", " world"], window: Partial<LanguageModelSession> = { contextWindow: 6144 }) {
  const session: LanguageModelSession = {
    ...window,
    prompt: vi.fn(async () => chunks.join("")),
    promptStreaming: vi.fn(() => textStream(chunks)),
    destroy: vi.fn(),
  };
  const api: LanguageModelStatic = {
    availability: vi.fn(async () => availability),
    create: vi.fn(async (options?: LanguageModelCreateOptions) => {
      const monitor = new EventTarget();
      options?.monitor?.(monitor);
      monitor.dispatchEvent(progressEvent({ loaded: 0.5, total: 1 }));
      return session;
    }),
  };
  return { api, session };
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) {
    out.push(chunk);
  }
  return out;
}

describe("builtInModelOf", () => {
  it("reports an old Chrome, without the global, as unavailable and refuses to create", async () => {
    const model = builtInModelOf(undefined);
    expect(await model.availability()).toBe("unavailable");
    await expect(model.create()).rejects.toThrow("no built-in model");
  });

  it("asks for text in and out, samples like the servers, seats the system prompt first, and streams the answer", async () => {
    const { api, session } = fakeApi("available");
    const model = builtInModelOf(api);
    expect(await model.availability()).toBe("available");
    expect(api.availability).toHaveBeenCalledWith({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });

    const created = await model.create({ system: "Be terse." });
    const init = vi.mocked(api.create).mock.calls[0]![0]!;
    expect(init.initialPrompts).toEqual([{ role: "system", content: "Be terse." }]);
    expect(init).toMatchObject({ temperature: 0.3, topK: 3 });
    expect(created.contextWindow).toBe(6144);

    expect(await collect(created.stream("Hi"))).toEqual(["Hello", " world"]);
    expect(session.promptStreaming).toHaveBeenCalledWith("Hi", {});
    created.destroy();
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("passes the abort signal through and reports download progress", async () => {
    const { api, session } = fakeApi("downloadable");
    const model = builtInModelOf(api);
    const onProgress = vi.fn();
    const controller = new AbortController();
    const created = await model.create({ signal: controller.signal, onProgress });
    expect(vi.mocked(api.create).mock.calls[0]![0]!.signal).toBe(controller.signal);
    expect(onProgress).toHaveBeenCalledWith(0.5);
    await collect(created.stream("x", controller.signal));
    expect(vi.mocked(session.promptStreaming).mock.calls[0]![1]!.signal).toBe(controller.signal);
  });

  it("surfaces a stream that errors (an abort, a quota refusal) and releases the reader", async () => {
    const abort = Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
    const { api, session } = fakeApi("available");
    const failing = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("partial");
      },
      pull(controller) {
        controller.error(abort);
      },
    });
    vi.mocked(session.promptStreaming).mockReturnValueOnce(failing);
    const created = await builtInModelOf(api).create();
    const out: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of created.stream("x")) {
          out.push(chunk);
        }
      })(),
    ).rejects.toBe(abort);
    expect(out).toEqual(["partial"]);
    expect(failing.locked).toBe(false);
  });

  it("sends no system prompt when there is none, and skips empty chunks", async () => {
    const { api } = fakeApi("available", ["", "a", ""]);
    const created = await builtInModelOf(api).create();
    expect(vi.mocked(api.create).mock.calls[0]![0]!.initialPrompts).toBeUndefined();
    expect(await collect(created.stream("x"))).toEqual(["a"]);
  });

  it("reads the context window under its old name too, and reports none as null", async () => {
    const { api: old } = fakeApi("available", [], { inputQuota: 4096 });
    expect((await builtInModelOf(old).create()).contextWindow).toBe(4096);
    const { api: none } = fakeApi("available", [], {});
    expect((await builtInModelOf(none).create()).contextWindow).toBeNull();
  });
});

describe("contextWindowOf", () => {
  it("prefers the new name and rejects nonsense", () => {
    expect(contextWindowOf({ contextWindow: 6144, inputQuota: 1024 })).toBe(6144);
    expect(contextWindowOf({ inputQuota: 1024 })).toBe(1024);
    expect(contextWindowOf({ contextWindow: 0 })).toBeNull();
    expect(contextWindowOf({ contextWindow: Number.NaN })).toBeNull();
    expect(contextWindowOf({})).toBeNull();
  });
});

describe("downloadFraction", () => {
  it("reads a fraction as is and normalizes byte counts", () => {
    expect(downloadFraction(progressEvent({ loaded: 0.25 }))).toBe(0.25);
    expect(downloadFraction(progressEvent({ loaded: 1, total: 1 }))).toBe(1);
    expect(downloadFraction(progressEvent({ loaded: 500, total: 2000 }))).toBe(0.25);
    expect(downloadFraction(new Event("downloadprogress"))).toBe(0);
    expect(downloadFraction(progressEvent({ loaded: 3 }))).toBe(1);
  });
});
