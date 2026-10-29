# Chrome Web Store listing

Paste these into the developer dashboard. Images are rendered by `store/render.sh` from `store/src/`.

## Summary (max 132 characters)

Edit request and response headers, rewrite bodies, block requests. Zero data collection. Open source.

## Description

Rewrite HTTP. Privately.

• Add or change request and response headers
• Rewrite request and response bodies, with regex and $1 captures
• Block any request
• Group mods into sets. Switch them on and off, per set or per mod
• Toolbar badge shows how many sets match the page
• Import and export as JSON

We collect nothing.
No analytics. No accounts. No third parties. No servers.
Your rules stay in your browser. Edited requests go only where they were already going.

Open source: https://github.com/omrilotan/http-mod-sets

Note: body edits apply to requests made with fetch().

## Images

| File | Slot |
|---|---|
| `shot-1-overview.png` | Screenshot 1 (1280×800) |
| `shot-2-edit.png` | Screenshot 2 (1280×800) |
| `shot-3-privacy.png` | Screenshot 3 (1280×800) |
| `promo-small-440x280.png` | Small promo tile |
| `marquee-1400x560.png` | Marquee promo tile |

## Privacy practices tab

**Single purpose:** Modify HTTP requests and responses (headers, bodies, blocking) using rules the user defines.

**Permission justifications:**

- `storage`: Saves the user's rules locally (`chrome.storage.local`). Nothing syncs or uploads.
- `tabs`: Reads the active tab's URL to show which rules match it (popup and toolbar badge) and to prefill new rules.
- `declarativeNetRequest`: Applies the user's header and block rules.
- Host permissions (`<all_urls>`): Rules can target any site the user chooses. The content script edits page `fetch()` traffic for body rules.
- Remote code: None. All code ships in the package.

**Data usage:** Collects no user data. Check none of the data types. Certify all three disclosures.

**Terms of service URL:** https://omrilotan.com/http-mod-sets/terms/

**Privacy policy URL:** https://omrilotan.com/http-mod-sets/privacy/

**Privacy policy text:** This extension collects no data. Rules are stored locally in your browser and never sent to us or any third party.
