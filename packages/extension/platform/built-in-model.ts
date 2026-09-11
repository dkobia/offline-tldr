// Chrome's built-in model behind the BuiltInModel seam. Kept apart from
// chrome.ts so it can be exercised with a fake LanguageModel; nothing in here
// touches chrome.* either.
//
// Every session is one exchange: a system prompt at creation, one streamed
// user prompt, then destroy. Sampling matches what the HTTP engines ask of
// their servers (temperature 0.3); topK is Chrome's default, spelled out
// because Chrome wants both controls or neither.

import type { BuiltInModel, BuiltInSession, BuiltInSessionOptions } from "./types";

/** The prompts are English; telling Chrome so silences its language warning and lets it refuse cleanly. */
const TEXT_EXPECTATIONS: LanguageModelExpectation[] = [{ type: "text", languages: ["en"] }];

export function builtInModelOf(api: LanguageModelStatic | undefined): BuiltInModel {
  return {
    async availability() {
      if (!api) {
        return "unavailable";
      }
      return api.availability({ expectedInputs: TEXT_EXPECTATIONS, expectedOutputs: TEXT_EXPECTATIONS });
    },

    async create(options: BuiltInSessionOptions = {}): Promise<BuiltInSession> {
      if (!api) {
        throw new Error("This browser has no built-in model.");
      }
      const init: LanguageModelCreateOptions = {
        temperature: 0.3,
        topK: 3,
        expectedInputs: TEXT_EXPECTATIONS,
        expectedOutputs: TEXT_EXPECTATIONS,
      };
      if (options.system) {
        init.initialPrompts = [{ role: "system", content: options.system }];
      }
      if (options.signal) {
        init.signal = options.signal;
      }
      const { onProgress } = options;
      if (onProgress) {
        init.monitor = (monitor) => {
          monitor.addEventListener("downloadprogress", (event) => onProgress(downloadFraction(event)));
        };
      }
      const session = await api.create(init);
      return {
        contextWindow: contextWindowOf(session),
        stream(input, signal) {
          return readStream(session.promptStreaming(input, signal ? { signal } : {}));
        },
        destroy() {
          session.destroy();
        },
      };
    },
  };
}

/** The session's context in tokens, under whichever name this Chrome uses; null when it reports none. */
export function contextWindowOf(session: Pick<LanguageModelSession, "contextWindow" | "inputQuota">): number | null {
  const window = session.contextWindow ?? session.inputQuota;
  return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null;
}

async function* readStream(stream: ReadableStream<string>): AsyncIterable<string> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value.length > 0) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The fraction downloaded, 0 to 1. Chrome reports `loaded` as that fraction;
 * earlier builds reported bytes with a `total`, which is normalized the same way.
 */
export function downloadFraction(event: Event): number {
  const { loaded = 0, total = 0 } = event as Partial<ProgressEvent>;
  const fraction = total > 1 ? loaded / total : loaded;
  return Math.min(1, Math.max(0, fraction));
}
