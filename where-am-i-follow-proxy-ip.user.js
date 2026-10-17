// ==UserScript==
// @name         Where Am I — Follow Proxy IP
// @namespace    http://tampermonkey.net/
// @version      6.6.6
// @description  让浏览器的时区和定位跟着代理 IP 走，国外网站看到的信息不再自相矛盾。自动跳过国内站点。
// @author       Z健C
// @match        *://*/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.ipify.org
// @connect      api64.ipify.org
// @connect      ipwho.is
// @connect      freeipapi.com
// @connect      ipinfo.io
// @connect      ipapi.co
// @connect      myip.ipip.net
// @connect      4.ipw.cn
// @connect      httpbin.org
// @connect      postman-echo.com
// @license      CC BY-NC-SA 4.0
// @downloadURL https://update.greasyfork.org/scripts/600207/Where%20Am%20I%20%E2%80%94%20Follow%20Proxy%20IP.user.js
// @updateURL https://update.greasyfork.org/scripts/600207/Where%20Am%20I%20%E2%80%94%20Follow%20Proxy%20IP.meta.js
// ==/UserScript==

/*
  Where Am I — Follow Proxy IP

  作用：让浏览器对外暴露的「时区」和「定位」自动跟随出口 IP。
  做法：查出口 IP 的归属地 → 反查该地的时区与坐标 → 覆盖页面能读到的相关 API。
        IP 每 5 秒复检（页面隐藏时暂停，结果缓存 6 小时），换节点后自动重算。

  覆盖
    Geolocation / Permissions   定位坐标、权限状态
    Intl / Date                 默认时区、getTimezoneOffset、本地 getter / setter、
                                toString / toDateString / toTimeString、Date 构造器

  不做
    语言          langMode 默认 'off'，详见 CONFIG 注释
    WebRTC         rtcProtection 默认 'off'，交给 WebRTC Network Limiter 扩展
                   在网络层禁掉非代理 UDP（脚本只堵得住三条读取通道里的一条）
    国内站点       命中国内域名列表 / .cn 时整脚本不启动

  前提：代理软件用「绕过大陆」或全局模式，让目标网站与 api.ipify.org 走同一条路。
*/

