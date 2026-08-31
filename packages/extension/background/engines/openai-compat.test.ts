import { describe, expect, it } from "vitest";
import type { SummaryRequest } from "@offline-tldr/core";
import { OpenAiCompatEngine } from "./openai-compat";
import type { FetchFn } from "./types";

const request: SummaryRequest = {
  article: { title: "T", text: "Some article text." },
  format: "executive",
  maxWords: 120,
};

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

describe("OpenAiCompatEngine.probe", () => {
  it("reports ok with model ids from /v1/models", async () => {
    const engine = new OpenAiCompatEngine(
      "lmstudio",
      "http://localhost:1234",
      "phi3",
      fetchStub((url) => {
        expect(url).toBe("http://localhost:1234/v1/models");
        return new Response(JSON.stringify({ data: [{ id: "phi3" }, { id: "mistral" }] }), { status: 200 });
      }),
    );
    expect(await engine.probe()).toEqual({ state: "ok", models: ["phi3", "mistral"] });
  });

  it("does not duplicate /v1 when the endpoint already includes it", async () => {
    const engine = new OpenAiCompatEngine(
      "custom",
      "http://localhost:8080/v1",
      "m",
      fetchStub((url) => {
        expect(url).toBe("http://localhost:8080/v1/models");
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    expect(await engine.probe()).toEqual({ state: "ok", models: [] });
  });

  it("maps 403 to forbidden so the UI can show engine-appropriate guidance", async () => {
    const engine = new OpenAiCompatEngine(
      "lmstudio",
      "http://localhost:1234",
      "phi3",
      fetchStub(() => new Response("", { status: 403 })),
    );
    expect(await engine.probe()).toEqual({ state: "forbidden" });
  });

  it("reports unreachable when fetch rejects", async () => {
    const failing = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as FetchFn;
    const engine = new OpenAiCompatEngine("llamacpp", "http://localhost:8080", "m", failing);
    const status = await engine.probe();
    expect(status.state).toBe("unreachable");
  });
});

describe("OpenAiCompatEngine.summarize", () => {
  it("streams delta content from SSE chunks until [DONE]", async () => {
    const engine = new OpenAiCompatEngine(
      "lmstudio",
      "http://localhost:1234",
      "phi3",
      fetchStub((url, init) => {
        expect(url).toBe("http://localhost:1234/v1/chat/completions");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("phi3");
        expect(body.stream).toBe(true);
        // Reasoning headroom: thinking models burn tokens before any content.
        expect(body.max_tokens).toBe(120 * 4 + 4096);
        // LM Studio gets thinking disabled for fast summaries.
        expect(body.reasoning_effort).toBe("none");
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"Sum"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"mary"}}]}\n\n',
            'data: {"choices":[{"delta":{}}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { status: 200 },
        );
      }),
    );
    expect(await collect(engine.summarize(request))).toBe("Summary");
  });

  it("omits reasoning_effort for servers other than LM Studio", async () => {
    const engine = new OpenAiCompatEngine(
      "llamacpp",
      "http://localhost:8080",
      "m",
      fetchStub((url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body).not.toHaveProperty("reasoning_effort");
        return new Response("data: [DONE]\n\n", { status: 200 });
      }),
    );
    expect(await collect(engine.summarize(request))).toBe("");
  });

  it("throws engine-error with the server's message on a non-OK response", async () => {
    const engine = new OpenAiCompatEngine(
      "lmstudio",
      "http://localhost:1234",
      "phi3",
      fetchStub(() => new Response(JSON.stringify({ error: { message: "no model loaded" } }), { status: 400 })),
    );
    await expect(collect(engine.summarize(request))).rejects.toMatchObject({
      code: "engine-error",
      message: "no model loaded",
    });
  });
});
