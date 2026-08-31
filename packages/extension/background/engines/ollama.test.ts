import { describe, expect, it } from "vitest";
import type { SummaryRequest } from "@offline-tldr/core";
import { OllamaEngine } from "./ollama";
import { EngineError, type FetchFn } from "./types";

const request: SummaryRequest = {
  article: { title: "T", text: "Some article text." },
  format: "bullets",
  maxWords: 100,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function streamResponse(lines: string[]): Response {
  return new Response(lines.join(""), { status: 200 });
}

function fetchStub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchFn {
  return ((url: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as FetchFn;
}

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iterable) {
    out += chunk;
  }
  return out;
}

describe("OllamaEngine.probe", () => {
  it("reports ok with the model list from /api/tags", async () => {
    const engine = new OllamaEngine(
      "http://localhost:11434",
      "llama3.2",
      fetchStub((url) => {
        expect(url).toBe("http://localhost:11434/api/tags");
        return jsonResponse(200, { models: [{ name: "llama3.2:latest" }, { name: "phi3:latest" }] });
      }),
    );
    expect(await engine.probe()).toEqual({ state: "ok", models: ["llama3.2:latest", "phi3:latest"] });
  });

  it("maps 403 to forbidden (OLLAMA_ORIGINS)", async () => {
    const engine = new OllamaEngine("http://localhost:11434", "m", fetchStub(() => jsonResponse(403, {})));
    expect(await engine.probe()).toEqual({ state: "forbidden" });
  });

  it("reports unreachable when fetch rejects", async () => {
    const failing = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as FetchFn;
    const engine = new OllamaEngine("http://localhost:11434", "m", failing);
    const status = await engine.probe();
    expect(status.state).toBe("unreachable");
  });
});

describe("OllamaEngine.summarize", () => {
  it("streams message content from NDJSON lines", async () => {
    const engine = new OllamaEngine(
      "http://localhost:11434",
      "llama3.2",
      fetchStub((url, init) => {
        expect(url).toBe("http://localhost:11434/api/chat");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("llama3.2");
        expect(body.stream).toBe(true);
        expect(body.think).toBe(false);
        // Reasoning headroom for models that cannot disable thinking.
        expect(body.options.num_predict).toBe(100 * 4 + 4096);
        expect(body.messages).toHaveLength(2);
        return streamResponse([
          '{"message":{"content":"Hel"},"done":false}\n',
          '{"message":{"content":"lo"},"done":false}\n',
          '{"message":{"content":""},"done":true}\n',
        ]);
      }),
    );
    expect(await collect(engine.summarize(request))).toBe("Hello");
  });

  it("throws model-missing on 404", async () => {
    const engine = new OllamaEngine(
      "http://localhost:11434",
      "nope",
      fetchStub(() => jsonResponse(404, { error: 'model "nope" not found' })),
    );
    await expect(collect(engine.summarize(request))).rejects.toMatchObject({
      code: "model-missing",
      message: 'model "nope" not found',
    });
  });

  it("throws origin-forbidden on 403", async () => {
    const engine = new OllamaEngine("http://localhost:11434", "m", fetchStub(() => jsonResponse(403, {})));
    await expect(collect(engine.summarize(request))).rejects.toMatchObject({ code: "origin-forbidden" });
  });

  it("throws engine-error when a stream line carries an error", async () => {
    const engine = new OllamaEngine(
      "http://localhost:11434",
      "m",
      fetchStub(() => streamResponse(['{"error":"out of memory"}\n'])),
    );
    const failure = await collect(engine.summarize(request)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineError);
    expect((failure as EngineError).message).toBe("out of memory");
  });
});
