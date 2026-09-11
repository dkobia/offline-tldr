// Client for the browser's built-in model (Chrome's Gemini Nano, through the
// Prompt API), reached through the platform's BuiltInModel seam. There is no
// server: probing asks the browser whether the model is there, and a summary
// is one session (system prompt, one streamed user prompt, destroy).
//
// The model is never downloaded from here. Chrome starts that download only
// from a page the user just interacted with, and it is a few gigabytes; the
// panel offers it, and until it is done every call fails with
// "model-unavailable".
//
// The model's context is small (a few thousand tokens), so the budget matters
// more than for the servers: contextLength() reads the session's window and
// the engine reports that it does not think, so no reasoning headroom is
// reserved out of that window.

import { buildPrompt, type SummaryRequest } from "@offline-tldr/core";
import type { EngineStatus } from "@offline-tldr/shared";
import type { BuiltInAvailability, BuiltInModel, BuiltInSession } from "../../platform/types";
import { EngineError, type EngineClient } from "./types";

/** What the status UI lists as the one model the engine has. */
export const BUILT_IN_MODEL_NAME = "Gemini Nano";

/** Why the model cannot answer right now, in the words the panel shows. */
export function unavailableMessage(availability: Exclude<BuiltInAvailability, "available">): string {
  switch (availability) {
    case "downloadable":
      return "Chrome’s built-in model isn’t downloaded yet";
    case "downloading":
      return "Chrome is still downloading its built-in model";
    case "unavailable":
      return "Chrome’s built-in model isn’t available on this device";
  }
}

export class BuiltInEngine implements EngineClient {
  readonly name = "builtin";
  /** Gemini Nano has no thinking mode; its whole window minus the summary is for the article. */
  readonly reasoning = false;

  constructor(private readonly model: BuiltInModel | undefined) {}

  async probe(): Promise<EngineStatus> {
    if (!this.model) {
      return { state: "unsupported" };
    }
    let availability: BuiltInAvailability;
    try {
      availability = await this.model.availability();
    } catch (error) {
      return { state: "error", detail: errorText(error) };
    }
    switch (availability) {
      case "available":
        return { state: "ok", models: [BUILT_IN_MODEL_NAME] };
      case "downloadable":
        return { state: "downloadable" };
      case "downloading":
        return { state: "downloading" };
      default:
        return { state: "unsupported" };
    }
  }

  /**
   * The window a session gets, read off a throwaway session. Only asked of
   * a model that is there: creating a session on one that is not would be
   * the download, which is the panel's to start. Never throws.
   */
  async contextLength(signal?: AbortSignal): Promise<number | null> {
    try {
      if (!this.model || (await this.model.availability()) !== "available") {
        return null;
      }
      const session = await this.model.create(signal ? { signal } : {});
      try {
        return session.contextWindow;
      } finally {
        session.destroy();
      }
    } catch {
      return null;
    }
  }

  async *summarize(request: SummaryRequest, signal?: AbortSignal): AsyncIterable<string> {
    const model = await this.ready();
    const prompt = buildPrompt(request);
    let session: BuiltInSession;
    try {
      session = await model.create(signal ? { system: prompt.system, signal } : { system: prompt.system });
    } catch (error) {
      throw toEngineError(error);
    }
    try {
      for await (const chunk of session.stream(prompt.user, signal)) {
        yield chunk;
      }
    } catch (error) {
      throw toEngineError(error);
    } finally {
      session.destroy();
    }
  }

  /** The model, once it is there to ask; otherwise the reason it is not, as the panel will show it. */
  private async ready(): Promise<BuiltInModel> {
    if (!this.model) {
      throw new EngineError("model-unavailable", "This browser has no built-in model");
    }
    let availability: BuiltInAvailability;
    try {
      availability = await this.model.availability();
    } catch (error) {
      throw new EngineError("engine-error", errorText(error));
    }
    if (availability !== "available") {
      throw new EngineError("model-unavailable", unavailableMessage(availability));
    }
    return this.model;
  }
}

function toEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) {
    return error;
  }
  if (error instanceof Error) {
    // The Prompt API rejects a prompt the context cannot hold with a
    // QuotaExceededError, and input it will not take with a NotSupportedError.
    if (error.name === "QuotaExceededError") {
      return new EngineError("engine-error", "The page is too long for Chrome’s built-in model.");
    }
    if (error.name === "NotSupportedError") {
      return new EngineError("engine-error", `Chrome’s built-in model refused this page (${error.message}).`);
    }
  }
  return new EngineError("engine-error", errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
