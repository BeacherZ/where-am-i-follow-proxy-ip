# Where Am I — Follow Proxy IP

<p align="center"><a href="README_EN.md">English</a> ｜ 简体中文</p>

> 让浏览器的**时区**和**定位**跟着代理出口 IP 走，国外网站看到的信息不再自相矛盾。

[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-green)](https://greasyfork.org/en/scripts/600207-where-am-i-follow-proxy-ip)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Version](https://img.shields.io/badge/version-6.6.6-blue)](where-am-i-follow-proxy-ip.user.js)

---

## 它解决什么问题

用代理访问国外站点时，网站会同时看到两组互相打脸的信号：

| 信号 | 实际值 | 网站的判断 |
| --- | --- | --- |
| 出口 IP | 日本东京 | 「你在日本」 |
| JS 时区 / 定位 | 中国上海 | 「你在上海」 |

结论很直接：**代理 + 本地时区 = 高风险**。风控系统不需要确凿证据，这种自相矛盾本身就够扣分了。

本脚本在页面最早期（`document-start`）接管相关 API，让下面这些值一起跟随出口 IP：

- `navigator.geolocation.getCurrentPosition` / `watchPosition` / `clearWatch`
- `navigator.permissions.query({name:'geolocation'})`
- `Intl.DateTimeFormat` 的默认时区
- `Date.prototype.getTimezoneOffset`，以及全部本地时间 getter / setter
- `Date.prototype.toString` / `toDateString` / `toTimeString`（含时区缩写）
- `window.Date` 构造器与 `toLocale*` 系列

实测在 ippure.com/claude 的风险检测中可降低约 **36 个百分点**。不止 Claude —— 所有会读时区 / 定位的境外站点通用。

## 工作原理

```
出口 IP  →  多源反查归属地（IP 投票）  →  得出国家 / 坐标 / 时区
                                              ↓
                              覆盖页面能读到的 Geolocation / Intl / Date
```

- IP 每 5 秒复检一次，页面隐藏时暂停，切节点后自动重算
- 结果缓存 6 小时，冷启动先用缓存同步点亮，保证首个 API 调用就是对的
- 4 个数据源交叉投票（ipwho.is / freeipapi / ipinfo / ipapi.co），国家、坐标、时区强制同源自洽，绝不拼凑
- 坐标加 30–80 米随机精度与抖动，避免固定指纹

## 安装

**方式一：Greasy Fork（推荐，自动更新）**

<https://greasyfork.org/en/scripts/600207-where-am-i-follow-proxy-ip>

**方式二：直接装 GitHub 版**

打开 [`where-am-i-follow-proxy-ip.user.js`](https://raw.githubusercontent.com/BeacherZ/where-am-i-follow-proxy-ip/main/where-am-i-follow-proxy-ip.user.js)，Tampermonkey / Violentmonkey 会自动弹出安装页。

## 配套（必读）

脚本只能改页面里的 JS。有两层它够不到：

### ① WebRTC —— 必装扩展

脚本**默认不管 WebRTC**（`rtcProtection: 'off'`），交给网络层扩展处理。

- [WebRTC Protect — Protect IP Leak](https://microsoftedge.microsoft.com/addons/detail/webrtc-protect-protect-/lnnodkiklhcbkbflgphcklfoiagapkhc)（Edge / Chrome 商店均有）

> 为什么不在脚本里堵？ICE 的 IP 有 3 条读取通道：`icecandidate` 事件、`localDescription.sdp`、`getStats()`。脚本只能堵第一条，剩下两条依旧是原文，反而留下「事件里没候选、SDP 里却有」的跨通道矛盾——检测站交叉比对即可判定 API 被改写，**比不堵更可疑**。扩展改的是 `chrome.privacy.network.webRTCIPHandlingPolicy`，候选根本不生成，三条通道一起干净。

扩展里选 **Use my proxy server (if present)**，然后用 <https://browserleaks.com/webrtc> 复验：候选应只剩 `.local` 或为空。

### ② Accept-Language 请求头 —— JS 改不了

`navigator.language` 可以改，HTTP 请求头不能。两边不同步就是硬矛盾，所以脚本默认 `langMode: 'off'`（**保持真实语言，不做半套伪装**）。

想彻底对齐，二选一：

- 把浏览器界面语言改成 **English**，并把 `CONFIG.langMode` 设为 `'en'` —— 请求头天然一致，不需要任何额外工具
- 装改写请求头的扩展（Header Editor 之类），再把 `CONFIG.langMode` 设为 `'match'` —— 跟随出口地区语言

## 使用前提

代理软件用「**绕过大陆**」或全局模式，让目标网站与 `api.ipify.org` 走同一条路。否则脚本查到的是直连 IP，跟网站看到的不一致。

## 国内站点自动跳过

命中 `.cn` 或内置国内域名列表（淘宝、B 站、微信、政府站等 40+ 条）时，**脚本一行代码都不执行**，不影响国内正常访问。

需要追加：

```js
extraDirectHosts: ['example.com'],   // 不启动
forceSpoofHosts:  ['example.com'],   // 强制启动（优先级最高）
```

## 主要配置

脚本顶部的 `CONFIG` 对象：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `debug` | `false` | `true` 输出详细日志 + 自检表（出口 IP / 时区 / toString / 语言一致性） |
| `spoofGeolocation` | `true` | 接管定位与权限 |
| `spoofTimezone` | `true` | 接管 Intl / Date |
| `deepDatePatch` | `true` | 替换 `window.Date`，构造器与 setter 也走目标时区 |
| `stealthToString` | `true` | 伪装被替换函数的 `toString`，避免被取证 |
| `rtcProtection` | `'off'` | `off` / `mdns` / `rewrite` / `filter` / `block` |
| `langMode` | `'off'` | `off` / `match` / `en` |
| `jitterMeters` | `60` | 坐标抖动半径（米），纯 IP 定位可设 `0` |
| `pollMs` | `5000` | IP 复检间隔 |

## 兼容性

- Tampermonkey / Violentmonkey / ScriptCat（Chrome、Edge、Firefox）
- `@grant GM_xmlhttpRequest` 用于跨域查 IP，不受目标站 CSP 影响
- 所有状态都在闭包内，页面上无任何全局变量痕迹

## 免责声明

本项目用于**隐私保护与研究**：防止网站仅凭「IP 与本地时区不一致」就对你做过度画像。请遵守你所在地区的法律法规，不要用于绕过任何服务的使用条款。作者不对使用后果承担责任。

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)

---

## English

A userscript that makes the browser's **timezone** and **geolocation** follow your proxy's exit IP, so overseas sites stop seeing self-contradictory signals (exit IP says Tokyo, JS timezone says Shanghai).

- Hooks `Geolocation`, `Permissions`, `Intl.DateTimeFormat`, and the whole local-time surface of `Date` (including `window.Date` itself) at `document-start`.
- Exit IP is re-checked every 5s, resolved through 4 geo-IP providers with majority voting, cached for 6h.
- Skips Chinese domains entirely — the script does not run on them.
- WebRTC is intentionally **not** patched by default; pair it with [WebRTC Protect](https://microsoftedge.microsoft.com/addons/detail/webrtc-protect-protect-/lnnodkiklhcbkbflgphcklfoiagapkhc) at the network layer.

Install: <https://greasyfork.org/en/scripts/600207-where-am-i-follow-proxy-ip>
