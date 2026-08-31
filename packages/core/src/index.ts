// Entry point for the summarization pipeline:
// extractArticle(document) -> fitToBudget(text) -> buildPrompt(request) -> engine.summarize(request).
// Core is pure logic: standard DOM types on documents handed to it are fine,
// chrome.* / browser.* and network calls are not.

export interface ExtractedArticle {
  /** Document title, if one could be determined. */
  title: string;
  /** Clean text body with navigation, ads, and boilerplate stripped. */
  text: string;
  /** Language hint from the document, if present (e.g. "en"). */
  lang?: string;
}

export type SummaryFormat = "bullets" | "executive" | "one-liner";

export interface SummaryRequest {
  article: ExtractedArticle;
  format: SummaryFormat;
  /** Soft cap on output length, in words. */
  maxWords: number;
}

/**
 * A local inference backend (Ollama, LM Studio, llama.cpp server, ...).
 * Core defines the contract; concrete engines live in the extension because
 * they need network access to localhost.
 */
export interface SummarizationEngine {
  readonly name: string;
  summarize(request: SummaryRequest, signal?: AbortSignal): AsyncIterable<string>;
}

export { extractArticle } from "./extract";
export { fitToBudget, DEFAULT_INPUT_CHAR_BUDGET, type FittedText } from "./chunk";
export { buildPrompt, type PromptParts } from "./prompt";
