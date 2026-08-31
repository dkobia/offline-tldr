import { describe, expect, it } from "vitest";
import { pageKey } from "./page-key";

describe("pageKey", () => {
  it("keys http(s) pages by their URL", () => {
    expect(pageKey("https://example.com/a")).toBe("https://example.com/a");
    expect(pageKey("http://example.com/a?p=2")).toBe("http://example.com/a?p=2");
  });

  it("ignores the fragment, so in-page jumps share a key", () => {
    expect(pageKey("https://example.com/a#section-2")).toBe(pageKey("https://example.com/a"));
  });

  it("distinguishes paths and query strings", () => {
    expect(pageKey("https://example.com/a")).not.toBe(pageKey("https://example.com/b"));
    expect(pageKey("https://example.com/a")).not.toBe(pageKey("https://example.com/a?p=2"));
  });

  it("returns null for non-http(s) and malformed URLs", () => {
    expect(pageKey("about:blank")).toBeNull();
    expect(pageKey("file:///tmp/page.html")).toBeNull();
    expect(pageKey("chrome://newtab/")).toBeNull();
    expect(pageKey("not a url")).toBeNull();
  });
});
