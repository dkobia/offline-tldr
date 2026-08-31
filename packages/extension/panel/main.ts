// Panel entry point: summary view + settings view.
// The panel owns no summary state (issue #7): the background keeps one entry
// per tab, and the panel is a view over the active tab's entry. On every
// activation (open, tab switch, navigation) it watches that tab over the
// summarize port, renders the snapshot it gets back, and applies the run
// events that follow. Settings and probing stay one-shot messages.

import { platform } from "@platform";
import {
  SUMMARIZE_PORT,
  type EngineKind,
  type EngineStatus,
  type GetActivePageResponse,
  type GetSettingsResponse,
  type GetTabStateResponse,
  type ProbeEngineResponse,
  type Settings,
  type SummarizeCommand,
  type SummarizeErrorCode,
  type SummarizeEvent,
  type SummarizePortEvent,
  type TabSummaryState,
} from "@offline-tldr/shared";
import { DEFAULT_ENDPOINTS, ENGINE_LABELS, isLocalEndpoint, normalizeSettings } from "../lib/settings";
import { createAutoRun } from "./auto";
import { applyRunEvent, createTabStream, emptyView, viewFromState, type RunView } from "./tab-stream";
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

// ---- The watched tab ----------------------------------------------------------------

// Which port events apply and how they fold into the view is pure policy in
// tab-stream.ts; this module only paints.
let port: PlatformPort | null = null;
const stream = createTabStream();
/** Discards activations that resolve after a newer one began. */
let activationSeq = 0;
let view: RunView = emptyView();

