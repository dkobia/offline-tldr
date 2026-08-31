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

/** Core's engine contract plus what the settings UI needs: reachability and models. */
export interface EngineClient extends SummarizationEngine {
  probe(signal?: AbortSignal): Promise<EngineStatus>;
}
