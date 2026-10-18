# Where Am I — Follow Proxy IP

<p align="center">English ｜ <a href="README.md">简体中文</a></p>

> Makes the browser's **timezone** and **geolocation** follow your proxy's exit IP, so overseas sites stop receiving self-contradictory signals.

[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-install-green)](https://greasyfork.org/en/scripts/600207-where-am-i-follow-proxy-ip)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Version](https://img.shields.io/badge/version-6.6.6-blue)](where-am-i-follow-proxy-ip.user.js)

---

## The problem it solves

When you visit an overseas site through a proxy, the site sees two signals that contradict each other:

| Signal | Actual value | What the site concludes |
| --- | --- | --- |
| Exit IP | Tokyo, Japan | "You are in Japan" |
| JS timezone / geolocation | Shanghai, China | "You are in Shanghai" |

The conclusion writes itself: **proxy + local timezone = high risk**. A risk engine does not need hard evidence — that contradiction alone costs you points.

This script takes over the relevant APIs at the earliest possible moment (`document-start`), so all of the following follow the exit IP together:

- `navigator.geolocation.getCurrentPosition` / `watchPosition` / `clearWatch`
- `navigator.permissions.query({name:'geolocation'})`
- The default timezone of `Intl.DateTimeFormat`
- `Date.prototype.getTimezoneOffset` plus every local-time getter / setter
- `Date.prototype.toString` / `toDateString` / `toTimeString` (including timezone abbreviations)
- The `window.Date` constructor and the whole `toLocale*` family

Measured on ippure.com/claude, the risk score drops by roughly **36 percentage points**. And it is not Claude-specific — it works on any overseas site that reads timezone or geolocation.

## How it works

```
Exit IP  →  multi-source reverse lookup (IP voting)  →  country / coordinates / timezone
                                                          ↓
                                       override Geolocation / Intl / Date as seen by the page
```

- The IP is re-checked every 5 seconds, paused while the tab is hidden, and recomputed after you switch nodes
- Results are cached for 6 hours; a cold start lights up from cache synchronously so the very first API call is already correct
- Four data sources vote (ipwho.is / freeipapi / ipinfo / ipapi.co); country, coordinates, and timezone must come from the same source — never stitched together
- Coordinates get 30–80 m of random precision and jitter to avoid a fixed fingerprint

## Install

**Option 1: Greasy Fork (recommended, auto-updates)**

<https://greasyfork.org/en/scripts/600207-where-am-i-follow-proxy-ip>

**Option 2: install the GitHub version**

Open [`where-am-i-follow-proxy-ip.user.js`](https://raw.githubusercontent.com/BeacherZ/where-am-i-follow-proxy-ip/main/where-am-i-follow-proxy-ip.user.js) — Tampermonkey / Violentmonkey will offer the install page automatically.

## Companion setup (required reading)

The script can only patch JavaScript inside the page. Two layers are out of its reach:

### ① WebRTC — install an extension

The script **does not touch WebRTC by default** (`rtcProtection: 'off'`); leave that to a network-layer extension.

- [WebRTC Protect — Protect IP Leak](https://microsoftedge.microsoft.com/addons/detail/webrtc-protect-protect-/lnnodkiklhcbkbflgphcklfoiagapkhc) (available in the Edge and Chrome stores)

> Why not block it inside the script? ICE exposes the IP through three channels: the `icecandidate` event, `localDescription.sdp`, and `getStats()`. The script can only cover the first one, and the other two would still show the real value — leaving a cross-channel contradiction ("no candidate in the event, but an IP in the SDP"). Detection sites can cross-check that and conclude the API was tampered with, which is **more suspicious than not patching at all**. An extension changes `chrome.privacy.network.webRTCIPHandlingPolicy`, so candidates are never generated and all three channels stay clean.

In the extension choose **Use my proxy server (if present)**, then verify at <https://browserleaks.com/webrtc>: candidates should be `.local` only, or empty.

### ② Accept-Language header — JavaScript cannot change it

`navigator.language` can be spoofed; the HTTP request header cannot. Any mismatch is a hard contradiction, so the script defaults to `langMode: 'off'` (**keep your real language — no half-finished disguise**).

To align them fully, pick one:

- Set your browser UI language to **English** and set `CONFIG.langMode` to `'en'` — the header matches naturally, no extra tooling needed
- Install a header-rewriting extension (Header Editor and friends), then set `CONFIG.langMode` to `'match'` — follow the exit region's language

## Prerequisites

Use "bypass mainland" or global mode in your proxy client so the target site and `api.ipify.org` take the same path. Otherwise the script resolves your direct IP, which differs from what the site sees.

## Chinese sites are skipped automatically

On `.cn` domains or any of the 40+ built-in Chinese domains (Taobao, Bilibili, WeChat, government sites, and more) the script **does not execute a single line**, so normal domestic browsing is unaffected.

To extend the list:

```js
extraDirectHosts: ['example.com'],   // do not run
forceSpoofHosts:  ['example.com'],   // force it to run (highest priority)
```

## Main configuration

The `CONFIG` object at the top of the script:

| Key | Default | Description |
| --- | --- | --- |
| `debug` | `false` | `true` prints verbose logs plus a self-check table (exit IP / timezone / toString / language consistency) |
| `spoofGeolocation` | `true` | Take over geolocation and permissions |
| `spoofTimezone` | `true` | Take over Intl / Date |
| `deepDatePatch` | `true` | Replace `window.Date` so constructors and setters also use the target timezone |
| `stealthToString` | `true` | Disguise the `toString` of replaced functions to resist forensics |
| `rtcProtection` | `'off'` | `off` / `mdns` / `rewrite` / `filter` / `block` |
| `langMode` | `'off'` | `off` / `match` / `en` |
| `jitterMeters` | `60` | Coordinate jitter radius in meters; set `0` for pure IP geolocation |
| `pollMs` | `5000` | IP re-check interval |

## Compatibility

- Tampermonkey / Violentmonkey / ScriptCat (Chrome, Edge, Firefox)
- `@grant GM_xmlhttpRequest` is used for cross-origin IP lookups, so the target site's CSP does not apply
- All state lives inside a closure — no global variables are left on the page

## Disclaimer

This project is meant for **privacy protection and research**: it prevents sites from over-profiling you simply because your IP and local timezone disagree. Follow the laws of your jurisdiction and do not use it to circumvent any service's terms. The author is not responsible for the consequences of use.

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
