// Heuristic readability-style extraction. Works on any standard Document,
// including linkedom documents in tests; never touches browser extension APIs.

import type { ExtractedArticle } from "./index";

/** Elements that never contain article body text. */
const JUNK_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "nav",
  "header",
  "footer",
  "aside",
  "dialog",
  "[hidden]",
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
].join(",");

/** Block-level elements whose text is collected, in document order. */
const BLOCK_SELECTOR = "p, li, h2, h3, h4, h5, h6, blockquote, pre, dt, dd, figcaption";

/** Content roots tried in order of preference. */
const ROOT_SELECTORS = ["article", '[role="main"]', "main"];

/** A root must carry at least this much text to be chosen over the fallback. */
const MIN_ROOT_CHARS = 400;

/** Below this much body text the page is not worth summarizing. */
const MIN_ARTICLE_CHARS = 200;

export function extractArticle(doc: Document): ExtractedArticle | null {
  const root = pickRoot(doc);
  if (!root) {
    return null;
  }

  const clone = root.cloneNode(true) as Element;
  for (const junk of [...clone.querySelectorAll(JUNK_SELECTOR)]) {
    junk.remove();
  }

  const paragraphs: string[] = [];
  const seen = new Set<string>();
  for (const block of clone.querySelectorAll(BLOCK_SELECTOR)) {
    // Nested blocks (e.g. p inside li) would duplicate text; keep outermost only.
    if (block.parentElement?.closest(BLOCK_SELECTOR)) {
      continue;
    }
    const text = collapseWhitespace(block.textContent ?? "");
    if (text.length === 0 || seen.has(text)) {
      continue;
    }
    seen.add(text);
    paragraphs.push(text);
  }

  const text = paragraphs.join("\n\n");
  if (text.length < MIN_ARTICLE_CHARS) {
    return null;
  }

  const article: ExtractedArticle = { title: pickTitle(doc, root), text };
  const lang = doc.documentElement.getAttribute("lang");
  if (lang) {
    article.lang = lang;
  }
  return article;
}

function pickRoot(doc: Document): Element | null {
  for (const selector of ROOT_SELECTORS) {
    const candidate = doc.querySelector(selector);
    if (candidate && collapseWhitespace(candidate.textContent ?? "").length >= MIN_ROOT_CHARS) {
      return candidate;
    }
  }
  return doc.body ?? null;
}

function pickTitle(doc: Document, root: Element): string {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  if (og && og.trim().length > 0) {
    return collapseWhitespace(og);
  }
  const h1 = root.querySelector("h1")?.textContent ?? doc.querySelector("h1")?.textContent;
  if (h1 && h1.trim().length > 0) {
    return collapseWhitespace(h1);
  }
  return collapseWhitespace(doc.title ?? "");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
