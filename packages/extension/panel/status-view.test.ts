import { describe, expect, it } from "vitest";
import type { Settings } from "@offline-tldr/shared";
import { describeStatusShort, effectiveStatus, statusView, type BannerBlock } from "./status-view";

const base: Settings = {
  engine: "ollama",
  endpoint: "http://localhost:11434",
  model: "llama3.2",
  format: "bullets",
  maxWords: 150,
  autoSummarize: false,
};

function commands(blocks: BannerBlock[]): string[] {
  return blocks
    .filter((block): block is Extract<BannerBlock, { kind: "steps" }> => block.kind === "steps")
    .flatMap((block) => block.steps.map((step) => step.command).filter((command): command is string => !!command));
}

function paragraphs(blocks: BannerBlock[]): string[] {
  return blocks
    .filter((block): block is Extract<BannerBlock, { kind: "p" }> => block.kind === "p")
    .map((block) => block.text);
}

describe("statusView: ok", () => {
  it("is green with no banner when the model is available", () => {
    const view = statusView(base, { state: "ok", models: ["llama3.2:latest"] }, "chrome");
    expect(view).toEqual({ dot: "ok", label: "Ready", summarizeEnabled: true, banner: null });
  });

  it("labels the ready state Auto when auto-summarize is on", () => {
    const auto = { ...base, autoSummarize: true };
    const view = statusView(auto, { state: "ok", models: ["llama3.2:latest"] }, "chrome");
    expect(view).toEqual({ dot: "ok", label: "Auto", summarizeEnabled: true, banner: null });
    // Problem states win over the mode label.
    expect(statusView(auto, { state: "unreachable" }, "chrome").label).toBe("Offline");
    expect(statusView({ ...auto, model: "" }, { state: "ok", models: ["m"] }, "chrome").label).toBe("No model");
  });

  it("warns and disables Summarize when no model is selected", () => {
    const view = statusView({ ...base, model: "" }, { state: "ok", models: ["llama3.2:latest"] }, "chrome");
    expect(view.dot).toBe("warn");
    expect(view.label).toBe("No model");
    expect(view.summarizeEnabled).toBe(false);
    expect(view.banner?.title).toContain("no model is selected");
  });

  it("warns but keeps Summarize enabled when the model is not in Ollama's list, with a pull command", () => {
    const view = statusView({ ...base, model: "mistral" }, { state: "ok", models: ["llama3.2:latest"] }, "chrome");
    expect(view.dot).toBe("warn");
    expect(view.label).toBe("Check model");
    expect(view.summarizeEnabled).toBe(true);
    expect(view.banner?.title).toContain("mistral");
    expect(commands(view.banner?.blocks ?? [])).toContain("ollama pull mistral");
  });

  it("does not apply the :latest alias to OpenAI-compatible engines", () => {
    const settings: Settings = { ...base, engine: "lmstudio", endpoint: "http://localhost:1234", model: "foo" };
    const view = statusView(settings, { state: "ok", models: ["foo:latest"] }, "chrome");
    expect(view.dot).toBe("warn");
    expect(commands(view.banner?.blocks ?? [])).toEqual([]);
    expect(paragraphs(view.banner?.blocks ?? []).join(" ")).toContain("Pick one of the server's models");
  });

  it("treats an empty model list as unknown and stays green", () => {
    const settings: Settings = { ...base, engine: "llamacpp", endpoint: "http://localhost:8080", model: "whatever" };
    expect(statusView(settings, { state: "ok", models: [] }, "chrome").banner).toBeNull();
  });
});

