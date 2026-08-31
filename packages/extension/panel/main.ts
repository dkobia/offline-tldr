// Panel entry point: summary view + settings view.
// Talks to the background via one-shot messages (settings, engine probe) and
// a long-lived port for the streamed summary.

import { platform } from "@platform";
import {
  SUMMARIZE_PORT,
  type EngineKind,
  type EngineStatus,
  type GetActivePageResponse,
  type GetSettingsResponse,
  type ProbeEngineResponse,
  type Settings,
  type SummarizeErrorCode,
  type SummarizeEvent,
  type SummarizeStart,
} from "@offline-tldr/shared";
import { DEFAULT_ENDPOINTS, ENGINE_LABELS, isLocalEndpoint, normalizeSettings } from "../lib/settings";
import { createAutoRun } from "./auto";
import { describeStatusShort, statusView } from "./status-view";
import { renderMarkdown } from "./markdown";
import type { PlatformPort } from "../platform/types";

const el = {
  statusDot: byId<HTMLSpanElement>("status-dot"),
  statusText: byId<HTMLSpanElement>("status-text"),
  settingsToggle: byId<HTMLButtonElement>("settings-toggle"),
  summaryView: byId<HTMLElement>("summary-view"),
  settingsView: byId<HTMLElement>("settings-view"),
  statusBanner: byId<HTMLDivElement>("status-banner"),
  formatSelect: byId<HTMLSelectElement>("format-select"),
  summarizeButton: byId<HTMLButtonElement>("summarize-button"),
  runStatus: byId<HTMLParagraphElement>("run-status"),
  summaryOutput: byId<HTMLElement>("summary-output"),
  engineSelect: byId<HTMLSelectElement>("engine-select"),
  endpointInput: byId<HTMLInputElement>("endpoint-input"),
  modelInput: byId<HTMLInputElement>("model-input"),
  modelOptions: byId<HTMLDataListElement>("model-options"),
  maxWordsInput: byId<HTMLInputElement>("max-words-input"),
  autoSummarizeInput: byId<HTMLInputElement>("auto-summarize-input"),
  testConnectionButton: byId<HTMLButtonElement>("test-connection-button"),
  saveSettingsButton: byId<HTMLButtonElement>("save-settings-button"),
  settingsStatus: byId<HTMLParagraphElement>("settings-status"),
};

let settings: Settings;
let status: EngineStatus | null = null;
let activePort: PlatformPort | null = null;

// Auto-summarize policy lives in auto.ts (pure, tested); this only wires its
// effects to the panel: page lookups via the background, canceling the
// in-flight run, and starting a new one pinned to the qualified tab.
const autoRun = createAutoRun({
  enabled: () => settings.autoSummarize && status !== null && statusView(settings, status, platform.name).summarizeEnabled,
  getPage: async () => ((await platform.sendMessage({ type: "get-active-page" })) as GetActivePageResponse).page,
  cancel: () => {
    if (!activePort) {
      return false;
    }
    finishSummarize();
    return true;
  },
  start: (page) => startSummarize({ auto: true, tabId: page.tabId }),
});

// The empty-state glyph markup lives in index.html; keep a pristine copy so the
// running state can reuse it (animated) and the placeholder can be restored.
const emptyStateTemplate = (() => {
  const node = el.summaryOutput.querySelector<HTMLElement>(".summary-empty");
  if (!node) {
    throw new Error("Missing .summary-empty template");
  }
  return node.cloneNode(true) as HTMLElement;
})();

function emptyState(working: boolean): HTMLElement {
  const node = emptyStateTemplate.cloneNode(true) as HTMLElement;
  node.classList.toggle("working", working);
  return node;
}

document.documentElement.classList.add(`platform-${platform.name}`);
void init();

