// Content script. Thin by design: hands the live Document to core's extractor
// when the background asks and returns the clean article, nothing else.
// It also answers for the page URL - the tabs API scrubs tab.url without the
// "tabs" permission, so location.href here is the only URL the extension sees.

import { platform } from "@platform";
import { extractArticle } from "@offline-tldr/core";
import type { ExtractArticleResponse, GetPageUrlResponse, PageChangedNotice } from "@offline-tldr/shared";

// The background injects this script on demand into tabs that predate the
// extension load; the guard keeps a second injection from adding a second
// listener. The flag lives in the extension's isolated world, not the page's.
const LOADED_FLAG = "__offlineTldrContentReady";
const world = globalThis as Record<string, unknown>;

if (!world[LOADED_FLAG]) {
  world[LOADED_FLAG] = true;
  platform.onMessage((message) => {
    switch ((message as { type?: string })?.type) {
      case "extract-article": {
        const article = extractArticle(document);
        const response: ExtractArticleResponse = article ? { ok: true, article } : { ok: false, error: "no-content" };
        return Promise.resolve(response);
      }
      case "get-page-url": {
        const response: GetPageUrlResponse = { url: location.href };
        return Promise.resolve(response);
      }
      default:
        return undefined;
    }
  });

  // Same-document (SPA) navigations never reach tabs.onUpdated as a load, so
  // announce them for the panel's auto-summarize mode. The Navigation API is
  // not available everywhere (Firefox); pages without it just miss SPA auto
  // runs. The catch swallows "no receiver" rejections when no panel is open.
  const notice: PageChangedNotice = { type: "page-changed" };
  (globalThis as { navigation?: EventTarget }).navigation?.addEventListener("currententrychange", () => {
    void platform.sendMessage(notice).catch(() => {});
  });
}
