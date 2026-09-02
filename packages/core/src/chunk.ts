// Fits article text into a model's context budget. v1 sends a single prompt:
// text beyond the budget is dropped on a paragraph boundary and reported as
// truncated so the UI can say so. Multi-chunk synthesis is a later task.

/** Conservative for English prose; measured ~4.65 on a long news feature with the gemma tokenizer. */
const CHARS_PER_TOKEN = 4;

/** System prompt, format instruction, title, and chat template. */
const PROMPT_OVERHEAD_TOKENS = 256;

/** Fallback when the runtime cannot report its context: ~5k tokens, safe for common 8k-context local models. */
export const DEFAULT_INPUT_CHAR_BUDGET = 20_000;

/** A tiny context has no room for the generation cap; send ~1k tokens of article rather than nothing. */
export const MIN_INPUT_CHAR_BUDGET = 4_000;

/** ~40k tokens: keeps prompt processing on a laptop within tens of seconds. Longer pages wait for chunking. */
export const MAX_INPUT_CHAR_BUDGET = 160_000;

/**
 * Ceiling on generated tokens: words-to-tokens headroom so a runaway
 * generation cannot go on forever, plus a flat extra for models that cannot
 * disable thinking and would otherwise spend the whole budget reasoning.
 */
export function outputTokenCap(maxWords: number): number {
  return maxWords * 4 + 4096;
}

/** Below this the model cannot finish even a one-liner; a context this small is unusable anyway. */
const MIN_OUTPUT_TOKENS = 256;

export interface BudgetInput {
  /** Context length of the loaded model in tokens; null when the runtime does not report it. */
  contextTokens: number | null;
  maxWords: number;
}

export interface Budget {
  /** Characters of article text to send. */
  inputChars: number;
  /** Cap on generated tokens to request; never overlaps the input inside a known context. */
  outputTokens: number;
}

/**
 * Splits a known context between article text and generation so the two
 * never overlap: the article gets what is left after the full generation cap,
 * and when the context is too small for that (the floor kicks in) the cap
 * shrinks to what remains instead. Unknown contexts get the fixed defaults.
 */
export function planBudget({ contextTokens, maxWords }: BudgetInput): Budget {
  const cap = outputTokenCap(maxWords);
  if (contextTokens === null || !Number.isFinite(contextTokens)) {
    return { inputChars: DEFAULT_INPUT_CHAR_BUDGET, outputTokens: cap };
  }
  const available = (contextTokens - cap - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN;
  const inputChars = Math.min(MAX_INPUT_CHAR_BUDGET, Math.max(MIN_INPUT_CHAR_BUDGET, Math.floor(available)));
  const remaining = contextTokens - PROMPT_OVERHEAD_TOKENS - Math.ceil(inputChars / CHARS_PER_TOKEN);
  if (remaining >= MIN_OUTPUT_TOKENS) {
    return { inputChars, outputTokens: Math.min(cap, remaining) };
  }
  // Too small even for the input floor plus the output floor: the input
  // yields, down to nothing, so the request still fits the context.
  const inputTokens = Math.max(0, contextTokens - PROMPT_OVERHEAD_TOKENS - MIN_OUTPUT_TOKENS);
  return { inputChars: inputTokens * CHARS_PER_TOKEN, outputTokens: MIN_OUTPUT_TOKENS };
}

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