async function init(): Promise<void> {
  const response = (await platform.sendMessage({ type: "get-settings" })) as GetSettingsResponse;
  settings = response.settings;

  for (const [kind, label] of Object.entries(ENGINE_LABELS)) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = label;
    el.engineSelect.append(option);
  }
  syncSettingsForm();
  el.formatSelect.value = settings.format;

  wireEvents();
  platform.onActiveTabChanged(() => autoRun.trigger());
  // SPA navigations come from the content script, not the tabs API.
  platform.onMessage((message) => {
    if ((message as { type?: string })?.type === "page-changed") {
      autoRun.trigger();
    }
    return undefined;
  });
  await probeAndRender();
  autoRun.trigger();
}

function wireEvents(): void {
  el.settingsToggle.addEventListener("click", () => {
    const showSettings = el.settingsView.hidden;
    el.settingsView.hidden = !showSettings;
    el.summaryView.hidden = showSettings;
    el.settingsToggle.setAttribute("aria-expanded", String(showSettings));
    if (showSettings) {
      syncSettingsForm();
      showSettingsStatus("", "muted");
    }
  });

  el.formatSelect.addEventListener("change", () => {
    void saveSettings({ ...settings, format: el.formatSelect.value as Settings["format"] });
  });

  // The switch applies instantly, like the format select; the header label
  // flips between Ready and Auto, and enabling it summarizes right away.
  // The in-memory state changes synchronously so an auto evaluation whose
  // page lookup is still pending sees the new state at once; persisting
  // follows behind.
  el.autoSummarizeInput.addEventListener("change", () => {
    settings = { ...settings, autoSummarize: el.autoSummarizeInput.checked };
    renderStatus();
    autoRun.trigger();
    void saveSettings(settings);
  });

  el.engineSelect.addEventListener("change", () => {
    const engine = el.engineSelect.value as EngineKind;
    el.endpointInput.value = DEFAULT_ENDPOINTS[engine];
    el.modelInput.value = "";
    setModelOptions([]);
  });

  el.testConnectionButton.addEventListener("click", () => void testConnection());
  el.saveSettingsButton.addEventListener("click", () => void saveFromForm());

  el.summarizeButton.addEventListener("click", () => {
    if (activePort) {
      finishSummarize();
    } else {
      startSummarize();
    }
  });
}

// ---- Settings form ------------------------------------------------------------------

function syncSettingsForm(): void {
  el.engineSelect.value = settings.engine;
  el.endpointInput.value = settings.endpoint;
  el.modelInput.value = settings.model;
  el.maxWordsInput.value = String(settings.maxWords);
  el.autoSummarizeInput.checked = settings.autoSummarize;
  setModelOptions(status?.state === "ok" ? status.models : []);
}

function settingsFromForm(): Settings {
  return normalizeSettings({
    engine: el.engineSelect.value,
    endpoint: el.endpointInput.value.trim(),
    model: el.modelInput.value.trim(),
    format: el.formatSelect.value,
    maxWords: Number(el.maxWordsInput.value),
    autoSummarize: el.autoSummarizeInput.checked,
  });
}

async function testConnection(): Promise<void> {
  if (!isLocalEndpoint(el.endpointInput.value.trim())) {
    showSettingsStatus("Endpoint must be a localhost URL (http://localhost or http://127.0.0.1).", "error");
    return;
  }
  const candidate = settingsFromForm();
  showSettingsStatus("Connecting…", "muted");
  el.testConnectionButton.disabled = true;
  try {
    const { status: probed } = (await platform.sendMessage({
      type: "probe-engine",
      settings: candidate,
    })) as ProbeEngineResponse;
    if (probed.state === "ok") {
      setModelOptions(probed.models);
      if (!el.modelInput.value.trim() && probed.models[0]) {
        el.modelInput.value = probed.models[0];
      }
      const count = probed.models.length;
      showSettingsStatus(
        count > 0 ? `Connected. ${count} model${count === 1 ? "" : "s"} available.` : "Connected, but the server lists no models.",
        count > 0 ? "ok" : "error",
      );
    } else {
      showSettingsStatus(describeStatusShort(probed, candidate.engine), "error");
    }
  } finally {
    el.testConnectionButton.disabled = false;
  }
}

