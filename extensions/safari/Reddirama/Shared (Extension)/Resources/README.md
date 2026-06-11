# Reddirama browser extension (Chrome / Firefox)

The same Reddirama, packaged as a browser extension instead of a userscript: one click, no userscript
manager to install. It is **generated from the same source** as the userscript (`src/` +
`userscript/build.mjs`), so the two never drift apart.

The extension injects a small content script on reddit.com that adds the **Reddirama** button. The
slideshow itself runs in the hosted viewer (GitHub Pages), exactly like the userscript. Nothing is
stored anywhere; your data goes only between you, Reddit and the viewer.

> `content.js` and `manifest.json` are **generated**, do not edit them by hand. Change `src/` and run
> `node userscript/build.mjs`.

## Load it (unpacked, for testing)

**Chrome / Edge / Brave:**
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. Open reddit.com (logged in): the **Reddirama** button appears bottom-right.

**Firefox (142+):**
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `extension/manifest.json`.
3. Open reddit.com (logged in). Temporary add-ons are removed when Firefox restarts.

## Publish (optional)

- **Chrome Web Store:** zip the contents of `extension/`, upload on the
  [Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time 5 USD registration fee).
- **Firefox Add-ons (AMO):** submit the zip on [addons.mozilla.org](https://addons.mozilla.org/developers/) (free).

## Notes

- The content script runs in the page's **MAIN world** (like the `@grant none` userscript), so it can
  read your Reddit session and open the viewer the same way. Content scripts are exempt from Reddit's CSP.
- Firefox needs **142+** (for `world: "MAIN"` and the `data_collection_permissions` manifest key).
