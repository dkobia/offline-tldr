// Builds the system/user message pair for a summarization request.
// Pure string assembly; engines decide how the pair maps onto their API.

import type { SummaryFormat, SummaryRequest } from "./index";

export interface PromptParts {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = [
  "You are a precise summarization assistant.",
  "Summarize strictly from the provided article text; never add outside facts or speculation.",
  "Respond in the same language as the article.",
  "Answer in plain Markdown with no preamble and no closing remarks.",
].join(" ");

export function buildPrompt(request: SummaryRequest): PromptParts {
  const { article, format, maxWords } = request;
  const parts = [formatInstruction(format, maxWords)];
  if (article.title) {
    parts.push(`Title: ${article.title}`);
  }
  parts.push(`Article:\n${article.text}`);
  return { system: SYSTEM_PROMPT, user: parts.join("\n\n") };
}

// Permits (never requests) a table: most articles are not comparative, and the
// panel is narrow, so tables stay an exception for genuinely tabular content.
const TABLE_ALLOWANCE =
  "If the article's key content compares several items along shared attributes (plans, specs, results), you may present that comparison as one small Markdown table with at most 3 columns.";

function formatInstruction(format: SummaryFormat, maxWords: number): string {
  switch (format) {
    case "bullets":
      return `Summarize the article below as 5 to 8 short Markdown bullet points covering the key takeaways. Stay under ${maxWords} words in total. ${TABLE_ALLOWANCE}`;
    case "executive": {
      const paragraphs = maxWords <= 120 ? "1 or 2" : "2 to 4";
      return `Summarize the article below as an executive summary of at most ${maxWords} words. Open with one bold sentence (**like this**) stating the single most important takeaway, then continue in ${paragraphs} short paragraphs, each covering one theme, separated by blank lines. ${TABLE_ALLOWANCE}`;
    }
    case "one-liner":
      return `Summarize the article below in one single sentence of at most ${Math.min(maxWords, 40)} words.`;
  }
}
