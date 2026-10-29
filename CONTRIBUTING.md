# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## The one rule

**The extension never collects data.** No analytics, telemetry, remote config, error reporting, accounts or third-party scripts. The extension's own code makes no network requests. Anything that breaks this won't be merged, however useful it is.

## Getting started

There is no build step and there are no dependencies.

1. Clone the repository.
2. Open `chrome://extensions`, turn on **Developer mode** and click **Load unpacked**. Pick the repository folder.
3. After a change, click the reload icon on the extension's card. Reopen the popup to see popup changes.

To debug, use **Inspect** on the popup and the **service worker** link on the extension's card.

## How it fits together

| File | Runs in | Does |
|---|---|---|
| `popup.html`, `popup.js`, `popup.css` | Popup | The whole UI. Reads and writes the sets in `chrome.storage.local` |
| `background.js` | Service worker | Turns sets into `declarativeNetRequest` rules (headers, blocking) and updates the toolbar badge |
| `content.js` | Content script | Bridges stored sets to the page and injects the two scripts below |
| `page-interceptor.js` | Page | Wraps `fetch()` to apply body mods, header mods and blocking |
| `core.js` | All of the above | Shared matching and rewriting logic (`ModCore`) |

Sets are stored under the `modSets` key. Saved data must stay readable by older and newer versions: add fields, don't rename or remove them.

## Making changes

- Match the surrounding code: two-space indentation, double quotes, semicolons, plain browser JavaScript.
- Keep it dependency-free.
- No build step is nice to keep, but not required. Add one if it pays for itself.
- Mods in a set run in list order. Keep that true in both `background.js` and `page-interceptor.js`.
- Header and block behavior exists twice: as network rules in `background.js` and as `fetch()` handling in `page-interceptor.js`. Change both together.
- If you add or change a permission, update its justification in [store/listing.md](store/listing.md).
- Add a line under a new heading at the top of [CHANGELOG.md](CHANGELOG.md).

## Testing

There is no automated test suite yet. Before opening a pull request, check by hand:

- Create, edit, reorder, duplicate and delete sets and mods. Then undo a delete.
- Every mod type against a real page. The page's **Network** panel in DevTools shows header changes and blocked requests.
- Import and export, with both merge and replace.
- Light and dark mode.

## Store images

If you change the popup's look, regenerate the store images:

```sh
store/render.sh
```

It renders the real popup with stubbed extension APIs into `store/*.png`, and a popup screenshot for the website, using Google Chrome in headless mode. Set `CHROME` to point at another Chrome binary. Demo data is in `store/src/demo-stub.js`.

## Website

`docs/` is the site at https://omrilotan.com/http-mod-sets/, published with GitHub Pages. It holds the landing page, the privacy policy and the terms of service as plain HTML. Update the privacy policy whenever the extension's data handling or permissions change.
