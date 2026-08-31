import type { ActiveTab, MessageHandler, Platform, PlatformPort } from "./types";

function wrapPort(port: browser.runtime.Port): PlatformPort {
  return {
    name: port.name,
    postMessage: (message) => port.postMessage(message),
    onMessage: (callback) => port.onMessage.addListener(callback),
    onDisconnect: (callback) => port.onDisconnect.addListener(() => callback()),
    disconnect: () => port.disconnect(),
  };
}

export const platform: Platform = {
  name: "firefox",

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const stored = await browser.storage.local.get(key);
    return (stored[key] as T | undefined) ?? fallback;
  },

  async setSetting<T>(key: string, value: T): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },

  sendMessage(message: unknown): Promise<unknown> {
    return browser.runtime.sendMessage(message);
  },

  sendTabMessage(tabId: number, message: unknown): Promise<unknown> {
    return browser.tabs.sendMessage(tabId, message);
  },

  onMessage(handler: MessageHandler): void {
    browser.runtime.onMessage.addListener((message, sender) => {
      // Returning a promise answers the message; undefined leaves it unhandled.
      return handler(message, sender.tab?.id) as Promise<unknown>;
    });
  },

  connect(name: string): PlatformPort {
    return wrapPort(browser.runtime.connect({ name }));
  },

  onConnect(callback: (port: PlatformPort) => void): void {
    browser.runtime.onConnect.addListener((port) => callback(wrapPort(port)));
  },

  async getActiveTab(): Promise<ActiveTab | undefined> {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) {
      return undefined;
    }
    const active: ActiveTab = { id: tab.id, complete: tab.status === "complete" };
    return active;
  },

  onActiveTabChanged(listener: () => void): void {
    browser.tabs.onActivated.addListener(() => listener());
    browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      // Loads finishing only; intermediate "loading" noise is dropped, and SPA
      // navigations arrive via the content script's page-changed notice.
      if (tab.active && changeInfo.status === "complete") {
        listener();
      }
    });
  },

  async injectContentScript(tabId: number): Promise<void> {
    await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  },

  initPanelBehavior(): void {
    // Firefox uses an action popup; nothing to configure.
  },
};
