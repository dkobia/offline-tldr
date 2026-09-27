// Pure view-model for the engine status UI: settings + probe result in,
// dot/button/banner description out. main.ts only renders what this returns,
// so every status branch is testable without a DOM or a platform.

import type { EngineKind, EngineStatus, Settings } from "@offline-tldr/shared";
import { ENGINE_LABELS, isModelAvailable, isServerEngine } from "../lib/settings";

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
  /** Offer to download the browser's built-in model; the click is the user gesture Chrome wants for that. */
  showDownload: boolean;
}

export interface StatusView {
  /** "probing" pulses: something is in progress (the built-in model downloading). */
  dot: "ok" | "warn" | "down" | "probing";
  /** Short status text shown next to the header dot. */
  label: string;
  summarizeEnabled: boolean;
  banner: BannerView | null;
}

/** A download of the built-in model that this panel is running: how far it is, or how it failed. */
export type DownloadState = { progress: number } | { failed: string };

/**
 * What the header reflects. A download this panel runs owns the built-in
 * engine's status (its progress, or its failure) until it is done; the
 * probe's answer stands for everything else, so switching to a server
 * mid-download shows that server's status, not the download's.
 */
export function effectiveStatus(settings: Settings, probed: EngineStatus | null, download: DownloadState | null): EngineStatus | null {
  if (!download || isServerEngine(settings.engine)) {
    return probed;
  }
  return "failed" in download ? { state: "error", detail: download.failed } : { state: "downloading", progress: download.progress };
}

/** How the browser's built-in model is called in status copy, whatever the engine label says. */
const BUILT_IN = "Chrome’s built-in model";

export function statusView(settings: Settings, status: EngineStatus, platformName: "chrome" | "firefox"): StatusView {
  const label = ENGINE_LABELS[settings.engine];
  // "Auto" tells the user the panel will summarize on its own; problem
  // states always win over the mode label.
  const ready: StatusView = { dot: "ok", label: settings.autoSummarize ? "Auto" : "Ready", summarizeEnabled: true, banner: null };

  if (status.state === "ok") {
    if (!isServerEngine(settings.engine)) {
      // The built-in model is the one model there is; nothing to pick.
      return ready;
    }
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
          showDownload: false,
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
          showDownload: false,
        },
      };
    }
    return ready;
  }

  if (status.state === "downloadable") {
    return {
      dot: "warn",
      label: "No model",
      summarizeEnabled: false,
      banner: {
        tone: "warn",
        title: `${BUILT_IN} isn’t downloaded yet`,
        blocks: [
          {
            kind: "p",
            text: "Chrome downloads Gemini Nano once (a few gigabytes) and keeps it for every site and extension that uses it. It runs inside Chrome on this device; page text is never sent anywhere.",
          },
        ],
        showRetry: false,
        showDownload: true,
      },
    };
  }

  if (status.state === "downloading") {
    // Progress is known only to the panel that started the download; another
    // page or extension may have started it, and then the panel can only ask again.
    const known = status.progress !== undefined;
    const percent = Math.floor((status.progress ?? 0) * 100);
    return {
      dot: "probing",
      label: known ? `Downloading ${percent}%` : "Downloading",
      summarizeEnabled: false,
      banner: {
        tone: "warn",
        title: "Chrome is downloading its built-in model",
        blocks: [
          { kind: "p", text: known ? `${percent}% downloaded. Summarizing unlocks when it finishes.` : "This can take a while on a slow connection. Summarizing unlocks when it finishes." },
        ],
        showRetry: !known,
        showDownload: false,
      },
    };
  }

  if (status.state === "unsupported") {
    return {
      dot: "down",
      label: "Unavailable",
      summarizeEnabled: false,
      banner: {
        tone: "down",
        title: `${BUILT_IN} isn’t available on this device`,
        blocks: [
          {
            kind: "p",
            text: "It needs Chrome 138 or newer on Windows 10, macOS 13, Linux, or ChromeOS, about 22 GB of free disk space, and either a GPU with more than 4 GB of memory or 16 GB of RAM with 4 cores.",
          },
          { kind: "p", text: "To summarize anyway, pick Ollama, LM Studio, or another local server in settings." },
        ],
        showRetry: true,
        showDownload: false,
      },
    };
  }

  if (status.state === "unauthorized") {
    // The server is up and answering; it only wants a (valid) key.
    return {
      dot: "down",
      label: settings.apiKey ? "Key rejected" : "Needs key",
      summarizeEnabled: false,
      banner: unauthorizedBanner(settings, status, label),
    };
  }

  // A server that is down is "Offline"; the built-in model can only error
  // (a failed download, a refusal), and is not a server that could be off.
  const server = isServerEngine(settings.engine);
  return {
    dot: "down",
    label: server ? "Offline" : "Error",
    summarizeEnabled: false,
    banner: downBanner(settings, status, server ? label : BUILT_IN, platformName),
  };
}

