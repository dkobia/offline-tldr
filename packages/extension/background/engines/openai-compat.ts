// Client for OpenAI-compatible local servers: LM Studio, llama.cpp server,
// oMLX, and anything else speaking /v1/models + /v1/chat/completions with SSE.
// LM Studio additionally reports each model's loaded context at /api/v0/models;
// oMLX reports each model's context as max_model_len in /v1/models itself.
// An API key, when configured, goes out as a bearer token on every request.

import { buildPrompt, outputTokenCap, type SummaryRequest } from "@offline-tldr/core";
import type { EngineStatus } from "@offline-tldr/shared";
import { sseData, textChunks } from "./stream";
import { EngineError, type EngineClient, type FetchFn } from "./types";

interface ModelsResponse {
  /** max_model_len is oMLX's; other servers leave it out. */
  data?: { id?: string; max_model_len?: number }[];
}

interface LmStudioModelsResponse {
  data?: { id?: string; state?: string; loaded_context_length?: number }[];
}

interface ChatCompletionChunk {
  choices?: { delta?: { content?: string } }[];
}

export class OpenAiCompatEngine implements EngineClient {
  readonly name: string;
  readonly reasoning = true;
  private readonly base: string;

  constructor(
    name: string,
    endpoint: string,
    private readonly model: string,
    // Bound: browsers throw "Illegal invocation" when fetch is called with a
    // `this` other than the global, which `this.fetchFn(...)` would do.
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
    private readonly apiKey = "",
  ) {
    this.name = name;
    // Accept endpoints pasted with or without the /v1 suffix.
    this.base = endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  /** Request init with the bearer token, when there is one, and the abort signal. */
  private init(signal?: AbortSignal, init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers);
    if (this.apiKey.length > 0) {
      headers.set("authorization", `Bearer ${this.apiKey}`);
    }
    return { ...init, headers, ...(signal ? { signal } : {}) };
  }

  /**
   * The server's error message, with the API key masked: server text reaches
   * the panel's banners and the stored tab state, and a server that echoes
   * the key it rejected must not put it on screen.
   */
  private async errorDetail(response: Response, fallback: string): Promise<string> {
    const detail = await errorDetail(response, fallback);
    return this.apiKey.length > 0 ? detail.split(this.apiKey).join("••••") : detail;
  }

  async probe(signal?: AbortSignal): Promise<EngineStatus> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}/v1/models`, this.init(signal));
    } catch (error) {
      return { state: "unreachable", detail: String(error) };
    }
    if (response.status === 401) {
      const detail = await this.errorDetail(response, "");
      return detail ? { state: "unauthorized", detail } : { state: "unauthorized" };
    }
    if (response.status === 403) {
      return { state: "forbidden" };
    }
    if (!response.ok) {
      return { state: "error", detail: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as ModelsResponse;
    const models = (body.data ?? [])
      .map((model) => model.id ?? "")
      .filter((id) => id.length > 0);
    return { state: "ok", models };
  }

  /**
   * LM Studio exposes the loaded context through its REST API, alongside the
   * OpenAI-compatible one; a model it would JIT-load on request has no known
   * context yet, so that case takes the fallback budget too. oMLX lists each
   * model's context in /v1/models, loaded or not. Other servers report none.
   */
  async contextLength(signal?: AbortSignal): Promise<number | null> {
    if (this.name === "omlx") {
      return this.omlxContextLength(signal);
    }
    if (this.name !== "lmstudio") {
      return null;
    }
    try {
      const response = await this.fetchFn(`${this.base}/api/v0/models`, this.init(signal));
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as LmStudioModelsResponse;
      const entry = (body.data ?? []).find((model) => model.id === this.model);
      if (!entry || entry.state !== "loaded") {
        return null;
      }
      const length = entry.loaded_context_length;
      return typeof length === "number" && length > 0 ? length : null;
    } catch {
      return null;
    }
  }

  private async omlxContextLength(signal?: AbortSignal): Promise<number | null> {
    try {
      const response = await this.fetchFn(`${this.base}/v1/models`, this.init(signal));
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as ModelsResponse;
      const length = (body.data ?? []).find((model) => model.id === this.model)?.max_model_len;
      return typeof length === "number" && length > 0 ? length : null;
    } catch {
      return null;
    }
  }

  async *summarize(request: SummaryRequest, signal?: AbortSignal): AsyncIterable<string> {
    const prompt = buildPrompt(request);
    const init = this.init(signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        temperature: 0.3,
        // LM Studio honors this for thinking models (measured: reasoning
        // tokens drop to ~0, summaries return in seconds instead of minutes)
        // and ignores it for non-thinking ones. Only sent to LM Studio:
        // other OpenAI-compatible servers may reject values they don't know.
        ...(this.name === "lmstudio" ? { reasoning_effort: "none" } : {}),
        // oMLX only trims thinking for reasoning_effort "none" (measured on
        // Qwen3.8-27B: 173 reasoning characters instead of 242); a zero
        // thinking budget turns it off, and non-thinking models accept it.
        ...(this.name === "omlx" ? { thinking_budget: 0 } : {}),
        // Caps runaway generations. The flat headroom inside the cap is for
        // thinking models, whose reasoning tokens count against the limit and
        // stream separately (reasoning_content), never reaching the panel: a
        // big model can spend well over a thousand tokens reasoning about a
        // full article before writing a single word of the summary.
        max_tokens: request.maxOutputTokens ?? outputTokenCap(request.maxWords),
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    });

    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}/v1/chat/completions`, init);
    } catch (error) {
      throw new EngineError("engine-unreachable", String(error));
    }
    if (response.status === 401) {
      throw new EngineError("unauthorized", await this.errorDetail(response, "The server requires an API key."));
    }
    if (response.status === 404) {
      throw new EngineError("model-missing", await this.errorDetail(response, `model "${this.model}" not found`));
    }
    if (!response.ok || !response.body) {
      throw new EngineError("engine-error", await this.errorDetail(response, `HTTP ${response.status}`));
    }

    for await (const data of sseData(textChunks(response.body))) {
      const chunk = JSON.parse(data) as ChatCompletionChunk;
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}

async function errorDetail(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    if (typeof body.error === "string") {
      return body.error;
    }
    return body.error?.message || fallback;
  } catch {
    return fallback;
  }
}