describe("statusView: down states", () => {
  it("gives OLLAMA_ORIGINS instructions on forbidden only for Ollama", () => {
    const ollama = statusView(base, { state: "forbidden" }, "chrome");
    expect(ollama.dot).toBe("down");
    expect(ollama.label).toBe("Offline");
    expect(ollama.summarizeEnabled).toBe(false);
    expect(commands(ollama.banner?.blocks ?? []).join(" ")).toContain("OLLAMA_ORIGINS");
    expect(ollama.banner?.showRetry).toBe(true);

    const lmstudio = statusView(
      { ...base, engine: "lmstudio", endpoint: "http://localhost:1234" },
      { state: "forbidden" },
      "chrome",
    );
    expect(commands(lmstudio.banner?.blocks ?? [])).toEqual([]);
    expect(paragraphs(lmstudio.banner?.blocks ?? []).join(" ")).toContain("HTTP 403");
    expect(paragraphs(lmstudio.banner?.blocks ?? []).join(" ")).not.toContain("OLLAMA_ORIGINS");
  });

  it("shows per-engine start instructions when unreachable", () => {
    const ollama = statusView(base, { state: "unreachable" }, "chrome");
    expect(ollama.banner?.title).toContain("isn’t reachable at http://localhost:11434");
    expect(commands(ollama.banner?.blocks ?? []).join(" ")).toContain("OLLAMA_ORIGINS");

    const llamacpp = statusView(
      { ...base, engine: "llamacpp", endpoint: "http://localhost:8080" },
      { state: "unreachable" },
      "chrome",
    );
    expect(commands(llamacpp.banner?.blocks ?? []).join(" ")).toContain("llama-server");
  });

  it("appends the error detail and the Firefox permissions note when applicable", () => {
    const view = statusView(base, { state: "unreachable", detail: "TypeError: Failed to fetch" }, "firefox");
    const text = paragraphs(view.banner?.blocks ?? []).join(" ");
    expect(text).toContain("Details: TypeError: Failed to fetch");
    expect(text).toContain("extension’s permissions");

    const chrome = statusView(base, { state: "unreachable" }, "chrome");
    expect(paragraphs(chrome.banner?.blocks ?? []).join(" ")).not.toContain("permissions");
  });

  it("surfaces server errors verbatim", () => {
    const view = statusView(base, { state: "error", detail: "HTTP 500" }, "chrome");
    expect(view.banner?.title).toContain("returned an error");
    expect(paragraphs(view.banner?.blocks ?? [])).toContain("HTTP 500");
  });
});

describe("statusView for the built-in model", () => {
  const builtIn: Settings = { ...base, engine: "builtin", model: "" };

  it("is ready without a model name, and Auto when the switch is on", () => {
    expect(statusView(builtIn, { state: "ok", models: ["Gemini Nano"] }, "chrome")).toEqual({
      dot: "ok",
      label: "Ready",
      summarizeEnabled: true,
      banner: null,
    });
    expect(statusView({ ...builtIn, autoSummarize: true }, { state: "ok", models: ["Gemini Nano"] }, "chrome").label).toBe("Auto");
  });

  it("offers the download when the model is not there yet, with Summarize disabled", () => {
    const view = statusView(builtIn, { state: "downloadable" }, "chrome");
    expect(view.dot).toBe("warn");
    expect(view.label).toBe("No model");
    expect(view.summarizeEnabled).toBe(false);
    expect(view.banner?.tone).toBe("warn");
    expect(view.banner?.title).toContain("isn’t downloaded yet");
    expect(view.banner?.showDownload).toBe(true);
    expect(view.banner?.showRetry).toBe(false);
    expect(paragraphs(view.banner?.blocks ?? []).join(" ")).toContain("never sent anywhere");
  });

  it("shows progress for a download this panel started, and a recheck for one it did not", () => {
    const own = statusView(builtIn, { state: "downloading", progress: 0.426 }, "chrome");
    expect(own.dot).toBe("probing");
    expect(own.label).toBe("Downloading 42%");
    expect(own.summarizeEnabled).toBe(false);
    expect(own.banner?.showRetry).toBe(false);
    expect(own.banner?.showDownload).toBe(false);
    expect(paragraphs(own.banner?.blocks ?? []).join(" ")).toContain("42% downloaded");

    const other = statusView(builtIn, { state: "downloading" }, "chrome");
    expect(other.label).toBe("Downloading");
    expect(other.banner?.showRetry).toBe(true);
  });

  it("explains an unsupported device and points at the servers", () => {
    const view = statusView(builtIn, { state: "unsupported" }, "chrome");
    expect(view.dot).toBe("down");
    expect(view.label).toBe("Unavailable");
    expect(view.summarizeEnabled).toBe(false);
    expect(view.banner?.tone).toBe("down");
    expect(view.banner?.showRetry).toBe(true);
    expect(view.banner?.showDownload).toBe(false);
    const text = paragraphs(view.banner?.blocks ?? []).join(" ");
    expect(text).toContain("Chrome 138");
    expect(text).toContain("22 GB");
    expect(text).toContain("Ollama");
  });

  it("still reports an error from the browser, without calling it offline", () => {
    const view = statusView(builtIn, { state: "error", detail: "boom" }, "chrome");
    expect(view.dot).toBe("down");
    expect(view.label).toBe("Error");
    expect(view.summarizeEnabled).toBe(false);
    expect(view.banner?.title).toBe("Chrome’s built-in model returned an error");
    expect(paragraphs(view.banner?.blocks ?? [])).toContain("boom");
    expect(view.banner?.showRetry).toBe(true);
  });

  it("never offers the download for a server engine", () => {
    for (const status of [{ state: "unreachable" as const }, { state: "forbidden" as const }, { state: "ok" as const, models: [] }]) {
      expect(statusView(base, status, "chrome").banner?.showDownload ?? false).toBe(false);
    }
  });
});

