import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompt";
import type { SummaryRequest } from "./index";

const baseRequest: SummaryRequest = {
  article: { title: "Test Article", text: "Body text about a topic." },
  format: "bullets",
  maxWords: 150,
};

describe("buildPrompt", () => {
  it("includes the title, the article text, and the word cap", () => {
    const { system, user } = buildPrompt(baseRequest);
    expect(system).toContain("summarization assistant");
    expect(user).toContain("Title: Test Article");
    expect(user).toContain("Article:\nBody text about a topic.");
    expect(user).toContain("150 words");
    expect(user).toContain("bullet points");
  });

  it("omits the title line when the article has none", () => {
    const { user } = buildPrompt({ ...baseRequest, article: { title: "", text: "Body." } });
    expect(user).not.toContain("Title:");
  });

  it("varies the instruction per format", () => {
    expect(buildPrompt({ ...baseRequest, format: "executive" }).user).toContain("paragraph");
    expect(buildPrompt({ ...baseRequest, format: "one-liner" }).user).toContain("one single sentence");
  });

  it("asks the executive summary for a bold takeaway and spaced paragraphs", () => {
    const { user } = buildPrompt({ ...baseRequest, format: "executive" });
    expect(user).toContain("bold sentence");
    expect(user).toContain("separated by blank lines");
    expect(user).toContain("2 to 4 short paragraphs");
  });

  it("scales the executive paragraph count down for small word budgets", () => {
    const { user } = buildPrompt({ ...baseRequest, format: "executive", maxWords: 80 });
    expect(user).toContain("1 or 2 short paragraphs");
  });

  it("permits a comparison table for bullets and executive but not one-liner", () => {
    expect(buildPrompt({ ...baseRequest, format: "bullets" }).user).toContain("Markdown table");
    expect(buildPrompt({ ...baseRequest, format: "executive" }).user).toContain("Markdown table");
    expect(buildPrompt({ ...baseRequest, format: "one-liner" }).user).not.toContain("table");
  });

  it("caps the one-liner at 40 words even with a larger maxWords", () => {
    const { user } = buildPrompt({ ...baseRequest, format: "one-liner", maxWords: 400 });
    expect(user).toContain("40 words");
  });
});
