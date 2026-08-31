import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { extractArticle } from "./extract";

function loadFixture(name: string): Document {
  const file = new URL(`../../../fixtures/${name}`, import.meta.url);
  const { document } = parseHTML(readFileSync(file, "utf8"));
  return document as unknown as Document;
}

describe("extractArticle", () => {
  it("extracts the article body from a page with an <article> element", () => {
    const article = extractArticle(loadFixture("article.html"));
    expect(article).not.toBeNull();
    expect(article?.title).toBe("The History of Timekeeping");
    expect(article?.lang).toBe("en");
    expect(article?.text).toContain("Humans have measured time for millennia");
    expect(article?.text).toContain("atomic clocks now define the second itself");
  });

  it("strips navigation, promos, related links, and the footer", () => {
    const article = extractArticle(loadFixture("article.html"));
    expect(article?.text).not.toContain("Subscribe");
    expect(article?.text).not.toContain("newsletter");
    expect(article?.text).not.toContain("Related stories");
    expect(article?.text).not.toContain("All rights reserved");
  });

  it("separates paragraphs with blank lines", () => {
    const article = extractArticle(loadFixture("article.html"));
    const paragraphs = article?.text.split("\n\n") ?? [];
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    for (const paragraph of paragraphs) {
      expect(paragraph).not.toMatch(/\s{2,}/);
    }
  });

  it("falls back to <body> when the page has no article or main landmark", () => {
    const article = extractArticle(loadFixture("bare.html"));
    expect(article).not.toBeNull();
    expect(article?.title).toBe("Kaffeekultur - Beispielblog");
    expect(article?.lang).toBe("de");
    expect(article?.text).toContain("Kaffee kam im siebzehnten Jahrhundert nach Europa");
    expect(article?.text).not.toContain("Archiv");
    expect(article?.text).not.toContain("Impressum");
    expect(article?.text).not.toContain("Entwurfstext");
  });

  it("returns null when there is not enough body text", () => {
    const { document } = parseHTML("<html><body><p>Too short.</p></body></html>");
    expect(extractArticle(document as unknown as Document)).toBeNull();
  });
});
