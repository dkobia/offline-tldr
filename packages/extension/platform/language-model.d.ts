// Chrome's Prompt API (the LanguageModel global), as much of it as
// built-in-model.ts uses. Not in TypeScript's DOM library yet. The global
// exists in extension service workers and pages from Chrome 138.
// Reference: https://developer.chrome.com/docs/ai/prompt-api

type LanguageModelAvailability = "unavailable" | "downloadable" | "downloading" | "available";

interface LanguageModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LanguageModelExpectation {
  type: "text" | "image" | "audio";
  languages?: string[];
}

interface LanguageModelCreateOptions {
  /** A system message must be first; that is its only place. */
  initialPrompts?: LanguageModelMessage[];
  /** Sampling controls; Chrome wants both or neither. */
  temperature?: number;
  topK?: number;
  expectedInputs?: LanguageModelExpectation[];
  expectedOutputs?: LanguageModelExpectation[];
  signal?: AbortSignal;
  /** Receives "downloadprogress" events while the model is fetched. */
  monitor?: (monitor: EventTarget) => void;
}

interface LanguageModelPromptOptions {
  signal?: AbortSignal;
}

interface LanguageModelSession {
  /** The whole context in tokens. Renamed from `inputQuota`; older builds carry only the old name. */
  readonly contextWindow?: number;
  readonly inputQuota?: number;
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
  /** Text deltas of the answer; rejects a prompt the context cannot hold with a QuotaExceededError. */
  promptStreaming(input: string, options?: LanguageModelPromptOptions): ReadableStream<string>;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(options?: Pick<LanguageModelCreateOptions, "expectedInputs" | "expectedOutputs">): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare var LanguageModel: LanguageModelStatic | undefined;
