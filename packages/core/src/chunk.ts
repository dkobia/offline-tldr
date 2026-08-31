// Fits article text into a model's context budget. v1 sends a single prompt:
// text beyond the budget is dropped on a paragraph boundary and reported as
// truncated so the UI can say so. Multi-chunk synthesis is a later task.

/** Roughly 5k tokens at ~4 chars/token; safe for common 8k-context local models. */
export const DEFAULT_INPUT_CHAR_BUDGET = 20_000;

export interface FittedText {
  text: string;
  truncated: boolean;
}

export function fitToBudget(text: string, maxChars: number = DEFAULT_INPUT_CHAR_BUDGET): FittedText {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const paragraphs = text.split("\n\n");
  const kept: string[] = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const cost = paragraph.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > maxChars) {
      break;
    }
    kept.push(paragraph);
    used += cost;
  }

  // A single paragraph larger than the whole budget: hard-cut it.
  if (kept.length === 0) {
    return { text: text.slice(0, maxChars), truncated: true };
  }
  return { text: kept.join("\n\n"), truncated: true };
}