describe("effectiveStatus", () => {
  const builtIn: Settings = { ...base, engine: "builtin", model: "" };
  const probed = { state: "downloadable" as const };

  it("lets a running download own the built-in engine's status, and its failure too", () => {
    expect(effectiveStatus(builtIn, probed, { progress: 0.3 })).toEqual({ state: "downloading", progress: 0.3 });
    expect(effectiveStatus(builtIn, null, { progress: 0 })).toEqual({ state: "downloading", progress: 0 });
    expect(effectiveStatus(builtIn, probed, { failed: "NetworkError" })).toEqual({ state: "error", detail: "NetworkError" });
  });

  it("shows the probe when nothing is downloading, or when a server is selected mid-download", () => {
    expect(effectiveStatus(builtIn, probed, null)).toBe(probed);
    expect(effectiveStatus(builtIn, null, null)).toBeNull();
    const ollama = { state: "unreachable" as const };
    expect(effectiveStatus(base, ollama, { progress: 0.5 })).toBe(ollama);
    expect(effectiveStatus(base, null, { failed: "x" })).toBeNull();
  });
});

describe("describeStatusShort", () => {
  it("is engine-aware for forbidden", () => {
    expect(describeStatusShort({ state: "forbidden" }, "ollama")).toContain("OLLAMA_ORIGINS");
    expect(describeStatusShort({ state: "forbidden" }, "lmstudio")).toContain("HTTP 403");
    expect(describeStatusShort({ state: "forbidden" }, "lmstudio")).not.toContain("OLLAMA_ORIGINS");
  });

  it("covers the remaining states", () => {
    expect(describeStatusShort({ state: "ok", models: [] }, "ollama")).toContain("running");
    expect(describeStatusShort({ state: "unreachable" }, "custom")).toContain("isn’t reachable");
    expect(describeStatusShort({ state: "error", detail: "boom" }, "llamacpp")).toContain("boom");
  });

  it("speaks of the built-in model in its own states", () => {
    expect(describeStatusShort({ state: "ok", models: ["Gemini Nano"] }, "builtin")).toBe("Chrome’s built-in model is ready.");
    expect(describeStatusShort({ state: "downloadable" }, "builtin")).toContain("isn’t downloaded yet");
    expect(describeStatusShort({ state: "downloading" }, "builtin")).toContain("downloading");
    expect(describeStatusShort({ state: "unsupported" }, "builtin")).toContain("isn’t available on this device");
  });
});