async function saveFromForm(): Promise<void> {
  await saveSettings(settingsFromForm());
  closeSettings();
  await probeAndRender();
  // Enabling the switch takes effect immediately instead of waiting for the
  // next navigation.
  autoRun.trigger();
}

function closeSettings(): void {
  el.settingsView.hidden = true;
  el.summaryView.hidden = false;
  el.settingsToggle.setAttribute("aria-expanded", "false");
}

async function saveSettings(next: Settings): Promise<void> {
  const response = (await platform.sendMessage({ type: "save-settings", settings: next })) as GetSettingsResponse;
  settings = response.settings;
  el.formatSelect.value = settings.format;
}

function setModelOptions(models: string[]): void {
  el.modelOptions.replaceChildren(
    ...models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      return option;
    }),
  );
}

function showSettingsStatus(text: string, tone: "muted" | "ok" | "error"): void {
  el.settingsStatus.hidden = text.length === 0;
  el.settingsStatus.textContent = text;
  el.settingsStatus.dataset["tone"] = tone === "muted" ? "" : tone;
}

// ---- Engine status ------------------------------------------------------------------

async function probeAndRender(): Promise<void> {
  el.statusDot.dataset["state"] = "probing";
  el.statusText.textContent = "Checking";
  const { status: probed } = (await platform.sendMessage({
    type: "probe-engine",
    settings,
  })) as ProbeEngineResponse;
  status = probed;

  // First run convenience: adopt the server's first model when none is chosen.
  if (probed.state === "ok" && !settings.model && probed.models[0]) {
    await saveSettings({ ...settings, model: probed.models[0] });
  }

  renderStatus();
}

function renderStatus(): void {
  if (!status) {
    return;
  }
  const view = statusView(settings, status, platform.name);
  el.statusDot.dataset["state"] = view.dot;
  el.statusText.textContent = view.label;
  el.summarizeButton.disabled = !view.summarizeEnabled;

  const banner = el.statusBanner;
  banner.replaceChildren();
  delete banner.dataset["tone"];
  if (!view.banner) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.dataset["tone"] = view.banner.tone;
  const title = document.createElement("p");
  title.className = "banner-title";
  title.textContent = view.banner.title;
  banner.append(title);

  for (const block of view.banner.blocks) {
    if (block.kind === "p") {
      const p = document.createElement("p");
      p.textContent = block.text;
      banner.append(p);
    } else {
      const list = document.createElement("ol");
      for (const step of block.steps) {
        const item = document.createElement("li");
        item.append(step.text);
        if (step.command) {
          const code = document.createElement("code");
          code.textContent = step.command;
          item.append(code);
        }
        list.append(item);
      }
      banner.append(list);
    }
  }

  if (view.banner.showRetry) {
    const actions = document.createElement("div");
    actions.className = "banner-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Check again";
    retry.addEventListener("click", () => void probeAndRender());
    actions.append(retry);
    banner.append(actions);
  }
}


// ---- Summarize ----------------------------------------------------------------------

