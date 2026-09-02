import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_CHAR_BUDGET,
  MAX_INPUT_CHAR_BUDGET,
  MIN_INPUT_CHAR_BUDGET,
  fitToBudget,
  planBudget,
  outputTokenCap,
} from "./chunk";

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

describe("outputTokenCap", () => {
  it("adds flat thinking headroom to the words-to-tokens estimate", () => {
    expect(outputTokenCap(150)).toBe(150 * 4 + 4096);
  });
});

describe("planBudget", () => {
  const cap = outputTokenCap(150);

  it("falls back to the defaults when the runtime reports no context", () => {
    const expected = { inputChars: DEFAULT_INPUT_CHAR_BUDGET, outputTokens: cap };
    expect(planBudget({ contextTokens: null, maxWords: 150 })).toEqual(expected);
    expect(planBudget({ contextTokens: Number.NaN, maxWords: 150 })).toEqual(expected);
  });

  it("gives the article what is left after the full generation cap and prompt overhead", () => {
    // 32k context: (32768 - (150*4 + 4096) - 256) * 4
    expect(planBudget({ contextTokens: 32_768, maxWords: 150 })).toEqual({
      inputChars: (32_768 - 4696 - 256) * 4,
      outputTokens: cap,
    });
  });

  it("gives an 8k context less than the old fixed default, never more than fits", () => {
    const { inputChars, outputTokens } = planBudget({ contextTokens: 8192, maxWords: 150 });
    expect(inputChars).toBeLessThan(DEFAULT_INPUT_CHAR_BUDGET);
    expect(inputChars).toBeGreaterThan(MIN_INPUT_CHAR_BUDGET);
    expect(outputTokens).toBe(cap);
  });

  it("floors the article on a context too small for the cap and shrinks the cap to what remains", () => {
    const { inputChars, outputTokens } = planBudget({ contextTokens: 4096, maxWords: 150 });
    expect(inputChars).toBe(MIN_INPUT_CHAR_BUDGET);
    expect(outputTokens).toBeLessThan(cap);
    expect(Math.ceil(inputChars / 4) + 256 + outputTokens).toBeLessThanOrEqual(4096);
  });

  it("lets the input yield below its floor so tiny contexts still never overlap", () => {
    for (const contextTokens of [512, 1024, 1400]) {
      const { inputChars, outputTokens } = planBudget({ contextTokens, maxWords: 150 });
      expect(outputTokens).toBe(256);
      expect(inputChars).toBeLessThan(MIN_INPUT_CHAR_BUDGET);
      expect(Math.ceil(inputChars / 4) + 256 + outputTokens).toBeLessThanOrEqual(contextTokens);
    }
    expect(planBudget({ contextTokens: 512, maxWords: 150 }).inputChars).toBe(0);
  });

  it("caps huge contexts so prompt processing stays bounded", () => {
    expect(planBudget({ contextTokens: 262_144, maxWords: 150 }).inputChars).toBe(MAX_INPUT_CHAR_BUDGET);
  });

  it("sends the whole 41k-character reference article on a 262k context", () => {
    const { inputChars } = planBudget({ contextTokens: 262_144, maxWords: 150 });
    expect(fitToBudget("x".repeat(40_866), inputChars).truncated).toBe(false);
  });
});
