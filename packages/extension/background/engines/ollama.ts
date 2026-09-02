// Client for Ollama's native API (http://localhost:11434 by default).
// Probing and model listing use GET /api/tags; the loaded context comes from
// GET /api/ps; summarization streams NDJSON from POST /api/chat. A 403 means
// Ollama is running but rejects the extension's origin, which the UI turns
// into OLLAMA_ORIGINS instructions.

import { buildPrompt, outputTokenCap, type SummaryRequest } from "@offline-tldr/core";
import type { EngineStatus } from "@offline-tldr/shared";
import { ndjson, textChunks } from "./stream";
import { EngineError, type EngineClient, type FetchFn } from "./types";

interface OllamaTagsResponse {
  models?: { name?: string }[];
}

interface OllamaPsResponse {
  models?: { name?: string; context_length?: number }[];
}

interface OllamaChatLine {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

export class OllamaEngine implements EngineClient {
  readonly name = "ollama";

  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    // Bound: browsers throw "Illegal invocation" when fetch is called with a
    // `this` other than the global, which `this.fetchFn(...)` would do.
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {}

  async probe(signal?: AbortSignal): Promise<EngineStatus> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.endpoint}/api/tags`, signal ? { signal } : {});
    } catch (error) {
      return { state: "unreachable", detail: String(error) };
    }
    if (response.status === 403) {
      return { state: "forbidden" };
    }
    if (!response.ok) {
      return { state: "error", detail: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as OllamaTagsResponse;
    const models = (body.models ?? [])
      .map((model) => model.name ?? "")
      .filter((name) => name.length > 0);
    return { state: "ok", models };
  }

  /**
   * The context Ollama loaded the model with, which is what the prompt must
   * fit: a num_ctx that differs from it would force a reload on every
   * request. An unloaded model is loaded first (the documented empty-messages
   * chat call) so the budget is deterministic across idle unloads; the
   * summarize request would have paid for that load anyway.
   */
  async contextLength(signal?: AbortSignal): Promise<number | null> {
    try {
      const loaded = await this.loadedContextLength(signal);
      if (loaded !== undefined) {
        return loaded;
      }
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, messages: [] }),
      };
      if (signal) {
        init.signal = signal;
      }
      const response = await this.fetchFn(`${this.endpoint}/api/chat`, init);
      if (!response.ok) {
        return null;
      }
      return (await this.loadedContextLength(signal)) ?? null;
    } catch {
      return null;
    }
  }

  /** Undefined when the model is not loaded; null when loaded but the field is missing (old Ollama). */
  private async loadedContextLength(signal?: AbortSignal): Promise<number | null | undefined> {
    const response = await this.fetchFn(`${this.endpoint}/api/ps`, signal ? { signal } : {});
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as OllamaPsResponse;
    // An untagged name in settings ("llama3.2") is loaded as "llama3.2:latest".
    const entry = (body.models ?? []).find((model) => model.name === this.model || model.name === `${this.model}:latest`);
    if (!entry) {
      return undefined;
    }
    return typeof entry.context_length === "number" && entry.context_length > 0 ? entry.context_length : null;
  }

  async *summarize(request: SummaryRequest, signal?: AbortSignal): AsyncIterable<string> {
    const prompt = buildPrompt(request);
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        // Thinking models otherwise spend the whole num_predict budget on
        // reasoning tokens and return an empty summary. Non-thinking models
        // ignore the flag.
        think: false,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        options: {
          temperature: 0.3,
          // Runaway guard; the flat headroom inside the cap covers models that
          // cannot disable thinking (gpt-oss ignores think:false).
          num_predict: request.maxOutputTokens ?? outputTokenCap(request.maxWords),
        },
      }),
    };
    if (signal) {
      init.signal = signal;
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.endpoint}/api/chat`, init);
    } catch (error) {
      throw new EngineError("engine-unreachable", String(error));
    }
    if (response.status === 403) {
      throw new EngineError("origin-forbidden", "Ollama rejected the extension's origin.");
    }
    if (response.status === 404) {
      throw new EngineError("model-missing", await errorDetail(response, `model "${this.model}" not found`));
    }
    if (!response.ok || !response.body) {
      throw new EngineError("engine-error", await errorDetail(response, `HTTP ${response.status}`));
    }

    for await (const raw of ndjson(textChunks(response.body))) {
      const line = raw as OllamaChatLine;
      if (line.error) {
        throw new EngineError("engine-error", line.error);
      }
      const content = line.message?.content;
      if (content) {
        yield content;
      }
      if (line.done) {
        return;
      }
    }
  }
}

async function errorDetail(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}