function startSummarize({ auto = false, tabId }: { auto?: boolean; tabId?: number } = {}): void {
  // A manual run records the page key too, so auto mode does not immediately
  // re-summarize the page the user just summarized by hand.
  if (!auto) {
    autoRun.noteManualRun(
      platform.sendMessage({ type: "get-active-page" }).then((response) => (response as GetActivePageResponse).page),
    );
  }
  let markdown = "";
  el.summaryOutput.replaceChildren(emptyState(true));
  setRunStatus("Reading page…");
  el.summarizeButton.textContent = "Stop";

  const port = platform.connect(SUMMARIZE_PORT);
  activePort = port;

  let title = "";
  let truncated = false;

  port.onMessage((message) => {
    const event = message as SummarizeEvent;
    switch (event.type) {
      case "phase":
        setRunStatus(event.phase === "extracting" ? "Reading page…" : "Summarizing…");
        break;
      case "article":
        title = event.title;
        truncated = event.truncated;
        renderSummary();
        break;
      case "chunk":
        markdown += event.text;
        renderSummary();
        break;
      case "done":
        renderCopyAction();
        finishSummarize();
        break;
      case "error":
        renderRunError(event.code, event.message, auto);
        finishSummarize();
        break;
    }
  });
  port.onDisconnect(() => {
    if (activePort === port) {
      finishSummarize();
    }
  });
  const start: SummarizeStart = { type: "start" };
  if (tabId !== undefined) {
    start.tabId = tabId;
  }
  port.postMessage(start);

  function renderSummary(): void {
    el.summaryOutput.replaceChildren();
    if (title) {
      const heading = document.createElement("h2");
      heading.className = "summary-title";
      heading.textContent = title;
      el.summaryOutput.append(heading);
    }
    if (truncated) {
      const note = document.createElement("p");
      note.className = "truncated-note";
      note.textContent = "Long page: the summary covers the beginning of the article.";
      el.summaryOutput.append(note);
    }
    el.summaryOutput.append(renderMarkdown(markdown, document));
  }

  function renderCopyAction(): void {
    if (markdown.trim().length === 0) {
      return;
    }
    const actions = document.createElement("div");
    actions.className = "summary-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy summary";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(markdown.trim()).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy summary";
        }, 1500);
      });
    });
    actions.append(copy);
    el.summaryOutput.append(actions);
  }
}

function finishSummarize(): void {
  // Disconnecting aborts the background run when it is still in flight.
  activePort?.disconnect();
  activePort = null;
  setRunStatus("");
  el.summarizeButton.textContent = "Summarize this page";
  // A run that produced no output (stopped early) leaves the working glyph
  // behind; put the resting placeholder back. Non-working empty states (the
  // auto mode's "nothing to summarize" note) are left as rendered.
  if (el.summaryOutput.querySelector(".summary-empty.working")) {
    el.summaryOutput.replaceChildren(emptyState(false));
  }
}

function setRunStatus(text: string): void {
  el.runStatus.hidden = text.length === 0;
  el.runStatus.textContent = text;
}

function renderRunError(code: SummarizeErrorCode, message: string, auto: boolean): void {
  // Auto mode visits pages the user never asked to summarize (index pages,
  // browser-internal pages); an unsummarizable page is expected there, so it
  // gets the quiet resting glyph instead of red error copy. Engine failures
  // stay loud in both modes.
  if (auto && (code === "no-content" || code === "page-unsupported")) {
    const resting = emptyState(false);
    const note = resting.querySelector("p");
    if (note) {
      note.textContent = "Nothing to summarize on this page.";
    }
    el.summaryOutput.replaceChildren(resting);
    return;
  }
  const friendly: Record<SummarizeErrorCode, string> = {
    "page-unsupported": "This page can’t be summarized (browser-internal pages and some restricted sites don’t allow it). If this is a normal website, reload the tab and try again.",
    "no-content": "No readable article text was found on this page.",
    "engine-unreachable": "The local model server isn’t reachable. Check the status above.",
    "origin-forbidden": "The model server rejected the extension (set OLLAMA_ORIGINS and restart Ollama).",
    "model-missing": `The selected model isn’t available on the server: ${message}`,
    "empty-summary": "The model finished without writing a summary (thinking models sometimes spend their whole output budget reasoning). Try again, or pick a different model in settings.",
    "engine-error": `The model server reported an error: ${message}`,
  };
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = friendly[code] ?? message;
  el.summaryOutput.querySelector(".summary-empty")?.remove();
  el.summaryOutput.append(p);
  if (code === "engine-unreachable" || code === "origin-forbidden") {
    void probeAndRender();
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
