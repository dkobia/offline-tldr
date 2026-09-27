// Settings defaults and validation shared by background and panel.
// The localhost-only check enforces the project invariant that no page
// content ever leaves the device: any non-local endpoint is rejected. The
// browser's built-in model needs no endpoint and no model name; it is the
// default wherever the browser has one, so a fresh install summarizes
// without installing anything.

import type { EngineKind, Settings } from "@offline-tldr/shared";

export const ENGINE_LABELS: Record<EngineKind, string> = {
  builtin: "Chrome built-in (Gemini Nano)",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp server",
  omlx: "oMLX",
  custom: "Custom (OpenAI-compatible)",
};

/** The built-in model has no endpoint; Ollama's stands in so switching to a server prefills the usual one. */
export const DEFAULT_ENDPOINTS: Record<EngineKind, string> = {
  builtin: "http://localhost:11434",
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  llamacpp: "http://localhost:8080",
  // oMLX binds 127.0.0.1 (not ::1) and shows this address in its own UI.
  omlx: "http://127.0.0.1:8000",
  custom: "http://localhost:8080",
};

/** The defaults where the browser has no built-in model; see defaultSettings. */
export const DEFAULT_SETTINGS: Settings = {
  engine: "ollama",
  endpoint: DEFAULT_ENDPOINTS.ollama,
  model: "",
  apiKey: "",
  format: "bullets",
  maxWords: 150,
  autoSummarize: false,
};

/** What a fresh install uses: the browser's built-in model when it has one, otherwise Ollama. */
export function defaultSettings(builtIn: boolean): Settings {
  return builtIn ? { ...DEFAULT_SETTINGS, engine: "builtin", endpoint: DEFAULT_ENDPOINTS.builtin } : DEFAULT_SETTINGS;
}

/** The engines the settings may offer: the built-in model only where the browser has one. */
export function availableEngines(builtIn: boolean): EngineKind[] {
  const kinds = Object.keys(ENGINE_LABELS) as EngineKind[];
  return builtIn ? kinds : kinds.filter((kind) => kind !== "builtin");
}

/** Whether the engine is a local server the user runs, with an endpoint and a model name to pick. */
export function isServerEngine(engine: EngineKind): boolean {
  return engine !== "builtin";
}

/**
 * Whether the engine can take an API key: the OpenAI-compatible servers,
 * which accept a bearer token (oMLX requires one). Ollama has no auth and the
 * built-in model no server.
 */
export function acceptsApiKey(engine: EngineKind): boolean {
  return isServerEngine(engine) && engine !== "ollama";
}

export const MIN_MAX_WORDS = 30;
export const MAX_MAX_WORDS = 600;

// Kept in exact sync with host_permissions in manifests/base.json: an endpoint
// the manifest does not grant would probe as "unreachable" and confuse users.
// IPv6 ([::1]) is excluded because match-pattern support for it is unreliable.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** True only for http(s) URLs whose host is the local machine. */
export function isLocalEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  return LOCAL_HOSTNAMES.has(url.hostname);
}

/**
 * Whether the configured model appears in the server's model list.
 * Only Ollama resolves a bare name to the ":latest" tag ("llama3.2" matches a
 * listed "llama3.2:latest"); OpenAI-compatible servers require exact ids.
 * An empty list means the server could not tell us what it offers (or lists
 * nothing); that is treated as unknown, not missing, because e.g. llama.cpp
 * serves its loaded model regardless of the name sent.
 */
export function isModelAvailable(model: string, models: string[], engine: EngineKind): boolean {
  if (models.length === 0) {
    return true;
  }
  if (models.includes(model)) {
    return true;
  }
  return engine === "ollama" && models.includes(`${model}:latest`);
}

/**
 * Coerces whatever came out of storage (possibly from an older version, or
 * hand-edited) into a valid Settings object. Invalid fields fall back to
 * `defaults` (the platform's, from defaultSettings) rather than failing.
 */
export function normalizeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof Settings, unknown>>;

  const engine =
    typeof input.engine === "string" && input.engine in DEFAULT_ENDPOINTS
      ? (input.engine as EngineKind)
      : defaults.engine;

  const endpoint =
    typeof input.endpoint === "string" && isLocalEndpoint(input.endpoint)
      ? input.endpoint.replace(/\/+$/, "")
      : DEFAULT_ENDPOINTS[engine];

  const format =
    input.format === "bullets" || input.format === "executive" || input.format === "one-liner"
      ? input.format
      : DEFAULT_SETTINGS.format;

  const maxWords =
    typeof input.maxWords === "number" && Number.isFinite(input.maxWords)
      ? Math.min(MAX_MAX_WORDS, Math.max(MIN_MAX_WORDS, Math.round(input.maxWords)))
      : DEFAULT_SETTINGS.maxWords;

  return {
    engine,
    endpoint,
    model: typeof input.model === "string" ? input.model : "",
    // Dropped for engines that take none, so it is never sent where it doesn't belong.
    apiKey: typeof input.apiKey === "string" && acceptsApiKey(engine) ? input.apiKey.trim() : "",
    format,
    maxWords,
    autoSummarize: input.autoSummarize === true,
  };
}
