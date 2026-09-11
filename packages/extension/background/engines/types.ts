import type { SummarizationEngine } from "@offline-tldr/core";
import type { EngineStatus, SummarizeErrorCode } from "@offline-tldr/shared";

/** Thrown by engine clients; the code maps 1:1 onto the summarize protocol. */
export class EngineError extends Error {
  constructor(
    readonly code: SummarizeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** Injectable fetch so engine clients are unit testable in Node. */
export type FetchFn = typeof fetch;

/** Core's engine contract plus what the settings UI and the budget need: reachability, models, context. */
export interface EngineClient extends SummarizationEngine {
  /**
   * Whether the model may spend output tokens reasoning before the summary,
   * so the budget reserves headroom for it. True for the local servers (the
   * model behind them is anyone's guess); false for the browser's built-in
   * model, which has no thinking mode.
   */
  readonly reasoning: boolean;
  probe(signal?: AbortSignal): Promise<EngineStatus>;
  /**
   * Context length in tokens of the configured model as the runtime currently
   * has it loaded, or null when the runtime does not report one. Never throws:
   * the caller falls back to a fixed budget on null.
   */
  contextLength(signal?: AbortSignal): Promise<number | null>;
}
