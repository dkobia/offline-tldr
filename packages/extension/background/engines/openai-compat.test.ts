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

  it("sends the API key as a bearer token, and no authorization header without one", async () => {
    const seen: (string | null)[] = [];
    const stub = fetchStub((_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await new OpenAiCompatEngine("omlx", "http://127.0.0.1:8000", "m", stub, "local-key").probe();
    await new OpenAiCompatEngine("llamacpp", "http://localhost:8080", "m", stub).probe();
    expect(seen).toEqual(["Bearer local-key", null]);
  });

  it("maps 401 to unauthorized, carrying the server's reason", async () => {
    const withReason = new OpenAiCompatEngine(
      "omlx",
      "http://127.0.0.1:8000",
      "m",
      fetchStub(() => new Response(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }), { status: 401 })),
      "stale",
    );
    expect(await withReason.probe()).toEqual({ state: "unauthorized", detail: "Invalid API key" });
    const bare = new OpenAiCompatEngine("custom", "http://localhost:8080", "m", fetchStub(() => new Response("", { status: 401 })));
    expect(await bare.probe()).toEqual({ state: "unauthorized" });
  });

  it("masks the API key when the server echoes it in an error", async () => {
    const echo = fetchStub(() => new Response(JSON.stringify({ error: { message: "Invalid API key: sk-secret (sk-secret)" } }), { status: 401 }));
    const engine = new OpenAiCompatEngine("omlx", "http://127.0.0.1:8000", "m", echo, "sk-secret");
    expect(await engine.probe()).toEqual({ state: "unauthorized", detail: "Invalid API key: •••• (••••)" });
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

  it("requests the planned output cap when the budget carries one", async () => {
    const engine = new OpenAiCompatEngine(
      "lmstudio",
      "http://localhost:1234",
      "phi3",
      fetchStub((_url, init) => {
        expect(JSON.parse(String(init?.body)).max_tokens).toBe(1500);
        return new Response("data: [DONE]\n\n", { status: 200 });
      }),
    );
    expect(await collect(engine.summarize({ ...request, maxOutputTokens: 1500 }))).toBe("");
  });

  it("turns oMLX's thinking off with a zero budget, and authenticates the request", async () => {
    const engine = new OpenAiCompatEngine(
      "omlx",
      "http://127.0.0.1:8000",
      "gemma",
      fetchStub((url, init) => {
        expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer local-key");
        expect(headers.get("content-type")).toBe("application/json");
        const body = JSON.parse(String(init?.body));
        expect(body.thinking_budget).toBe(0);
        expect(body).not.toHaveProperty("reasoning_effort");
        // oMLX opens every stream with an empty keepalive chunk.
        return new Response(
          [
            'data: {"model":"keepalive","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
            'data: {"model":"gemma","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
            'data: {"model":"gemma","choices":[{"index":0,"delta":{"content":"Short."}}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { status: 200 },
        );
      }),
      "local-key",
    );
    expect(await collect(engine.summarize(request))).toBe("Short.");
  });

  it("throws unauthorized with the server's reason on a 401", async () => {
    const engine = new OpenAiCompatEngine(
      "omlx",
      "http://127.0.0.1:8000",
      "gemma",
      fetchStub(() => new Response(JSON.stringify({ error: { message: "API key required" } }), { status: 401 })),
    );
    await expect(collect(engine.summarize(request))).rejects.toMatchObject({ code: "unauthorized", message: "API key required" });
  });

  it.each([401, 404, 500])("masks the API key in the summarize error for HTTP %i", async (status) => {
    const engine = new OpenAiCompatEngine(
      "custom",
      "http://localhost:8080",
      "m",
      fetchStub(() => new Response(JSON.stringify({ error: `rejected sk-secret` }), { status })),
      "sk-secret",
    );
    const error = await collect(engine.summarize(request)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "rejected ••••" });
  });

  it("omits reasoning_effort for servers other than LM Studio", async () => {
    const engine = new OpenAiCompatEngine(
      "llamacpp",
      "http://localhost:8080",
      "m",
      fetchStub((url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body).not.toHaveProperty("reasoning_effort");
        expect(body).not.toHaveProperty("thinking_budget");
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

describe("OpenAiCompatEngine.contextLength", () => {
  const models = {
    data: [
      { id: "google/gemma-4-12b", state: "loaded", max_context_length: 262144, loaded_context_length: 32768 },
      { id: "openai/gpt-oss-20b", state: "not-loaded", max_context_length: 131072 },
    ],
  };

  it("reads LM Studio's loaded context from /api/v0/models", async () => {
    const engine = new OpenAiCompatEngine(
      "lmstudio",
      "http://localhost:1234/v1",
      "google/gemma-4-12b",
      fetchStub((url) => {
        expect(url).toBe("http://localhost:1234/api/v0/models");
        return new Response(JSON.stringify(models), { status: 200 });
      }),
    );
    expect(await engine.contextLength()).toBe(32768);
  });

  it("returns null for a model LM Studio has not loaded (its JIT context is unknown)", async () => {
    const engine = new OpenAiCompatEngine(
      "lmstudio",
      "http://localhost:1234",
      "openai/gpt-oss-20b",
      fetchStub(() => new Response(JSON.stringify(models), { status: 200 })),
    );
    expect(await engine.contextLength()).toBeNull();
  });

  it("returns null when the REST endpoint is missing or unreachable", async () => {
    const notFound = new OpenAiCompatEngine("lmstudio", "http://localhost:1234", "m", fetchStub(() => new Response("", { status: 404 })));
    expect(await notFound.contextLength()).toBeNull();
    const failing = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as FetchFn;
    expect(await new OpenAiCompatEngine("lmstudio", "http://localhost:1234", "m", failing).contextLength()).toBeNull();
  });

  it("reads oMLX's max_model_len for the configured model from /v1/models, authenticated", async () => {
    const engine = new OpenAiCompatEngine(
      "omlx",
      "http://127.0.0.1:8000",
      "gemma-4-E4B-it-MLX-8bit",
      fetchStub((url, init) => {
        expect(url).toBe("http://127.0.0.1:8000/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-key");
        return new Response(
          JSON.stringify({
            data: [
              { id: "Qwen3.8-27B-MLX-8bit", max_model_len: 262144 },
              { id: "gemma-4-E4B-it-MLX-8bit", max_model_len: 131072 },
            ],
          }),
          { status: 200 },
        );
      }),
      "local-key",
    );
    expect(await engine.contextLength()).toBe(131072);
  });

  it("returns null for oMLX when the model is unlisted, reports no length, or the key is refused", async () => {
    const listing = JSON.stringify({ data: [{ id: "a", max_model_len: 8192 }, { id: "b" }] });
    const ok = fetchStub(() => new Response(listing, { status: 200 }));
    expect(await new OpenAiCompatEngine("omlx", "http://127.0.0.1:8000", "missing", ok).contextLength()).toBeNull();
    expect(await new OpenAiCompatEngine("omlx", "http://127.0.0.1:8000", "b", ok).contextLength()).toBeNull();
    const refused = fetchStub(() => new Response("", { status: 401 }));
    expect(await new OpenAiCompatEngine("omlx", "http://127.0.0.1:8000", "a", refused).contextLength()).toBeNull();
  });

  it("returns null without a request for servers other than LM Studio and oMLX", async () => {
    const engine = new OpenAiCompatEngine(
      "llamacpp",
      "http://localhost:8080",
      "m",
      fetchStub(() => {
        throw new Error("should not be called");
      }),
    );
    expect(await engine.contextLength()).toBeNull();
  });
});
