import type { ActiveTab, MessageHandler, Platform, PlatformPort } from "./types";

function wrapPort(port: chrome.runtime.Port): PlatformPort {
  return {
    name: port.name,
    postMessage: (message) => port.postMessage(message),
    onMessage: (callback) => port.onMessage.addListener(callback),
    onDisconnect: (callback) => port.onDisconnect.addListener(callback),
    disconnect: () => port.disconnect(),
  };
}

export const platform: Platform = {
  name: "chrome",

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const stored = await chrome.storage.local.get(key);
    return (stored[key] as T | undefined) ?? fallback;
  },

  async setSetting<T>(key: string, value: T): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },

  async getSessionValue<T>(key: string, fallback: T): Promise<T> {
    const stored = await chrome.storage.session.get(key);
    return (stored[key] as T | undefined) ?? fallback;
  },

  async setSessionValue<T>(key: string, value: T): Promise<void> {
    await chrome.storage.session.set({ [key]: value });
  },

  sendMessage(message: unknown): Promise<unknown> {
    return chrome.runtime.sendMessage(message);
  },

  sendTabMessage(tabId: number, message: unknown): Promise<unknown> {
    return chrome.tabs.sendMessage(tabId, message);
  },

  onMessage(handler: MessageHandler): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const result = handler(message, sender.tab?.id);
      if (result === undefined) {
        return false;
      }
      result.then(sendResponse, (error: unknown) => {
        console.error("[offline-tldr] message handler failed", error);
        sendResponse(undefined);
      });
      // Keep the response channel open for the async handler.
      return true;
    });
  },

  connect(name: string): PlatformPort {
    return wrapPort(chrome.runtime.connect({ name }));
  },

  onConnect(callback: (port: PlatformPort) => void): void {
    chrome.runtime.onConnect.addListener((port) => callback(wrapPort(port)));
  },

  async getActiveTab(): Promise<ActiveTab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) {
      return undefined;
    }
    const active: ActiveTab = { id: tab.id, complete: tab.status === "complete" };
    return active;
  },

  onActiveTabChanged(listener: () => void): void {
    chrome.tabs.onActivated.addListener(() => listener());
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      // Loads finishing only; intermediate "loading" noise is dropped, and SPA
      // navigations arrive via the content script's page-changed notice.
      if (tab.active && changeInfo.status === "complete") {
        listener();
      }
    });
  },

  onTabRemoved(listener: (tabId: number) => void): void {
    chrome.tabs.onRemoved.addListener((tabId) => listener(tabId));
  },

  async injectContentScript(tabId: number): Promise<void> {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  },

  initPanelBehavior(): void {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error: unknown) => console.error("[offline-tldr] sidePanel behavior failed", error));
  },
};
