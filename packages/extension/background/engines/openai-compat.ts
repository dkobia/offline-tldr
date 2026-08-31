// Client for OpenAI-compatible local servers: LM Studio, llama.cpp server,
// and anything else speaking /v1/models + /v1/chat/completions with SSE.

import { buildPrompt, type SummaryRequest } from "@offline-tldr/core";
import type { EngineStatus } from "@offline-tldr/shared";
import { sseData, textChunks } from "./stream";
import { EngineError, type EngineClient, type FetchFn } from "./types";

interface ModelsResponse {
  data?: { id?: string }[];
}

interface ChatCompletionChunk {
  choices?: { delta?: { content?: string } }[];
}

export class OpenAiCompatEngine implements EngineClient {
  readonly name: string;
  private readonly base: string;

  constructor(
    name: string,
    endpoint: string,
    private readonly model: string,
    // Bound: browsers throw "Illegal invocation" when fetch is called with a
    // `this` other than the global, which `this.fetchFn(...)` would do.
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {
    this.name = name;
    // Accept endpoints pasted with or without the /v1 suffix.
    this.base = endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  async probe(signal?: AbortSignal): Promise<EngineStatus> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}/v1/models`, signal ? { signal } : {});
    } catch (error) {
      return { state: "unreachable", detail: String(error) };
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

  async *summarize(request: SummaryRequest, signal?: AbortSignal): AsyncIterable<string> {
    const prompt = buildPrompt(request);
    const init: RequestInit = {
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
        // Caps runaway generations. The flat headroom is for thinking models,
        // whose reasoning tokens count against the limit and stream separately
        // (reasoning_content), never reaching the panel: a big model can spend
        // well over a thousand tokens reasoning about a full article before
        // writing a single word of the summary.
        max_tokens: request.maxWords * 4 + 4096,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    };
    if (signal) {
      init.signal = signal;
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}/v1/chat/completions`, init);
    } catch (error) {
      throw new EngineError("engine-unreachable", String(error));
    }
    if (response.status === 404) {
      throw new EngineError("model-missing", await errorDetail(response, `model "${this.model}" not found`));
    }
    if (!response.ok || !response.body) {
      throw new EngineError("engine-error", await errorDetail(response, `HTTP ${response.status}`));
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
