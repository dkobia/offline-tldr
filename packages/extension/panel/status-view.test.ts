import { describe, expect, it } from "vitest";
import type { Settings } from "@offline-tldr/shared";
import { describeStatusShort, statusView, type BannerBlock } from "./status-view";

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
});