// Auto-summarize policy lives in auto.ts (pure, tested); this only wires its
// effects to the panel: page and stored-state lookups via the background,
// and starting a run pinned to the qualified tab.
const autoRun = createAutoRun({
  enabled: () => settings.autoSummarize && status !== null && statusView(settings, status, platform.name).summarizeEnabled,
  getPage: async () => ((await platform.sendMessage({ type: "get-active-page" })) as GetActivePageResponse).page,
  hasState: async (page) => {
    const response = (await platform.sendMessage({
      type: "get-tab-state",
      tabId: page.tabId,
      url: page.url,
    })) as GetTabStateResponse;
    return response.state !== null;
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
  platform.onActiveTabChanged(() => void activate());
  // SPA navigations come from the content script, not the tabs API.
  platform.onMessage((message) => {
    if ((message as { type?: string })?.type === "page-changed") {
      void activate();
    }
    return undefined;
  });
  // Show the active tab's state right away; the (slower) engine probe follows
  // and unlocks auto mode.
  await activate();
  await probeAndRender();
  autoRun.trigger();
}

/**
 * Points the panel at the active tab: watch it over the port (the background
 * answers with a state snapshot, then streams that tab's run events) and let
 * auto mode evaluate the page. Tabs whose page the extension cannot see
 * (browser-internal) are still watched by id so a stale summary never
 * lingers on screen.
 */
async function activate(): Promise<void> {
  const seq = ++activationSeq;
  const { page } = (await platform.sendMessage({ type: "get-active-page" })) as GetActivePageResponse;
  let tabId = page?.tabId;
  if (tabId === undefined) {
    tabId = (await platform.getActiveTab())?.id;
  }
  if (seq !== activationSeq) {
    return;
  }
  if (tabId === undefined) {
    stream.clear();
    renderTabState(null);
    return;
  }
  const command: SummarizeCommand = { type: "watch", tabId, watchId: stream.beginWatch(tabId) };
  if (page) {
    command.url = page.url;
  }
  ensurePort().postMessage(command);
  autoRun.trigger();
}

function ensurePort(): PlatformPort {
  if (port) {
    return port;
  }
  const opened = platform.connect(SUMMARIZE_PORT);
  port = opened;
  opened.onMessage(handlePortEvent);
  opened.onDisconnect(() => {
    // The background restarted; reconnect and re-sync on the next activation.
    if (port === opened) {
      port = null;
      void activate();
    }
  });
  return opened;
}

function handlePortEvent(message: unknown): void {
  const event = message as SummarizePortEvent;
  const classified = stream.classify(event);
  if (classified === "snapshot" && event.type === "tab-state") {
    renderTabState(event.state);
  } else if (classified === "run-event" && event.type === "tab-event") {
    handleRunEvent(event.event);
  }
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
    if (view.running) {
      stopSummarize();
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
  const header = statusView(settings, status, platform.name);
  el.statusDot.dataset["state"] = header.dot;
  el.statusText.textContent = header.label;
  el.summarizeButton.disabled = !header.summarizeEnabled;

  const banner = el.statusBanner;
  banner.replaceChildren();
  delete banner.dataset["tone"];
  if (!header.banner) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.dataset["tone"] = header.banner.tone;
  const title = document.createElement("p");
  title.className = "banner-title";
  title.textContent = header.banner.title;
  banner.append(title);

  for (const block of header.banner.blocks) {
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

  if (header.banner.showRetry) {
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
  const target = tabId ?? stream.watchedTabId();
  if (target === null || target === undefined) {
    return;
  }
  // A manual run records the page key too, so auto mode does not immediately
  // re-summarize the page the user just summarized by hand.
  if (!auto) {
    autoRun.noteManualRun(
      platform.sendMessage({ type: "get-active-page" }).then((response) => (response as GetActivePageResponse).page),
    );
  }
  // Auto runs pin the tab they qualified; show the working state only when it
  // is still the tab on screen (the events are filtered the same way).
  if (target === stream.watchedTabId()) {
    view = { ...emptyView(), running: true, auto };
    el.summaryOutput.replaceChildren(emptyState(true));
    setRunStatus("Reading page…");
    el.summarizeButton.textContent = "Stop";
  }
  const command: SummarizeCommand = { type: "start", tabId: target, auto };
  ensurePort().postMessage(command);
}

/**
 * Runs are stopped explicitly, not by disconnecting: the port outlives runs
 * and closing the panel deliberately leaves the run going. Whatever streamed
 * so far stays on screen; the background forgets the unfinished entry.
 */
function stopSummarize(): void {
  const tabId = stream.watchedTabId();
  if (tabId !== null) {
    const command: SummarizeCommand = { type: "cancel", tabId };
    ensurePort().postMessage(command);
  }
  view = { ...view, running: false };
  finishRunUi();
}

/** Renders one tab's stored state, the panel's whole world after a switch. */
function renderTabState(state: TabSummaryState | null): void {
  view = viewFromState(state);
  if (!state) {
    el.summaryOutput.replaceChildren(emptyState(false));
    finishRunUi();
    return;
  }
  switch (state.status.kind) {
    case "running":
      if (view.title || view.markdown) {
        renderSummary();
      } else {
        el.summaryOutput.replaceChildren(emptyState(true));
      }
      setRunStatus(state.status.phase === "extracting" ? "Reading page…" : "Summarizing…");
      el.summarizeButton.textContent = "Stop";
      break;
    case "done":
      renderSummary();
      renderCopyAction();
      finishRunUi();
      break;
    case "error":
      if (view.title || view.markdown) {
        renderSummary();
      } else {
        el.summaryOutput.replaceChildren(emptyState(false));
      }
      renderRunError(state.status.code, state.status.message, state.auto);
      finishRunUi();
      break;
  }
}

function handleRunEvent(event: SummarizeEvent): void {
  view = applyRunEvent(view, event);
  switch (event.type) {
    case "phase":
      // "extracting" opens a run (ours, or one another surface started for
      // this tab): the fold reset the accumulation; show the working glyph.
      if (event.phase === "extracting") {
        el.summaryOutput.replaceChildren(emptyState(true));
      }
      el.summarizeButton.textContent = "Stop";
      setRunStatus(event.phase === "extracting" ? "Reading page…" : "Summarizing…");
      break;
    case "article":
    case "chunk":
      renderSummary();
      break;
    case "done":
      renderSummary();
      renderCopyAction();
      finishRunUi();
      break;
    case "error":
      renderRunError(event.code, event.message, view.auto);
      finishRunUi();
      break;
  }
}

function finishRunUi(): void {
  setRunStatus("");
  el.summarizeButton.textContent = "Summarize this page";
  // A run that produced no output (stopped early) leaves the working glyph
  // behind; put the resting placeholder back. Non-working empty states (the
  // auto mode's "nothing to summarize" note) are left as rendered.
  if (el.summaryOutput.querySelector(".summary-empty.working")) {
    el.summaryOutput.replaceChildren(emptyState(false));
  }
}

function renderSummary(): void {
  el.summaryOutput.replaceChildren();
  if (view.title) {
    const heading = document.createElement("h2");
    heading.className = "summary-title";
    heading.textContent = view.title;
    el.summaryOutput.append(heading);
  }
  if (view.truncated) {
    const note = document.createElement("p");
    note.className = "truncated-note";
    note.textContent = "Long page: the summary covers the beginning of the article.";
    el.summaryOutput.append(note);
  }
  el.summaryOutput.append(renderMarkdown(view.markdown, document));
}

function renderCopyAction(): void {
  const markdown = view.markdown.trim();
  if (markdown.length === 0) {
    return;
  }
  const actions = document.createElement("div");
  actions.className = "summary-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy summary";
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(markdown).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.textContent = "Copy summary";
      }, 1500);
    });
  });
  actions.append(copy);
  el.summaryOutput.append(actions);
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
