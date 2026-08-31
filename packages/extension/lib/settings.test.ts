import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isLocalEndpoint, isModelAvailable, normalizeSettings } from "./settings";

describe("isModelAvailable", () => {
  it("matches exact names and, for Ollama only, the implicit :latest tag", () => {
    expect(isModelAvailable("llama3.2:latest", ["llama3.2:latest"], "ollama")).toBe(true);
    expect(isModelAvailable("llama3.2", ["llama3.2:latest", "phi3:latest"], "ollama")).toBe(true);
    expect(isModelAvailable("phi3", ["phi3"], "lmstudio")).toBe(true);
  });

  it("requires exact ids on OpenAI-compatible engines", () => {
    expect(isModelAvailable("foo", ["foo:latest"], "lmstudio")).toBe(false);
    expect(isModelAvailable("foo", ["foo:latest"], "custom")).toBe(false);
    expect(isModelAvailable("foo:latest", ["foo:latest"], "lmstudio")).toBe(true);
  });

  it("does not match other tags or different models", () => {
    expect(isModelAvailable("llama3.2", ["llama3.2:8b"], "ollama")).toBe(false);
    expect(isModelAvailable("llama3.2", ["llama3.2-vision:latest"], "ollama")).toBe(false);
    expect(isModelAvailable("mistral", ["llama3.2:latest"], "ollama")).toBe(false);
  });

  it("treats an empty model list as unknown rather than missing", () => {
    expect(isModelAvailable("anything", [], "ollama")).toBe(true);
    expect(isModelAvailable("anything", [], "custom")).toBe(true);
  });
});

describe("isLocalEndpoint", () => {
  it("accepts localhost variants over http and https", () => {
    expect(isLocalEndpoint("http://localhost:11434")).toBe(true);
    expect(isLocalEndpoint("http://127.0.0.1:1234")).toBe(true);
    expect(isLocalEndpoint("https://localhost")).toBe(true);
  });

  it("rejects remote hosts, other protocols, and garbage", () => {
    expect(isLocalEndpoint("http://example.com")).toBe(false);
    expect(isLocalEndpoint("http://192.168.1.10:11434")).toBe(false);
    expect(isLocalEndpoint("http://[::1]:8080")).toBe(false);
    expect(isLocalEndpoint("http://localhost.evil.com")).toBe(false);
    expect(isLocalEndpoint("ws://localhost:11434")).toBe(false);
    expect(isLocalEndpoint("file:///etc/passwd")).toBe(false);
    expect(isLocalEndpoint("not a url")).toBe(false);
    expect(isLocalEndpoint("")).toBe(false);
  });
});

describe("normalizeSettings", () => {
  it("returns defaults for empty or malformed input", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps a valid settings object intact, minus trailing slashes", () => {
    const settings = {
      engine: "lmstudio",
      endpoint: "http://localhost:1234/",
      model: "phi3",
      format: "executive",
      maxWords: 200,
      autoSummarize: true,
    };
    expect(normalizeSettings(settings)).toEqual({ ...settings, endpoint: "http://localhost:1234" });
  });

  it("replaces a non-local endpoint with the engine default", () => {
    const settings = normalizeSettings({ engine: "ollama", endpoint: "http://example.com" });
    expect(settings.endpoint).toBe("http://localhost:11434");
  });

  it("clamps maxWords into range", () => {
    expect(normalizeSettings({ maxWords: 5 }).maxWords).toBe(30);
    expect(normalizeSettings({ maxWords: 10_000 }).maxWords).toBe(600);
    expect(normalizeSettings({ maxWords: NaN }).maxWords).toBe(DEFAULT_SETTINGS.maxWords);
  });

  it("falls back per field on invalid values", () => {
    const settings = normalizeSettings({ engine: "cloud", format: "haiku", model: 42 });
    expect(settings.engine).toBe("ollama");
    expect(settings.format).toBe("bullets");
    expect(settings.model).toBe("");
  });

  it("coerces autoSummarize to a real boolean, defaulting off", () => {
    expect(normalizeSettings({}).autoSummarize).toBe(false);
    expect(normalizeSettings({ autoSummarize: true }).autoSummarize).toBe(true);
    expect(normalizeSettings({ autoSummarize: "yes" }).autoSummarize).toBe(false);
    expect(normalizeSettings({ autoSummarize: 1 }).autoSummarize).toBe(false);
  });
});
