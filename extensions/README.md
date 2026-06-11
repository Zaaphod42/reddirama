# Reddirama browser extensions

Reddirama ships as a browser extension for **Chrome / Edge / Brave**, **Firefox**, and (experimentally) **Safari** — all generated from the same shared code in [`../src/`](../src/) via `node ../userscript/build.mjs`.

## Folders

- [`chrome-firefox/`](chrome-firefox/) — the WebExtension (MV3) package used by **both Chrome and Firefox** (it's a single package; the `gecko` block in the manifest is simply ignored by Chrome). This is what is uploaded to the Chrome Web Store and to Firefox Add-ons. See its [README](chrome-firefox/README.md).
- [`safari/`](safari/) — an **experimental Safari** build: an Xcode project (macOS + iOS) that wraps the same extension. Not on the App Store; build it yourself (see below).

`chrome-firefox/{manifest.json, content.js, icons/}` are **generated** by `userscript/build.mjs`. The build also copies them into the Safari project so the two stay in sync. Don't edit the generated files by hand — change `src/` and rebuild.

## Build the Safari version yourself

Requires macOS with **Xcode**.

1. In Safari, show the Develop menu (**Settings → Advanced → Show features for web developers**), then enable **Develop → Allow Unsigned Extensions**.
2. Open `safari/Reddirama/Reddirama.xcodeproj` in Xcode.
3. Select the **Reddirama (macOS)** scheme and run (Cmd+R).
4. Now enable the extension in **Safari → Settings → Extensions**, and allow it on **reddit.com**.

Safari ignores the `world: "MAIN"` manifest key (the content script runs in the isolated world), but Reddirama works there too.

### Make it stay (sign it)

An **unsigned** local build is disabled every time you quit Safari (the "Allow Unsigned Extensions" toggle resets). To keep it permanently, **sign it** with your own Apple ID:

1. In Xcode, select each target (the **macOS app** and the **macOS Extension**) → **Signing & Capabilities** → check **Automatically manage signing** and pick your **Team**. (A free Apple ID re-signs about every 7 days; a paid Apple Developer account lasts about a year.)
2. Build and run again. The extension is now signed, stays enabled across restarts, and no longer needs "Allow Unsigned Extensions".

The committed project has **no Team** set on purpose, so everyone builds with their own Apple ID. Your signing key stays in your macOS Keychain — it is never part of the project or the repo.

## Regenerate everything

From the repo root:

```bash
node userscript/build.mjs   # regenerates chrome-firefox/ and syncs it into safari/
```