function unauthorizedBanner(settings: Settings, status: Extract<EngineStatus, { state: "unauthorized" }>, label: string): BannerView {
  const blocks: BannerBlock[] =
    settings.engine === "omlx"
      ? [
          {
            kind: "steps",
            steps: [
              { text: `Copy the API key from oMLX’s settings, or from its admin page at ${settings.endpoint}/admin.` },
              { text: "It is also stored as auth.api_key in:", command: "~/.omlx/settings.json" },
              { text: "Paste it under API key in settings." },
            ],
          },
        ]
      : [
          {
            kind: "p",
            text: "Enter the key the server was started with (for llama.cpp, its --api-key) under API key in settings.",
          },
        ];
  if (status.detail) {
    blocks.push({ kind: "p", text: `Details: ${status.detail}` });
  }
  const title = settings.apiKey ? `${label} rejected the API key` : `${label} needs an API key`;
  return { tone: "down", title, blocks, showRetry: true, showDownload: false };
}

function downBanner(
  settings: Settings,
  status: Extract<EngineStatus, { state: "unreachable" | "forbidden" | "error" }>,
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
    return { tone: "down", title: `${label} is blocking this extension`, blocks, showRetry: true, showDownload: false };
  }

  if (status.state === "error") {
    return {
      tone: "down",
      title: `${label} returned an error`,
      blocks: [{ kind: "p", text: status.detail }],
      showRetry: true,
      showDownload: false,
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
    case "omlx":
      blocks.push({
        kind: "steps",
        steps: [
          { text: "Install oMLX from omlx.ai if you haven’t yet." },
          { text: "Open oMLX and start the server (default port 8000)." },
        ],
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
  return { tone: "down", title: `${label} isn’t reachable at ${settings.endpoint}`, blocks, showRetry: true, showDownload: false };
}

function ollamaServeStep(): Step {
  return {
    text: "Start Ollama so browser extensions may connect:",
    command: 'OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve',
  };
}

/** One-line status used by the settings view's "Test connection" / "Check model" feedback. */
export function describeStatusShort(status: EngineStatus, engine: EngineKind): string {
  const label = ENGINE_LABELS[engine];
  switch (status.state) {
    case "ok":
      return isServerEngine(engine) ? `${label} is running.` : `${BUILT_IN} is ready.`;
    case "downloadable":
      return `${BUILT_IN} isn’t downloaded yet. Download it from the status at the top.`;
    case "downloading":
      return "Chrome is downloading its built-in model.";
    case "unsupported":
      return `${BUILT_IN} isn’t available on this device.`;
    case "forbidden":
      return engine === "ollama"
        ? `${label} is running but blocks browser extensions (set OLLAMA_ORIGINS).`
        : `${label} is running but answered HTTP 403 (check CORS / authentication).`;
    case "unauthorized":
      return `${label} is running but needs a valid API key.`;
    case "unreachable":
      return `${label} isn’t reachable at this endpoint.`;
    case "error":
      return `${label} returned an error: ${status.detail}`;
  }
}
