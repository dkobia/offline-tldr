import type { Settings } from "@offline-tldr/shared";
import { isLocalEndpoint } from "../../lib/settings";
import type { BuiltInModel } from "../../platform/types";
import { BuiltInEngine } from "./built-in";
import { OllamaEngine } from "./ollama";
import { OpenAiCompatEngine } from "./openai-compat";
import { EngineError, type EngineClient, type FetchFn } from "./types";

export { EngineError } from "./types";
export type { EngineClient } from "./types";

export interface EngineDeps {
  /** The browser's built-in model, from the platform; none on a browser without one. */
  builtIn?: BuiltInModel | undefined;
  fetchFn?: FetchFn;
}

export function createEngineClient(settings: Settings, deps: EngineDeps = {}): EngineClient {
  if (settings.engine === "builtin") {
    return new BuiltInEngine(deps.builtIn);
  }
  // Bound for the same reason as in the engine constructors: this default is
  // forwarded to them and would otherwise bypass their own bound defaults.
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  // Defense in depth: settings are normalized on every load and save, but no
  // request may ever leave the machine even if storage was tampered with.
  if (!isLocalEndpoint(settings.endpoint)) {
    throw new EngineError("engine-error", `Endpoint is not local: ${settings.endpoint}`);
  }
  if (settings.engine === "ollama") {
    return new OllamaEngine(settings.endpoint, settings.model, fetchFn);
  }
  return new OpenAiCompatEngine(settings.engine, settings.endpoint, settings.model, fetchFn);
}
