// Page identity for summary state: which URL changes count as "a different
// page". Shared by the panel's auto-summarize policy and the background's
// per-tab store so both invalidate on the same rule.

/**
 * Canonical identity of a summarizable page, or null when the URL is not one
 * (non-http(s) schemes, malformed URLs). The fragment is ignored: in-page
 * jumps and scroll-position replaceState churn are not new content.
 */
export function pageKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  parsed.hash = "";
  return parsed.href;
}
