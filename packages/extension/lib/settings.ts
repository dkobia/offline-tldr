// Settings defaults and validation shared by background and panel.
// The localhost-only check enforces the project invariant that no page
// content ever leaves the device: any non-local endpoint is rejected.

import type { EngineKind, Settings } from "@offline-tldr/shared";

export const ENGINE_LABELS: Record<EngineKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp server",
  custom: "Custom (OpenAI-compatible)",
};

export const DEFAULT_ENDPOINTS: Record<EngineKind, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  llamacpp: "http://localhost:8080",
  custom: "http://localhost:8080",
};

export const DEFAULT_SETTINGS: Settings = {
  engine: "ollama",
  endpoint: DEFAULT_ENDPOINTS.ollama,
  model: "",
  format: "bullets",
  maxWords: 150,
  autoSummarize: false,
};

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
 * defaults rather than failing.
 */
export function normalizeSettings(raw: unknown): Settings {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof Settings, unknown>>;

  const engine =
    typeof input.engine === "string" && input.engine in DEFAULT_ENDPOINTS
      ? (input.engine as EngineKind)
      : DEFAULT_SETTINGS.engine;

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
    format,
    maxWords,
    autoSummarize: input.autoSummarize === true,
  };
}
