// The Platform interface is the only seam through which browser-specific APIs
// are reached. chrome.* / browser.* never appear outside platform/.

/** A long-lived message channel (chrome.runtime.Port / browser.runtime.Port). */
export interface PlatformPort {
  readonly name: string;
  postMessage(message: unknown): void;
  onMessage(callback: (message: unknown) => void): void;
  onDisconnect(callback: () => void): void;
  disconnect(): void;
}

/**
 * One-shot message handler. Return a promise to answer the message, or
 * undefined to leave it for another handler.
 */
export type MessageHandler = (message: unknown, senderTabId: number | undefined) => Promise<unknown> | undefined;

/**
 * The tab the user is looking at in the last focused window. Deliberately
 * carries no URL: without the "tabs" permission the tabs API scrubs it
 * (content-script match patterns don't lift that), so the URL must be asked
 * of the tab's content script instead.
 */
export interface ActiveTab {
  id: number;
  /** True once the tab has finished loading. */
  complete: boolean;
}

export interface Platform {
  /** Which build this is; used for target-specific styling, never for logic branches. */
  readonly name: "chrome" | "firefox";

  getSetting<T>(key: string, fallback: T): Promise<T>;
  setSetting<T>(key: string, value: T): Promise<void>;

  /**
   * Session-scoped storage (storage.session): survives background restarts
   * within a browser session, cleared when the browser exits. Holds the
   * per-tab summary store, which must not outlive the tabs it describes.
   */
  getSessionValue<T>(key: string, fallback: T): Promise<T>;
  setSessionValue<T>(key: string, value: T): Promise<void>;

  /** Sends a one-shot message to the background and awaits the response. */
  sendMessage(message: unknown): Promise<unknown>;
  /** Sends a one-shot message to the content script of a tab. Rejects when the tab has no listener. */
  sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
  onMessage(handler: MessageHandler): void;

  /** Opens a long-lived port to the background. */
  connect(name: string): PlatformPort;
  onConnect(callback: (port: PlatformPort) => void): void;

  /** The tab the user is looking at in the last focused window. */
  getActiveTab(): Promise<ActiveTab | undefined>;

  /**
   * Notifies when the active page may have changed: tab switch, a page load
   * finishing, or an in-page (SPA) URL change on the active tab. Callers
   * re-query getActiveTab and decide; the events carry no payload.
   */
  onActiveTabChanged(listener: () => void): void;

  /** Notifies when a tab is closed; the background drops that tab's summary state. */
  onTabRemoved(listener: (tabId: number) => void): void;

  /**
   * Injects the content script into a tab. Needed for tabs that were already
   * open when the extension was installed or reloaded: declared content
   * scripts are only added to pages loaded afterwards.
   */
  injectContentScript(tabId: number): Promise<void>;

  /** Chrome: make the toolbar button open the side panel. Firefox: no-op (popup). */
  initPanelBehavior(): void;
}
