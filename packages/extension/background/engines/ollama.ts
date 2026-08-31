// Client for Ollama's native API (http://localhost:11434 by default).
// Probing and model listing use GET /api/tags; summarization streams NDJSON
// from POST /api/chat. A 403 means Ollama is running but rejects the
// extension's origin, which the UI turns into OLLAMA_ORIGINS instructions.

import { buildPrompt, type SummaryRequest } from "@offline-tldr/core";
import type { EngineStatus } from "@offline-tldr/shared";
import { ndjson, textChunks } from "./stream";
import { EngineError, type EngineClient, type FetchFn } from "./types";

interface OllamaTagsResponse {
  models?: { name?: string }[];
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
          // Words-to-tokens headroom so a runaway generation cannot go on
          // forever. The flat extra covers models that cannot disable thinking
          // (gpt-oss ignores think:false) and would otherwise spend the whole
          // budget reasoning.
          num_predict: request.maxWords * 4 + 4096,
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