(function () {
    'use strict';

    /* ══════════════════════════════════════════════════
       0. 配置
       ══════════════════════════════════════════════════ */
    const CONFIG = {
        debug: false,                 // true → 输出详细日志

        // —— 开关 ——
        spoofGeolocation: true,
        spoofTimezone: true,
        deepDatePatch: true,          // 替换 window.Date（构造器/setter 也走目标时区）
        stealthToString: true,        // 伪装被替换函数的 toString，避免被取证

        // WebRTC 策略 —— 默认 'off'，网络层交给扩展 WebRTC Network Limiter。
        // 原因：脚本只能拦到 ICE 的三条读取通道之一（icecandidate 事件），
        //       localDescription.sdp（a=candidate 行）与 getStats() 依旧是原文。
        //       只堵一条会留下「事件里没候选、SDP 里却有」的跨通道矛盾，
        //       检测站交叉比对即可判定 API 被改写 —— 比不堵更可疑。
        //       扩展改的是 chrome.privacy 策略，候选根本不生成，三条通道一起干净。
        // 所以：装了扩展 → 保持 'off'；没有扩展（如 Firefox）→ 再按需开启下面几种。
        //   'mdns'    → 只放行 mDNS，其余候选全部丢弃（无扩展时的首选，但仍不完整）
        //   'rewrite' → 把候选里的 IP 改写成出口 IP，候选存在且与出口一致，最"自然"
        //   'filter'  → 丢真实公网 IP，保留与出口一致的 srflx 和 TURN relay（需要视频通话时用）
        //   'block'   → 直接抛错禁用（特征明显，不推荐）
        //   'off'     → 不干预（推荐：已由 ① 网络层扩展接管时）
        rtcProtection: 'off',
        // 语言对齐模式 —— 默认 'off'（不改语言）。
        //   现状：请求头 Accept-Language 那一半够不到时，只改 JS 语言会变成
        //        「navigator.language 说 ja-JP、请求头还说 zh-CN」，检测方读请求头
        //         既能判定地区不符、又能顺手确定 navigator 被改过 —— 严格劣于不改。
        //   所以：不同步请求头 → 用 'off'；已同步请求头 → 再用 'match'。
        //   'match' → 跟随出口地区语言。必须同时同步 Accept-Language 请求头
        //             （装配套扩展 geospoof-lang-header，或 Header Editor）
        //   'en'    → 一律 en-US。适合把浏览器界面语言改成 English 的用户，
        //             此时请求头天然一致，不需要任何额外工具
        //   'off'   → 不干预，保持系统语言原样（当前采用）
        langMode: 'off',

        // 请求头回显服务（仅 debug 时用于校验 Accept-Language 是否已同步）
        headerEchoUrls: ['https://httpbin.org/headers', 'https://postman-echo.com/headers'],

        // —— 行为参数 ——
        accuracyRange: [30, 80],      // 每次上报的精度范围（米），随机化避免固定指纹
        jitterMeters: 60,             // 坐标抖动半径（米）；纯 IP 定位可设 0
        pollMs: 5000,
        readyTimeoutMs: 10000,        // 等待首次定位结果的最长时间
        cacheTtlMs: 6 * 3600 * 1000,  // IP→地理 结果缓存 6 小时
        probeEveryMs: 30 * 60 * 1000, // 直连/代理差异探测间隔

        // —— 站点路由判定（配合「绕过大陆」）——
        // 命中即整脚本不启动。suffix 匹配，写根域即可。
        cnDirectHosts: [
            '163.com', '126.com', 'alibaba.com', 'alicdn.com', 'alipay.com', 'aliyun.com',
            'amap.com', 'baidu.com', 'bilibili.com', 'biligame.com', 'bytedance.com',
            'douban.com', 'douyin.com', 'gov.cn', 'gtimg.com', 'huawei.com', 'iqiyi.com',
            'jd.com', 'kuaishou.com', 'meituan.com', 'mi.com', 'microsoftonline.cn',
            'netease.com', 'qcloud.com', 'qidian.com', 'qq.com', 'sina.com', 'sina.cn',
            'sohu.com', 'taobao.com', 'tencent.com', 'tmall.com', 'toutiao.com',
            'vip.com', 'weibo.com', 'xiaohongshu.com', 'ximalaya.com', 'youku.com',
            'zhihu.com', '12306.cn', 'alibabacloud.com', 'hichina.com', 'wps.cn',
        ],
        cnTlds: ['.cn'],              // 这些后缀一律视为直连
        extraDirectHosts: [],         // 追加「不启动」的域名
        forceSpoofHosts: [],          // 追加「强制启动」的域名（优先级最高）

        // —— 出口地区代码（ISO 3166-1 alpha-2）→ 语言偏好列表 ——
        // 第一项为主语言，其余为可接受的回退语言（与 Accept-Language 的 q 序列一致）。
        // 列表未收录的地区 → 语言对齐自动跳过（保持系统语言，不猜测）。
        countryLangs: {
            US: ['en-US', 'en'], GB: ['en-GB', 'en'], CA: ['en-CA', 'en'], AU: ['en-AU', 'en'],
            NZ: ['en-NZ', 'en'], IE: ['en-IE', 'en'], SG: ['en-SG', 'en'], IN: ['en-IN', 'en'],
            PH: ['en-PH', 'en'], ZA: ['en-ZA', 'en'], NG: ['en-NG', 'en'], KE: ['en-KE', 'en'],
            JP: ['ja-JP', 'ja', 'en-US', 'en'], KR: ['ko-KR', 'ko', 'en-US', 'en'],
            HK: ['zh-HK', 'zh', 'en'], MO: ['zh-MO', 'zh'], TW: ['zh-TW', 'zh'],
            DE: ['de-DE', 'de', 'en'], AT: ['de-AT', 'de'], CH: ['de-CH', 'de', 'fr', 'en'],
            FR: ['fr-FR', 'fr', 'en'], BE: ['nl-BE', 'nl', 'fr', 'en'], NL: ['nl-NL', 'nl', 'en'],
            SE: ['sv-SE', 'sv', 'en'], NO: ['nb-NO', 'nb', 'en'], DK: ['da-DK', 'da', 'en'],
            FI: ['fi-FI', 'fi', 'en'], IS: ['is-IS', 'is', 'en'], IT: ['it-IT', 'it', 'en'],
            ES: ['es-ES', 'es', 'en'], PT: ['pt-PT', 'pt', 'en'], PL: ['pl-PL', 'pl', 'en'],
            CZ: ['cs-CZ', 'cs', 'en'], SK: ['sk-SK', 'sk', 'en'], HU: ['hu-HU', 'hu', 'en'],
            RO: ['ro-RO', 'ro', 'en'], BG: ['bg-BG', 'bg', 'en'], GR: ['el-GR', 'el', 'en'],
            HR: ['hr-HR', 'hr', 'en'], SI: ['sl-SI', 'sl', 'en'], LT: ['lt-LT', 'lt', 'en'],
            LV: ['lv-LV', 'lv', 'en'], EE: ['et-EE', 'et', 'en'], UA: ['uk-UA', 'uk', 'ru', 'en'],
            RU: ['ru-RU', 'ru', 'en'], TR: ['tr-TR', 'tr', 'en'], IL: ['he-IL', 'he', 'en'],
            AE: ['ar-AE', 'ar', 'en'], SA: ['ar-SA', 'ar', 'en'], EG: ['ar-EG', 'ar', 'en'],
            QA: ['ar-QA', 'ar', 'en'], KW: ['ar-KW', 'ar', 'en'], ID: ['id-ID', 'id', 'en'],
            TH: ['th-TH', 'th', 'en'], VN: ['vi-VN', 'vi', 'en'], MY: ['ms-MY', 'ms', 'en'],
            BR: ['pt-BR', 'pt', 'en'], MX: ['es-MX', 'es', 'en'], AR: ['es-AR', 'es', 'en'],
            CL: ['es-CL', 'es', 'en'], CO: ['es-CO', 'es', 'en'], PE: ['es-PE', 'es', 'en'],
            NP: ['ne-NP', 'ne', 'en'], PK: ['en-PK', 'en'], BD: ['bn-BD', 'bn', 'en'],
            LK: ['si-LK', 'si', 'en'], KZ: ['ru-KZ', 'ru', 'kk', 'en'],
        },
    };

    const CACHE_KEY = 'geospoof_v6_geo';
    const PROBE_KEY = 'geospoof_v6_probe';

    const log = (...a) => { if (CONFIG.debug) console.info('[地理自洽]', ...a); };
    const warn = (...a) => { if (CONFIG.debug) console.warn('[地理自洽]', ...a); };

    /* ══════════════════════════════════════════════════
       1. 路由判定：当前页面是否走代理
       ══════════════════════════════════════════════════ */
    const host = (function () {
        try { return (location.hostname || '').toLowerCase(); } catch (e) { return ''; }
    })();

    function hostMatches(h, list) {
        for (let i = 0; i < list.length; i++) {
            const d = list[i];
            if (h === d || h.endsWith('.' + d)) return true;
        }
        return false;
    }

    function decideActive() {
        if (!host) return false;
        if (hostMatches(host, CONFIG.forceSpoofHosts)) return true;
        if (CONFIG.extraDirectHosts.length && hostMatches(host, CONFIG.extraDirectHosts)) return false;
        if (host === 'localhost' || host.endsWith('.local')) return false;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.indexOf(':') > -1) return false;
        if (CONFIG.cnTlds.some(t => host.endsWith(t))) return false;
        if (hostMatches(host, CONFIG.cnDirectHosts)) return false;
        return true;
    }

    const ACTIVE = CONFIG.spoofGeolocation || CONFIG.spoofTimezone || CONFIG.rtcProtection !== 'off'
        ? decideActive() : false;

    // 国内站点：一行代码都不执行，避免影响合规访问
    if (!ACTIVE) return;

    /* ══════════════════════════════════════════════════
       2. 基础工具
       ══════════════════════════════════════════════════ */
    function gmGet(k, d) {
        try { return (typeof GM_getValue === 'function') ? GM_getValue(k, d) : d; } catch (e) { return d; }
    }
    function gmSet(k, v) {
        try { if (typeof GM_setValue === 'function') GM_setValue(k, v); } catch (e) { /* ignore */ }
    }
    function xhrGet(url, timeout) {
        return new Promise(resolve => {
            if (typeof GM_xmlhttpRequest !== 'function') return resolve(null);
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: timeout || 4000,
                    headers: { 'Cache-Control': 'no-cache' },
                    onload: r => resolve((r && r.status >= 200 && r.status < 300) ? r.responseText : null),
                    onerror: () => resolve(null),
                    ontimeout: () => resolve(null),
                    onabort: () => resolve(null),
                });
            } catch (e) { resolve(null); }
        });
    }
    function jsonOrNull(txt) {
        if (!txt) return null;
        try { return JSON.parse(txt); } catch (e) { return null; }
    }
    const pad2 = n => (n < 10 ? '0' + n : '' + n);
    const num = v => (typeof v === 'number' ? v : parseFloat(v));
    const finite = v => typeof v === 'number' && isFinite(v);

    /* ══════════════════════════════════════════════════
       3. 原生引用 & toString 伪装
       ══════════════════════════════════════════════════ */
    const RealDate = Date;
    const RealDTF = Intl.DateTimeFormat;
    const _realTZO = RealDate.prototype.getTimezoneOffset;
    const _realToString = RealDate.prototype.toString;
    const _realFTS = Function.prototype.toString;

    const _nativeSrc = new WeakMap();
    function markNative(fn, src) {
        try { _nativeSrc.set(fn, src || ('function ' + (fn.name || '') + '() { [native code] }')); } catch (e) { }
        return fn;
    }
    if (CONFIG.stealthToString) {
        const patchedToString = markNative(function toString() {
            const s = _nativeSrc.get(this);
            return s !== undefined ? s : _realFTS.call(this);
        }, 'function toString() { [native code] }');
        try { Function.prototype.toString = patchedToString; } catch (e) { }
    }

    /* ══════════════════════════════════════════════════
       4. 目标时区偏移计算
       ══════════════════════════════════════════════════ */
    const _fmtCache = new Map();
    function tzFormatter(tz) {
        let f = _fmtCache.get(tz);
        if (!f) {
            // 使用 hourCycle h23 避免某些引擎在午夜返回 24
            f = new RealDTF('en-US', {
                timeZone: tz, hourCycle: 'h23',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            });
            _fmtCache.set(tz, f);
        }
        return f;
    }

    // 返回 UTC 以东为正的分钟数（东京 = +540，上海 = +480）
    function offsetMinutesEast(tz, ms) {
        if (!tz || !isFinite(ms)) return 0;
        try {
            const parts = tzFormatter(tz).formatToParts(ms);
            const o = {};
            for (let i = 0; i < parts.length; i++) if (parts[i].type !== 'literal') o[parts[i].type] = parts[i].value;
            const asUTC = RealDate.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
            return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
        } catch (e) { return 0; }
    }

    const _longNameCache = new Map();
    function tzNameLong(tz, ms) {
        try {
            let f = _longNameCache.get(tz);
            if (!f) { f = new RealDTF('en-US', { timeZone: tz, timeZoneName: 'long' }); _longNameCache.set(tz, f); }
            const parts = f.formatToParts(ms);
            for (let i = 0; i < parts.length; i++) if (parts[i].type === 'timeZoneName') return parts[i].value;
        } catch (e) { }
        return tz;
    }

    function offsetString(offMin) {
        const sign = offMin >= 0 ? '+' : '-';
        const a = Math.abs(offMin);
        return 'GMT' + sign + pad2(Math.floor(a / 60)) + pad2(a % 60);
    }

    let _validTzCache = null;
    function isValidTz(tz) {
        if (!tz || typeof tz !== 'string') return false;
        if (_validTzCache && _validTzCache.has(tz)) return _validTzCache.get(tz);
        let ok = true;
        try { new RealDTF('en-US', { timeZone: tz }); } catch (e) { ok = false; }
        if (!_validTzCache) _validTzCache = new Map();
        _validTzCache.set(tz, ok);
        return ok;
    }

    /* ══════════════════════════════════════════════════
       5. 运行状态（全部在闭包内，页面上无任何全局痕迹）
       ══════════════════════════════════════════════════ */
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const state = {
        ready: false,
        lat: 0, lon: 0,
        timezone: null,
        country: null,
        ip: null,
    };

    // 先用缓存同步点亮，保证 document-start 之后的首个调用就拿到正确结果
    (function primeFromCache() {
        const c = gmGet(CACHE_KEY, null);
        if (!c || !c.ip || !isValidTz(c.timezone)) return;
        if (new RealDate().getTime() - (c.ts || 0) > CONFIG.cacheTtlMs) return;
        state.lat = c.lat; state.lon = c.lon;
        state.timezone = c.timezone; state.country = c.country;
        state.ip = c.ip; state.ready = true;
        log('缓存命中', c.ip, c.country, c.timezone);
    })();

    const _pending = [];          // 等待定位结果的 getCurrentPosition 回调
    const _watches = new Map();   // watchPosition 注册表
    let _watchSeq = 1000000;      // 与真实 watch id 错开，避免冲突

    function makePosition() {
        const j = CONFIG.jitterMeters || 0;
        const cosLat = Math.max(0.2, Math.cos(state.lat * Math.PI / 180));
        const dLat = j ? (Math.random() * 2 - 1) * (j / 111320) : 0;
        const dLon = j ? (Math.random() * 2 - 1) * (j / (111320 * cosLat)) : 0;
        const lo = CONFIG.accuracyRange[0], hi = CONFIG.accuracyRange[1];
        const acc = Math.round(lo + Math.random() * Math.max(0, hi - lo));
        return {
            coords: {
                latitude: state.lat + dLat,
                longitude: state.lon + dLon,
                accuracy: acc,
                altitude: null,
                altitudeAccuracy: null,
                heading: null,
                speed: null,
            },
            timestamp: RealDate.now(),
        };
    }

    function makeGeoError(code, message) {
        const e = { code: code, message: message };
        e.PERMISSION_DENIED = 1;
        e.POSITION_UNAVAILABLE = 2;
        e.TIMEOUT = 3;
        return e;
    }

    function flushPending() {
        const q = _pending.splice(0);
        for (let i = 0; i < q.length; i++) { try { q[i](); } catch (e) { } }
    }
    function pushWatchers() {
        if (!state.ready) return;
        _watches.forEach(cb => { try { cb(makePosition()); } catch (e) { } });
    }

    /* ══════════════════════════════════════════════════
       6. Geolocation / Permissions
       ══════════════════════════════════════════════════ */
    function installGeolocation() {
        let realGeo = null;
        try { realGeo = navigator.geolocation; } catch (e) { }
        if (!realGeo) return;
        const GeoProto = Object.getPrototypeOf(realGeo);
        if (!GeoProto) return;

        const _get = GeoProto.getCurrentPosition;
        const _watch = GeoProto.watchPosition;
        const _clear = GeoProto.clearWatch;

        // 未就绪 → 排队等待，绝不把真实位置抛出去
        const patchedGet = markNative(function getCurrentPosition(success, error, options) {
            const self = this;
            if (state.ready) {
                setTimeout(() => { try { success && success(makePosition()); } catch (e) { } }, 0);
                return;
            }
            const timeoutMs = (options && options.timeout) || CONFIG.readyTimeoutMs;
            let done = false;
            let entry = null;
            const timer = setTimeout(() => {
                done = true;
                if (entry) { const i = _pending.indexOf(entry); if (i > -1) _pending.splice(i, 1); }
                if (typeof error === 'function') {
                    try { error.call(self, makeGeoError(3, 'Timeout expired')); } catch (e) { }
                } else if (typeof success === 'function') {
                    try { success.call(self, makePosition()); } catch (e) { }
                }
            }, timeoutMs);
            entry = function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { success && success.call(self, makePosition()); } catch (e) { }
            };
            _pending.push(entry);
        }, 'function getCurrentPosition() { [native code] }');

        const patchedWatch = markNative(function watchPosition(success, error, options) {
            const id = _watchSeq++;
            _watches.set(id, success);
            if (state.ready) setTimeout(() => { try { success && success(makePosition()); } catch (e) { } }, 0);
            return id;
        }, 'function watchPosition() { [native code] }');

        const patchedClear = markNative(function clearWatch(id) {
            if (_watches.has(id)) { _watches.delete(id); return; }
            try { _clear.call(this, id); } catch (e) { }
        }, 'function clearWatch() { [native code] }');

        try {
            GeoProto.getCurrentPosition = patchedGet;
            GeoProto.watchPosition = patchedWatch;
            GeoProto.clearWatch = patchedClear;
        } catch (e) { warn('geolocation 补丁失败', e); }
    }

    function installPermissions() {
        let perms = null;
        try { perms = navigator.permissions; } catch (e) { }
        if (!perms) return;
        const Proto = Object.getPrototypeOf(perms);
        if (!Proto || typeof Proto.query !== 'function') return;
        const _q = Proto.query;

        const grantedStatus = function () {
            const s = {
                state: 'granted',
                name: 'geolocation',
                onchange: null,
                addEventListener: function () { },
                removeEventListener: function () { },
                dispatchEvent: function () { return false; },
            };
            return s;
        };

        const patchedQuery = markNative(function query(desc) {
            if (desc && desc.name === 'geolocation') return Promise.resolve(grantedStatus());
            return _q.call(this, desc);
        }, 'function query() { [native code] }');

        try { Proto.query = patchedQuery; } catch (e) { warn('permissions 补丁失败', e); }
    }

    /* ══════════════════════════════════════════════════
       7. 时区：Intl / Date
       ══════════════════════════════════════════════════ */
    function installIntl() {
        function PatchedDTF(locale, options) {
            let opts = options;
            if (state.timezone && (!opts || !opts.timeZone)) {
                opts = Object.assign({}, opts);
                opts.timeZone = state.timezone;
            }
            // 语言对齐开启时，未显式传 locale 的调用也走目标区域
            const dl = defaultLocale();
            return new RealDTF((locale === undefined && dl) ? dl : locale, opts);
        }
        PatchedDTF.prototype = RealDTF.prototype;
        try {
            Object.defineProperty(PatchedDTF, 'name', { value: 'DateTimeFormat', configurable: true });
            Object.defineProperty(PatchedDTF, 'length', { value: 0, configurable: true });
        } catch (e) { }
        PatchedDTF.supportedLocalesOf = RealDTF.supportedLocalesOf;
        markNative(PatchedDTF, 'function DateTimeFormat() { [native code] }');
        markNative(PatchedDTF.supportedLocalesOf, 'function supportedLocalesOf() { [native code] }');
        try { Intl.DateTimeFormat = PatchedDTF; } catch (e) { warn('Intl 补丁失败', e); }
    }

    function installDatePrototype() {
        const _realToDateString = RealDate.prototype.toDateString;
        const _realToTimeString = RealDate.prototype.toTimeString;

        // toLocale* 系列：注入 timeZone
        ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (m) {
            const orig = RealDate.prototype[m];
            const patched = markNative(function (locale, options) {
                let opts = options;
                if (state.timezone && (!opts || !opts.timeZone)) {
                    opts = Object.assign({}, opts);
                    opts.timeZone = state.timezone;
                }
                return orig.call(this, locale, opts);
            }, 'function ' + m + '() { [native code] }');
            RealDate.prototype[m] = patched;
        });

        // getTimezoneOffset
        RealDate.prototype.getTimezoneOffset = markNative(function getTimezoneOffset() {
            if (!state.timezone) return _realTZO.call(this);
            const ms = this.getTime();
            if (!isFinite(ms)) return NaN;
            return -offsetMinutesEast(state.timezone, ms);
        }, 'function getTimezoneOffset() { [native code] }');

        // 本地 getter → 平移到目标时区后用 UTC getter
        const GETTERS = {
            getHours: 'getUTCHours',
            getMinutes: 'getUTCMinutes',
            getSeconds: 'getUTCSeconds',
            getMilliseconds: 'getUTCMilliseconds',
            getDate: 'getUTCDate',
            getDay: 'getUTCDay',
            getMonth: 'getUTCMonth',
            getFullYear: 'getUTCFullYear',
        };
        Object.keys(GETTERS).forEach(function (name) {
            const orig = RealDate.prototype[name];
            const utc = GETTERS[name];
            const patched = markNative(function () {
                if (!state.timezone) return orig.call(this);
                const ms = this.getTime();
                if (!isFinite(ms)) return orig.call(this);
                return new RealDate(ms + offsetMinutesEast(state.timezone, ms) * 60000)[utc]();
            }, 'function ' + name + '() { [native code] }');
            RealDate.prototype[name] = patched;
        });

        // 已废弃的 getYear
        const _gy = RealDate.prototype.getYear;
        RealDate.prototype.getYear = markNative(function getYear() {
            if (!state.timezone) return _gy.call(this);
            return this.getFullYear() - 1900;
        }, 'function getYear() { [native code] }');

        // 本地 setter → 在「目标时区的墙上时间」里改，再解回瞬时值
        const SETTERS = {
            setHours: 'setUTCHours',
            setMinutes: 'setUTCMinutes',
            setSeconds: 'setUTCSeconds',
            setMilliseconds: 'setUTCMilliseconds',
            setDate: 'setUTCDate',
            setMonth: 'setUTCMonth',
            setFullYear: 'setUTCFullYear',
        };
        Object.keys(SETTERS).forEach(function (name) {
            const orig = RealDate.prototype[name];
            const utcSetter = RealDate.prototype[SETTERS[name]];
            const patched = markNative(function () {
                const tz = state.timezone;
                const ms = this.getTime();
                if (!tz || !isFinite(ms)) return orig.apply(this, arguments);
                const off = offsetMinutesEast(tz, ms);
                const wall = new RealDate(ms + off * 60000);
                const newWall = utcSetter.apply(wall, arguments);
                if (!isFinite(newWall)) { this.setTime(NaN); return NaN; }
                let guess = newWall - off * 60000;
                for (let i = 0; i < 3; i++) guess = newWall - offsetMinutesEast(tz, guess) * 60000;
                this.setTime(guess);
                return guess;
            }, 'function ' + name + '() { [native code] }');
            RealDate.prototype[name] = patched;
        });

        // toString / toDateString / toTimeString
        RealDate.prototype.toString = markNative(function toString() {
            const tz = state.timezone;
            const ms = this.getTime();
            if (!tz || !isFinite(ms)) return _realToString.call(this);
            const off = offsetMinutesEast(tz, ms);
            const w = new RealDate(ms + off * 60000);
            return WD[w.getUTCDay()] + ' ' + MO[w.getUTCMonth()] + ' ' + pad2(w.getUTCDate()) + ' ' +
                w.getUTCFullYear() + ' ' + pad2(w.getUTCHours()) + ':' + pad2(w.getUTCMinutes()) + ':' +
                pad2(w.getUTCSeconds()) + ' ' + offsetString(off) + ' (' + tzNameLong(tz, ms) + ')';
        }, 'function toString() { [native code] }');

        RealDate.prototype.toDateString = markNative(function toDateString() {
            const tz = state.timezone;
            const ms = this.getTime();
            if (!tz || !isFinite(ms)) return _realToDateString.call(this);
            const w = new RealDate(ms + offsetMinutesEast(tz, ms) * 60000);
            return WD[w.getUTCDay()] + ' ' + MO[w.getUTCMonth()] + ' ' + pad2(w.getUTCDate()) + ' ' + w.getUTCFullYear();
        }, 'function toDateString() { [native code] }');

        RealDate.prototype.toTimeString = markNative(function toTimeString() {
            const tz = state.timezone;
            const ms = this.getTime();
            if (!tz || !isFinite(ms)) return _realToTimeString.call(this);
            const off = offsetMinutesEast(tz, ms);
            const w = new RealDate(ms + off * 60000);
            return pad2(w.getUTCHours()) + ':' + pad2(w.getUTCMinutes()) + ':' + pad2(w.getUTCSeconds()) +
                ' ' + offsetString(off) + ' (' + tzNameLong(tz, ms) + ')';
        }, 'function toTimeString() { [native code] }');
    }

    // 替换 window.Date：让 new Date(y, m, d, h...) 也按目标时区解释
    function installDateConstructor() {
        const SpoofDate = markNative(function Date() {
            const args = arguments;
            const nt = new.target;

            if (!nt) return new RealDate(RealDate.now()).toString();   // Date() 直接调用

            // 尚未拿到时区 → 完全走原生行为，不做任何偏移
            if (!state.timezone) {
                if (nt === SpoofDate || nt === RealDate) return new RealDate(...args);
                return Reflect.construct(RealDate, args, nt);
            }

            let ms;
            if (args.length === 0) {
                ms = RealDate.now();
            } else if (args.length === 1) {
                ms = new RealDate(args[0]).getTime();
            } else {
                const y = Number(args[0]), mo = Number(args[1]);
                const d = args.length > 2 ? Number(args[2]) : 1;
                const h = args.length > 3 ? Number(args[3]) : 0;
                const mi = args.length > 4 ? Number(args[4]) : 0;
                const s = args.length > 5 ? Number(args[5]) : 0;
                const ml = args.length > 6 ? Number(args[6]) : 0;
                const target = RealDate.UTC(y, mo, d, h, mi, s, ml);
                if (!isFinite(target)) {
                    ms = NaN;
                } else {
                    let guess = target;
                    for (let i = 0; i < 3; i++) guess = target - offsetMinutesEast(state.timezone, guess) * 60000;
                    ms = guess;
                }
            }

            if (nt === SpoofDate || nt === RealDate) return new RealDate(ms);
            try { return Reflect.construct(RealDate, [ms], nt); } catch (e) { return new RealDate(ms); }
        }, 'function Date() { [native code] }');

        SpoofDate.prototype = RealDate.prototype;   // 保证 instanceof 与原型链完全正常
        SpoofDate.now = markNative(() => RealDate.now(), 'function now() { [native code] }');
        SpoofDate.parse = markNative(s => RealDate.parse(s), 'function parse() { [native code] }');
        SpoofDate.UTC = markNative(function () { return RealDate.UTC.apply(null, arguments); },
            'function UTC() { [native code] }');

        try {
            Object.defineProperty(SpoofDate, 'name', { value: 'Date', configurable: true });
            Object.defineProperty(SpoofDate, 'length', { value: 7, configurable: true });
            Object.defineProperty(SpoofDate.UTC, 'length', { value: 7, configurable: true });
        } catch (e) { }

        try { window.Date = SpoofDate; } catch (e) { warn('Date 构造器替换失败', e); }
    }

    /* ══════════════════════════════════════════════════
       8. WebRTC：ICE 候选过滤（默认关闭）

       本节的补丁只作用于 icecandidate 事件。ICE 的 IP 还有两条读取通道
       没有被覆盖，且都无法在不破坏 SDP 语义的前提下可靠地改写：
         · pc.localDescription.sdp        —— a=candidate: 行，包含同样的 IP
         · pc.getStats()                  —— local-candidate / candidate-pair 的 address
       检测站大多直接读 SDP（不依赖事件时序），因此只堵事件通道等于没堵，
       还会留下「事件里没候选、SDP 里却有」的矛盾证据。
       正确做法是在浏览器网络层用 chrome.privacy.network.webRTCIPHandlingPolicy
       把候选生成本身关掉（扩展 WebRTC Network Limiter），届时三条通道一起干净。
       故 CONFIG.rtcProtection 默认为 'off'，以下代码作为无扩展环境的备用。
       ══════════════════════════════════════════════════ */
    function isPrivateIP(ip) {
        if (!ip) return true;
        if (ip.indexOf(':') > -1) {                       // IPv6
            const v = ip.toLowerCase();
            return v === '::1' || v.indexOf('fe80') === 0 || v.indexOf('fc') === 0 || v.indexOf('fd') === 0;
        }
        const p = ip.split('.').map(Number);
        if (p.length !== 4) return false;
        if (p[0] === 10) return true;
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
        if (p[0] === 192 && p[1] === 168) return true;
        if (p[0] === 169 && p[1] === 254) return true;
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;  // CGNAT
        if (p[0] === 127) return true;
        return false;
    }

    function candidateIP(line) {
        const t = String(line).split(' ');
        return t.length > 4 ? t[4] : null;
    }

    // 候选处置策略
    //   mdns    : 只放行 mDNS(.local)，其余全丢 → WebRTC 不产生任何可与公网 IP 对比的地址
    //   rewrite : 把 host/srflx 候选里的 IP 改写成出口 IP → 候选存在且与出口一致，最"自然"
    //   filter  : 丢私网 + 丢真实公网，保留与出口 IP 相同的 srflx 与 TURN relay（通话兼容模式）
    function buildRewrittenCandidate(cand, str) {
        if (!state.ip) return null;
        const parts = str.split(' ');
        if (parts.length < 5) return null;
        const oldIP = parts[4];
        if (isPrivateIP(oldIP) || /\.local$/i.test(oldIP)) return null;
        parts[4] = state.ip;
        return {
            candidate: parts.join(' '),
            sdpMid: cand.sdpMid,
            sdpMLineIndex: cand.sdpMLineIndex,
            usernameFragment: cand.usernameFragment,
            foundation: parts[0].split(':')[1] || '',
            component: parts[1] || '',
            protocol: (parts[2] || '').toLowerCase(),
            priority: Number(parts[3]) || 0,
            address: state.ip,
            port: Number(parts[5]) || 0,
            type: parts[7] || '',
            relatedAddress: null,
            relatedPort: null,
            tcpType: null,
            toJSON: function () {
                return {
                    candidate: this.candidate, sdpMid: this.sdpMid,
                    sdpMLineIndex: this.sdpMLineIndex, usernameFragment: this.usernameFragment,
                };
            },
        };
    }

    function decideCandidate(ev) {
        const c = ev && ev.candidate;
        if (!c || !c.candidate) return { action: 'keep' };        // null 候选 = 收集结束，必须放行
        const str = String(c.candidate);
        const ip = candidateIP(str);

        if (!ip) return { action: 'keep' };
        if (/\.local$/i.test(ip)) return { action: 'keep' };      // mDNS 是浏览器原生的隐私保护形态，保留最自然
        if (isPrivateIP(ip)) return { action: 'drop' };

        const mode = CONFIG.rtcProtection;
        if (mode === 'mdns') return { action: 'drop' };

        if (state.ip && ip === state.ip) return { action: 'keep' };

        if (mode === 'rewrite') {
            const nc = buildRewrittenCandidate(c, str);
            return nc ? { action: 'rewrite', cand: nc } : { action: 'drop' };
        }
        // filter 模式：放行 TURN relay（暴露的是 TURN 服务器，不是本机）
        if (/\btyp\s+relay\b/.test(str)) return { action: 'keep' };
        return { action: 'drop' };
    }

    function rewriteEvent(ev, newCand) {
        try {
            return new Proxy(ev, {
                get: function (t, p) {
                    if (p === 'candidate') return newCand;
                    return Reflect.get(t, p, t);   // 用 t 作 receiver，避免 Illegal invocation
                },
            });
        } catch (e) { return ev; }
    }

    function deliver(ev, listener, thisArg) {
        const d = decideCandidate(ev);
        if (d.action === 'drop') return undefined;
        if (d.action === 'rewrite') return listener.call(thisArg, rewriteEvent(ev, d.cand));
        return listener.call(thisArg, ev);
    }

    function installRTC() {
        const mode = CONFIG.rtcProtection;
        if (mode === 'off') return;
        const RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (!RTC) return;

        if (mode === 'block') {
            const Blocked = markNative(function RTCPeerConnection() {
                throw new DOMException('RTCPeerConnection is disabled', 'NotSupportedError');
            }, 'function RTCPeerConnection() { [native code] }');
            // 某些环境下构造器的 prototype 属性不可写（如 class 语法），
            // 直接赋值会抛错 → 整个 RTC 补丁被外层 catch 静默吞掉，等于没装。
            try { Blocked.prototype = RTC.prototype; } catch (e) {
                try { Object.defineProperty(Blocked, 'prototype', { value: RTC.prototype }); } catch (e2) { }
            }
            try { window.RTCPeerConnection = Blocked; window.webkitRTCPeerConnection = Blocked; } catch (e) { }
            return;
        }

        const Wrapped = markNative(function RTCPeerConnection() {
            const pc = new RTC(...arguments);
            try {
                const _add = pc.addEventListener.bind(pc);
                const _remove = pc.removeEventListener.bind(pc);

                pc.addEventListener = function (type, listener, opts) {
                    if (type === 'icecandidate' && typeof listener === 'function') {
                        const wrapped = function (ev) { return deliver(ev, listener, this); };
                        try { listener.__gsWrap = wrapped; } catch (e) { }
                        return _add(type, wrapped, opts);
                    }
                    return _add(type, listener, opts);
                };
                pc.removeEventListener = function (type, listener, opts) {
                    if (type === 'icecandidate' && listener && listener.__gsWrap) {
                        return _remove(type, listener.__gsWrap, opts);
                    }
                    return _remove(type, listener, opts);
                };

                let handler = null;
                Object.defineProperty(pc, 'onicecandidate', {
                    configurable: true,
                    enumerable: true,
                    get: function () { return handler; },
                    set: function (fn) {
                        if (handler) _remove('icecandidate', handler);
                        handler = typeof fn === 'function'
                            ? function (ev) { return deliver(ev, fn, pc); }
                            : fn;
                        if (handler) _add('icecandidate', handler);
                    },
                });
            } catch (e) { }
            return pc;
        }, 'function RTCPeerConnection() { [native code] }');

        // 同上：prototype 不可写时降级为 defineProperty，避免静默失败
        try { Wrapped.prototype = RTC.prototype; } catch (e) {
            try { Object.defineProperty(Wrapped, 'prototype', { value: RTC.prototype }); } catch (e2) { }
        }
        try { Object.setPrototypeOf(Wrapped, RTC); } catch (e) { }   // 静态方法（generateCertificate 等）透传
        try { window.RTCPeerConnection = Wrapped; window.webkitRTCPeerConnection = Wrapped; } catch (e) { }
    }

    /* ══════════════════════════════════════════════════
       9. 语言对齐【可选模块 —— 默认 langMode = 'off'，整节不生效】

       'off' 时 installLanguageShims() / applyLanguage() 都在第一行 return，
       不安装任何补丁、不发起任何请求 → 对页面零痕迹、零开销。
       保留此节是为了留住一条零工具路线：把浏览器界面语言改成 English
       后，只需 CONFIG.langMode = 'en'（若已装头扩展则用 'match'）。

       JS 侧可改：navigator.language / languages、Intl 默认区域、
                  Date/Number.prototype.toLocale*、<html lang>
       JS 侧改不了：HTTP 请求头 Accept-Language —— 它只能由浏览器
                  扩展（declarativeNetRequest）或代理软件改写。
                  两边不同步时会留下「JS 说 ja-JP、请求头说 zh-CN」
                  的硬矛盾，比不改更容易被判定为伪装。
                  配套扩展：geospoof-lang-header（见同目录）
       ══════════════════════════════════════════════════ */
    let LANG_LIST = null;                         // 例如 ['ja-JP', 'ja', 'en-US', 'en']
    let _headerLangSeen = null;                   // 回显服务读到的 Accept-Language
    let _headerChecked = false;

    function defaultLocale() { return LANG_LIST ? LANG_LIST[0] : null; }

    const _realNavLang = navigator.language;
    const _realNavLangs = (navigator.languages || []).slice();

    function applyHtmlLang() {
        const write = function () {
            try {
                if (LANG_LIST && document.documentElement) {
                    document.documentElement.setAttribute('lang', LANG_LIST[0]);
                }
            } catch (e) { }
        };
        write();
        if (!document.documentElement) {
            try { document.addEventListener('DOMContentLoaded', write, { once: true }); } catch (e) { }
        }
    }

    function installLanguageShims() {
        if (CONFIG.langMode === 'off') return;

        // 补丁先装、值后到：getter 每次都实时读 LANG_LIST，
        // 所以在出口 IP 解析完成前返回真实语言（安全），解析完成后自动切换。
        try {
            const NavProto = Object.getPrototypeOf(navigator);
            Object.defineProperty(NavProto, 'language', {
                get: function () { return LANG_LIST ? LANG_LIST[0] : _realNavLang; },
                configurable: true, enumerable: true,
            });
            Object.defineProperty(NavProto, 'languages', {
                get: function () { return LANG_LIST ? LANG_LIST.slice() : _realNavLangs.slice(); },
                configurable: true, enumerable: true,
            });
        } catch (e) { }

        // Intl 各构造器默认区域：不传 locale 时补上，防止
        // 「navigator.language = en-US 但 Intl.NumberFormat().resolvedOptions().locale = zh-CN」被抓
        // 注意：DateTimeFormat 已由 installIntl() 接管（同时处理时区与区域），此处跳过
        ['NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat',
            'ListFormat', 'DisplayNames', 'Segmenter'].forEach(function (name) {
                const Orig = Intl[name];
                if (typeof Orig !== 'function') return;
                const Patched = function (locale, options) {
                    const dl = defaultLocale();
                    return new Orig((locale === undefined && dl) ? dl : locale, options);
                };
                Patched.prototype = Orig.prototype;
                if (Orig.supportedLocalesOf) Patched.supportedLocalesOf = Orig.supportedLocalesOf;
                markNative(Patched, 'function ' + name + '() { [native code] }');
                try { Object.defineProperty(Patched, 'name', { value: name, configurable: true }); } catch (e) { }
                try { Intl[name] = Patched; } catch (e) { }
            });

        // toLocale* 默认区域
        ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (m) {
            const orig = RealDate.prototype[m];
            RealDate.prototype[m] = markNative(function (locale, options) {
                let opts = options;
                if (state.timezone && (!opts || !opts.timeZone)) {
                    opts = Object.assign({}, opts);
                    opts.timeZone = state.timezone;
                }
                const dl = defaultLocale();
                return orig.call(this, (locale === undefined && dl) ? dl : locale, opts);
            }, 'function ' + m + '() { [native code] }');
        });
        try {
            const _numTL = Number.prototype.toLocaleString;
            Number.prototype.toLocaleString = markNative(function (locale, options) {
                const dl = defaultLocale();
                return _numTL.call(this, (locale === undefined && dl) ? dl : locale, options);
            }, 'function toLocaleString() { [native code] }');
        } catch (e) { }
    }

    // 出口地区确定或发生变化时调用：更新语言列表并同步 <html lang>
    function applyLanguage(country) {
        if (CONFIG.langMode === 'off') return;

        let list = null;
        if (CONFIG.langMode === 'en') list = ['en-US', 'en'];
        else if (country) list = CONFIG.countryLangs[country] || null;
        if (!list) return;                                  // 未收录的地区 → 保持真实语言
        if (LANG_LIST && LANG_LIST[0] === list[0]) { applyHtmlLang(); return; }

        LANG_LIST = list.slice();
        log('语言对齐 →', LANG_LIST.join(', '));
        applyHtmlLang();
        verifyHeaderLanguage().catch(function () { });
    }

    // 校验服务端实际收到的 Accept-Language 是否与 JS 侧一致。
    // 这是 JS 唯一够不到的环节，必须由扩展/代理软件补上，所以只做检测与提示。
    async function verifyHeaderLanguage() {
        if (!CONFIG.debug || _headerChecked || !LANG_LIST) return;
        _headerChecked = true;
        const want = LANG_LIST[0].split('-')[0].toLowerCase();
        for (let i = 0; i < CONFIG.headerEchoUrls.length; i++) {
            const txt = await xhrGet(CONFIG.headerEchoUrls[i], 4000);
            if (!txt) continue;
            const m = /"accept-language"\s*:\s*"([^"]*)"/i.exec(txt);
            if (!m) continue;
            _headerLangSeen = m[1];
            if (m[1].toLowerCase().indexOf(want) === -1) {
                console.warn('[地理自洽] ⚠️ 请求头语言未同步：服务端收到 Accept-Language = "' + m[1] +
                    '"，但 JS 侧已改为 ' + LANG_LIST[0] + '。\n' +
                    '  这个矛盾会被 IP↔语言一致性检测直接命中，三选一解决：\n' +
                    '   a) 装配套扩展 geospoof-lang-header（按出口 IP 自动改写请求头，推荐）\n' +
                    '   b) 把浏览器界面语言改为 English，并把 CONFIG.langMode 设为 "en"\n' +
                    '   c) 把 CONFIG.langMode 设为 "off"，让 JS 保持真实语言');
            } else {
                log('✓ 请求头语言已同步：', m[1]);
            }
            return;
        }
    }

    /* ══════════════════════════════════════════════════
       10. IP 探测与多源投票
       ══════════════════════════════════════════════════ */
    async function getExitIP() {
        const urls = ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json'];
        for (let i = 0; i < urls.length; i++) {
            const d = jsonOrNull(await xhrGet(urls[i], 3000));
            if (d && d.ip) return d.ip;
        }
        return null;
    }

    // 直连探针：走「绕过大陆」的直连路径，用于诊断代理是否真的生效
    async function probeDirectIP() {
        const cached = gmGet(PROBE_KEY, null);
        const now = RealDate.now();
        if (cached && now - (cached.ts || 0) < CONFIG.probeEveryMs) return cached.ip;

        const urls = ['https://myip.ipip.net', 'https://4.ipw.cn'];
        for (let i = 0; i < urls.length; i++) {
            const txt = await xhrGet(urls[i], 3000);
            if (!txt) continue;
            const v4 = txt.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
            if (v4) { gmSet(PROBE_KEY, { ip: v4[1], ts: now }); return v4[1]; }
        }
        return null;
    }

    async function srcIpWhoIs(ip) {
        const d = jsonOrNull(await xhrGet('https://ipwho.is/' + encodeURIComponent(ip), 4000));
        if (!d || !d.success || !d.country_code) return null;
        return {
            source: 'ipwho.is',
            country: d.country_code,
            lat: num(d.latitude), lon: num(d.longitude),
            timezone: (d.timezone && d.timezone.id) || null,
            rank: 1,
        };
    }

    async function srcFreeIpApi(ip) {
        const d = jsonOrNull(await xhrGet('https://freeipapi.com/api/json/' + encodeURIComponent(ip), 4000));
        if (!d || !d.countryCode || d.countryCode === '-') return null;
        return {
            source: 'freeipapi',
            country: d.countryCode,
            lat: num(d.latitude), lon: num(d.longitude),
            timezone: d.timeZone || null,
            rank: 2,
        };
    }

    async function srcIpInfo(ip) {
        const d = jsonOrNull(await xhrGet('https://ipinfo.io/' + encodeURIComponent(ip) + '/json', 4000));
        if (!d || !d.country) return null;
        const loc = (d.loc || '').split(',');
        return {
            source: 'ipinfo',
            country: d.country,
            lat: num(loc[0]), lon: num(loc[1]),
            timezone: d.timezone || null,
            rank: 3,
        };
    }

    async function srcIpApiCo(ip) {
        const d = jsonOrNull(await xhrGet('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', 4000));
        if (!d || !d.country_code || d.error) return null;
        return {
            source: 'ipapi.co',
            country: d.country_code,
            lat: num(d.latitude), lon: num(d.longitude),
            timezone: d.timezone || null,
            rank: 4,
        };
    }

    function hasCoords(r) {
        return !!r && finite(r.lat) && finite(r.lon) &&
            Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 &&
            !(r.lat === 0 && r.lon === 0);
    }

    function pickCoords(list) {
        const sorted = list.slice().sort((a, b) => a.rank - b.rank);
        for (let i = 0; i < sorted.length; i++) if (hasCoords(sorted[i])) return sorted[i];
        return null;
    }

    function vote(results) {
        const valid = results.filter(r => r && r.country);
        if (!valid.length) return null;

        const groups = new Map();
        valid.forEach(r => {
            if (!groups.has(r.country)) groups.set(r.country, []);
            groups.get(r.country).push(r);
        });

        let winners;
        if (groups.size === 1) {
            winners = valid;
        } else {
            const majority = [...groups.values()].filter(a => a.length >= 2).sort((a, b) => b.length - a.length)[0];
            if (majority) {
                winners = majority;
            } else {
                // 三源全不同：信任 ipwho.is → ipinfo → 其余
                const p = valid.find(r => r.source === 'ipwho.is') || valid.find(r => r.source === 'ipinfo') || valid[0];
                winners = [p];
            }
        }

        // 坐标优先在获胜组内取，保证 国家 / 坐标 / 时区 同源自洽
        const inGroup = pickCoords(winners);
        if (inGroup) {
            const tzSrc = winners.find(r => r.timezone);
            return {
                country: winners[0].country,
                lat: inGroup.lat, lon: inGroup.lon,
                timezone: inGroup.timezone || (tzSrc && tzSrc.timezone) || null,
                source: inGroup.source,
                ip: null,
            };
        }

        // 获胜组无坐标 → 退而求其次，但国家/时区跟随坐标来源，宁可整体换源也不拼凑
        const any = pickCoords(valid);
        if (!any) return null;
        return {
            country: any.country,
            lat: any.lat, lon: any.lon,
            timezone: any.timezone || null,
            source: any.source,
            ip: null,
        };
    }

    /* ══════════════════════════════════════════════════
       11. 应用与主循环
       ══════════════════════════════════════════════════ */
    function applyGeo(g) {
        const prevCountry = state.country;
        const prevTz = state.timezone;

        state.lat = g.lat;
        state.lon = g.lon;
        state.country = g.country;
        state.ip = g.ip;
        if (isValidTz(g.timezone)) state.timezone = g.timezone;

        const first = !state.ready;
        state.ready = true;

        // 首次定位、以及切换节点导致出口地区变化时，都要重算语言
        if (first || prevCountry !== g.country) {
            applyLanguage(g.country);
        }
        if (!first && prevCountry && prevCountry !== g.country) {
            warn('出口地区变化:', prevCountry, '→', g.country, '，时区', prevTz, '→', state.timezone);
        }

        gmSet(CACHE_KEY, {
            ip: g.ip, country: g.country, lat: g.lat, lon: g.lon,
            timezone: state.timezone, ts: RealDate.now(),
        });

        if (first) flushPending();
        pushWatchers();

        log('定位就绪 →', g.ip, '|', g.country, '|', state.timezone, '|', g.lat + ',' + g.lon, '| 源:', g.source);
    }

    let lastIP = null;
    let busy = false;

    async function tick() {
        if (busy) return;
        busy = true;
        try {
            const ip = await getExitIP();
            if (!ip || ip === lastIP) return;
            lastIP = ip;

            if (state.ip === ip && state.ready) return;   // 与缓存一致，无需重查

            log('出口 IP:', ip, '→ 三源查询中');

            const results = await Promise.all([
                srcIpWhoIs(ip).catch(() => null),
                srcFreeIpApi(ip).catch(() => null),
                srcIpInfo(ip).catch(() => null),
                srcIpApiCo(ip).catch(() => null),
            ]);

            const winner = vote(results);
            if (!winner) {
                lastIP = null;   // 允许下一轮重试，避免一次失败永久卡死
                warn('全部数据源失败，保留现有状态');
                return;
            }
            winner.ip = ip;
            applyGeo(winner);
        } catch (e) {
            warn('tick 异常', e);
        } finally {
            busy = false;
        }
    }

    /* ══════════════════════════════════════════════════
       12. 装配
       ══════════════════════════════════════════════════ */
    if (CONFIG.spoofGeolocation) {
        try { installGeolocation(); } catch (e) { warn('geolocation 装配失败', e); }
        try { installPermissions(); } catch (e) { warn('permissions 装配失败', e); }
    }
    if (CONFIG.spoofTimezone) {
        try { installIntl(); } catch (e) { warn('Intl 装配失败', e); }
        try { installDatePrototype(); } catch (e) { warn('Date 原型装配失败', e); }
        if (CONFIG.deepDatePatch) {
            try { installDateConstructor(); } catch (e) { warn('Date 构造器装配失败', e); }
        }
    }
    try { installRTC(); } catch (e) { warn('WebRTC 装配失败', e); }
    // 语言对齐的补丁必须在 Intl / Date 补丁之后装配，它会接管 toLocale*。
    // 补丁在 document-start 就装好，实际语言值等出口 IP 解析完成后填入。
    try { installLanguageShims(); } catch (e) { warn('语言补丁装配失败', e); }

    // 轮询：页面隐藏时暂停，可见时立即补一次
    let timer = null;
    function startPolling() {
        stopPolling();
        timer = setInterval(tick, CONFIG.pollMs);
    }
    function stopPolling() {
        if (timer !== null) { clearInterval(timer); timer = null; }
    }

    tick();
    startPolling();

    try {
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') stopPolling();
            else { tick(); startPolling(); }
        });
    } catch (e) { }

    // ── 启动自检（仅 debug = true）──
    if (CONFIG.debug) {
        (async function selfCheck() {
            const mine = await getExitIP();
            const direct = await probeDirectIP();
            if (mine && direct && mine === direct) {
                console.warn('[地理自洽] ⚠️ 直连 IP 与出口 IP 相同，当前请求未走代理。' +
                    '此时时区/定位跟随真实 IP，与网站看到的一致，属安全状态。');
            } else if (mine && direct) {
                log('代理生效：出口', mine, '｜直连', direct);
            }

            // 等首次定位落库
            for (let i = 0; i < 40 && !state.ready; i++) await new Promise(r => setTimeout(r, 100));

            const d = new RealDate();
            const w = new RealDate(d.getTime() + offsetMinutesEast(state.timezone || 'UTC', d.getTime()) * 60000);
            const wall = pad2(w.getUTCHours()) + ':' + pad2(w.getUTCMinutes()) + ':' + pad2(w.getUTCSeconds());
            console.info('%c[地理自洽 · 自检]', 'font-weight:bold');
            console.table([
                { 项: '出口 IP（脚本查到）', 值: state.ip || '(未解析)' },
                { 项: '直连 IP（绕过代理）', 值: direct || '(探测失败)' },
                { 项: '国家', 值: state.country || '-' },
                { 项: 'Intl 时区', 值: Intl.DateTimeFormat().resolvedOptions().timeZone },
                { 项: 'getTimezoneOffset', 值: String(d.getTimezoneOffset()) },
                { 项: '目标时区墙上时间', 值: wall + ' (应为 ' + offsetString(offsetMinutesEast(state.timezone || 'UTC', d.getTime())) + ')' },
                { 项: 'Date.prototype.toString()', 值: d.toString() },
                { 项: 'navigator.language', 值: navigator.language },
                { 项: 'navigator.languages', 值: (navigator.languages || []).join(',') },
                { 项: 'Intl 默认区域', 值: Intl.DateTimeFormat().resolvedOptions().locale },
                { 项: 'WebRTC 策略', 值: CONFIG.rtcProtection === 'off'
                        ? 'off（由网络层扩展接管）' : CONFIG.rtcProtection },
                { 项: '语言对齐', 值: CONFIG.langMode === 'off' ? '关'
                        : (CONFIG.langMode + ' → ' + (navigator.languages || []).join(', ')) },
                { 项: '请求头 Accept-Language', 值: _headerLangSeen
                        || (CONFIG.langMode === 'off' ? '不适用（语言对齐已关闭）' : '(未校验)') },
            ]);
            console.info('%c配套检查（本脚本只能验证 ③，① 必装、② 可选）',
                'font-weight:bold',
                '\n  ① 网络层  【必装】WebRTC Network Limiter 已启用，Options 选「Use my proxy server (if present)」' +
                '\n  ② 协议头  【可选】装 geospoof-lang-header 并把 langMode 设为 "match"，' +
                '\n              或把浏览器界面语言改成 English 且 langMode = "en"；' +
                '\n              都不做就保持 langMode = "off"（此时语言项随 IP，属已知取舍）' +
                '\n  ③ 页面 JS 本脚本已接管（见上表）' +
                '\n  → 用 browserleaks.com/webrtc 复验 ①：候选应只剩 .local 或为空');
            if (mine && direct && mine !== direct) {
                console.info('%c注意：只有「出口 IP」这一项需要与检测站显示的公网 IP 对齐；' +
                    '若两者不同，说明代理是多出口负载均衡 —— 此时更不能在脚本里改写 WebRTC 候选' +
                    '（改写出来的 IP 会和检测站眼里的出口对不上），让网络层扩展直接禁掉非代理 UDP 才稳。',
                    'color:#c60');
            }
        })();
    }
})();
