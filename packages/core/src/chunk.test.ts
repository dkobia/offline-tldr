import { describe, expect, it } from "vitest";
import { fitToBudget } from "./chunk";

describe("fitToBudget", () => {
  it("returns text unchanged when it fits", () => {
    const result = fitToBudget("short text", 100);
    expect(result).toEqual({ text: "short text", truncated: false });
  });

  it("truncates on a paragraph boundary", () => {
    const text = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n\n");
    const result = fitToBudget(text, 90);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(["a".repeat(40), "b".repeat(40)].join("\n\n"));
  });

  it("hard-cuts a single paragraph larger than the budget", () => {
    const result = fitToBudget("x".repeat(500), 100);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("x".repeat(100));
  });
});
