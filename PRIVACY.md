# Privacy Policy

**Offline TL;DR**

Last updated: 31 August 2026

## Summary

Offline TL;DR does not collect, transmit, store, or sell any personal data.
There are no analytics, no error reporting, no accounts, and no servers operated by the developer.
The extension communicates only with software running on your own computer.

## What the extension accesses

To summarize a page, the extension reads the text of that page and its address.
This happens on your device, in your browser.

The extracted text is then sent to a local inference server that you run yourself, at an address on `localhost` or `127.0.0.1` that you configure in the extension's settings.
Examples are Ollama, LM Studio, and a llama.cpp server.
That server is on your machine, under your control, and is not operated by the developer of this extension.

No page content, no page address, no prompt, and no metadata is ever sent to the developer or to any third party.

The extension declares access only to `localhost` and `127.0.0.1`.
It requests no other hosts.
In addition, the address you configure is checked against a list of local hostnames before every request, so page content cannot be sent to a remote server even if the stored setting were altered.

## What the extension stores

Two kinds of data are stored locally in your browser profile.
Neither is uploaded anywhere.

- **Settings.** The selected engine, its localhost address, the model name, the summary format, and the length cap. These persist until you change them or remove the extension.
- **Summaries.** The summary text for each open tab, kept so that a summary survives a background restart while your browser is running. This is cleared when the browser session ends.

Removing the extension deletes both.

## Permissions

- **`activeTab` and `scripting`** let the extension read the article text of the page you asked it to summarize.
- **`storage`** keeps your settings and per-tab summaries, as described above.
- **`sidePanel`** displays the extension's own interface. It does not read page content.
- **Access to `localhost` and `127.0.0.1`** lets the extension reach the local inference server you run.

The extension's content script is registered for all sites, because you may ask for a summary of any page you are reading.
It reads the page's article text and address only, and only when the extension asks it to.

## Third parties

There are none.
No data is shared with, sold to, or transferred to any third party, and none is used for advertising, profiling, or creditworthiness.

## Children

The extension collects no data from anyone, including children.

## Changes

Any change to this policy will be published in this file, in the extension's public repository, with an updated date above.

## Contact

Questions or concerns: https://github.com/dkobia/offline-tldr/issues
