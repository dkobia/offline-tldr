// Pure view-model for the engine status UI: settings + probe result in,
// dot/button/banner description out. main.ts only renders what this returns,
// so every status branch is testable without a DOM or a platform.

import type { EngineKind, EngineStatus, Settings } from "@offline-tldr/shared";
import { ENGINE_LABELS, isModelAvailable } from "../lib/settings";

export interface Step {
  text: string;
  command?: string;
}

export type BannerBlock = { kind: "p"; text: string } | { kind: "steps"; steps: Step[] };

export interface BannerView {
  tone: "warn" | "down";
  title: string;
  blocks: BannerBlock[];
  showRetry: boolean;
}

export interface StatusView {
  dot: "ok" | "warn" | "down";
  /** Short status text shown next to the header dot. */
  label: string;
  summarizeEnabled: boolean;
  banner: BannerView | null;
}

export function statusView(settings: Settings, status: EngineStatus, platformName: "chrome" | "firefox"): StatusView {
  const label = ENGINE_LABELS[settings.engine];

  if (status.state === "ok") {
    if (settings.model.length === 0) {
      return {
        dot: "warn",
        label: "No model",
        summarizeEnabled: false,
        banner: {
          tone: "warn",
          title: `${label} is running, but no model is selected`,
          blocks: [{ kind: "p", text: "Open settings and pick a model, then come back to summarize." }],
          showRetry: false,
        },
      };
    }
    if (!isModelAvailable(settings.model, status.models, settings.engine)) {
      // Warn but keep Summarize enabled: some servers (llama.cpp) serve their
      // loaded model regardless of the requested name.
      const blocks: BannerBlock[] =
        settings.engine === "ollama"
          ? [
              { kind: "p", text: "Pick an installed model in settings, or pull it:" },
              { kind: "steps", steps: [{ text: "In a terminal:", command: `ollama pull ${settings.model}` }] },
            ]
          : [{ kind: "p", text: "Pick one of the server's models in settings, or load the model in the server first." }];
      return {
        dot: "warn",
        label: "Check model",
        summarizeEnabled: true,
        banner: {
          tone: "warn",
          title: `Model “${settings.model}” isn’t in ${label}’s model list`,
          blocks,
          showRetry: false,
        },
      };
    }
    // "Auto" tells the user the panel will summarize on its own; problem
    // states above always win over the mode label.
    return { dot: "ok", label: settings.autoSummarize ? "Auto" : "Ready", summarizeEnabled: true, banner: null };
  }

  return {
    dot: "down",
    label: "Offline",
    summarizeEnabled: false,
    banner: downBanner(settings, status, label, platformName),
  };
}

function downBanner(
  settings: Settings,
  status: Exclude<EngineStatus, { state: "ok" }>,
  label: string,
  platformName: "chrome" | "firefox",
): BannerView {
  if (status.state === "forbidden") {
    const blocks: BannerBlock[] =
      settings.engine === "ollama"
        ? [
            {
              kind: "p",
              text: "The server is running but rejects requests from browser extensions. Restart it with extension origins allowed:",
            },
            { kind: "steps", steps: [ollamaServeStep()] },
          ]
        : [
            {
              kind: "p",
              text: "The server is running but answered HTTP 403. Check its CORS and authentication settings, and make sure it allows requests from browser extensions.",
            },
          ];
    return { tone: "down", title: `${label} is blocking this extension`, blocks, showRetry: true };
  }

  if (status.state === "error") {
    return {
      tone: "down",
      title: `${label} returned an error`,
      blocks: [{ kind: "p", text: status.detail }],
      showRetry: true,
    };
  }

  const blocks: BannerBlock[] = [];
  switch (settings.engine) {
    case "ollama":
      blocks.push({
        kind: "steps",
        steps: [
          { text: "Install Ollama from ollama.com if you haven’t yet." },
          ollamaServeStep(),
          { text: "Pull a model:", command: "ollama pull llama3.2" },
        ],
      });
      break;
    case "lmstudio":
      blocks.push({
        kind: "steps",
        steps: [
          { text: "Open LM Studio and load a model." },
          { text: "In the Developer tab, start the local server (default port 1234)." },
        ],
      });
      break;
    case "llamacpp":
      blocks.push({
        kind: "steps",
        steps: [{ text: "Start the llama.cpp server:", command: "llama-server -m <model.gguf> --port 8080" }],
      });
      break;
    case "custom":
      blocks.push({
        kind: "p",
        text: "Make sure your OpenAI-compatible server is running on this endpoint, or fix the endpoint in settings.",
      });
      break;
  }
  if (platformName === "firefox") {
    blocks.push({
      kind: "p",
      text: "If it keeps failing, check that the extension is allowed to access localhost under the extension’s permissions.",
    });
  }
  if (status.detail) {
    blocks.push({ kind: "p", text: `Details: ${status.detail}` });
  }
  return { tone: "down", title: `${label} isn’t reachable at ${settings.endpoint}`, blocks, showRetry: true };
}

function ollamaServeStep(): Step {
  return {
    text: "Start Ollama so browser extensions may connect:",
    command: 'OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve',
  };
}

/** One-line status used by the settings view's "Test connection" feedback. */
export function describeStatusShort(status: EngineStatus, engine: EngineKind): string {
  const label = ENGINE_LABELS[engine];
  switch (status.state) {
    case "ok":
      return `${label} is running.`;
    case "forbidden":
      return engine === "ollama"
        ? `${label} is running but blocks browser extensions (set OLLAMA_ORIGINS).`
        : `${label} is running but answered HTTP 403 (check CORS / authentication).`;
    case "unreachable":
      return `${label} isn’t reachable at this endpoint.`;
    case "error":
      return `${label} returned an error: ${status.detail}`;
  }
}
