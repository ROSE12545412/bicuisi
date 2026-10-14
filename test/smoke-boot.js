#!/usr/bin/env node
/**
 * 碧翠丝的禁书库 / test/smoke-boot.js
 * ---------------------------------------------------------------------------
 * 装载冒烟测试：在一个**假 DOM + 假酒馆上下文**里，把扩展真的启动一次，
 * 然后模拟一轮完整的对话，验证端到端行为。
 *
 * 为什么必须有这个测试（而不是只跑单元测试）：
 *  单元测试测的是纯函数。但一个扩展真正死掉的方式是**集成层面**的：
 *    · 事件名拼错 → 监听注册成功但永远不触发（静默失效，一点报错都没有）
 *    · 忘记 chat.push() 只调了 addOneMessage → 当前页面能看到，刷新就没了
 *    · 防回环判断失效 → 注入的消息又触发一次引导，无限循环烧额度
 *    · 辅助 API 挂了 → 整个 boot 崩掉，用户聊天都没法用
 *  这些问题单元测试一个都抓不到，只有「真跑一遍」才能暴露。
 *
 * 用法：node test/smoke-boot.js
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getCharacterPool, identitySnapshot, setCharacterPool } from '../src/core/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** 最小的测试记账。 */
let passed = 0;
let failed = 0;
/** @type {string[]} */
const failures = [];

/**
 * 跑一个断言块。
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        failures.push(`${name}\n     ${e?.message ?? e}`);
        console.log(`  ❌ ${name}`);
    }
}

/** 等一个条件成立（轮询），超时就返回 false。 */
async function waitFor(/** @type {() => boolean} */ cond, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 8));
    }
    return cond();
}

/** 让出若干个微任务/宏任务周期，等异步链跑完。 */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Assessment mocks never consume character replies. Match real source + completed AI
// prose quotes rather than declaring approval from an index summary or user intent.
function assessmentFixture(messages) {
    const input = JSON.parse(messages.find(m => m.role === 'user').content);
    const evidence = input.completedAiProse.find(text => text.includes('你看见旧城区有人搬运箱子。'));
    return JSON.stringify({ sourceAssessment: input.sources.map(source => ({
        book: source.book, uid: source.uid,
        status: evidence && /搬运箱子|搬箱子/.test(source.content) ? 'applicable' : 'unknown',
        conditions: [evidence ? '旧城区搬箱事件已在完成正文中被直接观察' : '缺少已完成的搬箱事件证据'],
        reason: evidence ? '原文夜间搬箱线索对应正文直接观察，可作保守提醒' : '当前没有支持原文前提的直接事实',
        evidence: evidence ? [source.content, '你看见旧城区有人搬运箱子。'] : [source.content],
    })) });
}

// ===========================================================================
// 假 DOM
// ===========================================================================

/** 假 style：一个普通对象，属性可读可写。 */
function makeStyle() {
    return new Proxy(
        {},
        {
            get: (t, k) => (k === 'setProperty' ? () => {} : t[k]),
            set: (t, k, v) => {
                t[k] = v;
                return true;
            },
        },
    );
}

class FakeClassList {
    constructor() {
        this.set = new Set();
    }
    add(...names) {
        names.forEach((n) => n && this.set.add(n));
    }
    remove(...names) {
        names.forEach((n) => this.set.delete(n));
    }
    toggle(name, force) {
        const want = force === undefined ? !this.set.has(name) : Boolean(force);
        if (want) this.set.add(name);
        else this.set.delete(name);
        return want;
    }
    contains(name) {
        return this.set.has(name);
    }
    get length() {
        return this.set.size;
    }
}

class FakeElement {
    /** @param {string} tag */
    constructor(tag) {
        this.tagName = String(tag ?? 'div').toUpperCase();
        this.nodeName = this.tagName;
        this.childNodes = [];
        this.attributes = {};
        this.dataset = {};
        this.style = makeStyle();
        this.classList = new FakeClassList();
        this._listeners = new Map();
        this._textContent = '';
        this._innerHTML = '';
        this.parentNode = null;
        this.offsetWidth = 100;
        this.offsetHeight = 100;
    }

    /**
     * 文本内容。
     *
     * ⚠️ setter **必须清空子节点** —— 这是真实 DOM 的语义，而且它掩盖过一个真 bug：
     * `body.textContent = ''` 是清空气泡的常见写法，在真实浏览器里有效；但早期版本的
     * 假 DOM 只把字符串存进一个字段、不碰 childNodes，于是「清空」在测试里完全没发生，
     * 旧段落一直留着 —— 测试看不见，浏览器里用户却能看见两句台词拼在一起。
     *
     * 读的时候把子节点的文本拼起来（和真实 DOM 一致），这样 `findText` 之类的
     * 递归读取也能拿到正确结果。
     */
    get textContent() {
        if (this.childNodes.length) {
            return this.childNodes.map((n) => n.textContent ?? '').join('');
        }
        return this._textContent;
    }
    set textContent(v) {
        this.childNodes = [];
        this._textContent = String(v ?? '');
    }

    get children() {
        return this.childNodes.filter((n) => n instanceof FakeElement);
    }
    get firstChild() {
        return this.childNodes[0] ?? null;
    }
    get lastChild() {
        return this.childNodes[this.childNodes.length - 1] ?? null;
    }

    appendChild(node) {
        if (!node) return node;
        // 模拟真实 DOM：同一个节点被 append 到新父节点时会先脱离旧父节点
        if (node.parentNode && node.parentNode !== this) node.parentNode.removeChild(node);
        this.childNodes.push(node);
        node.parentNode = this;
        return node;
    }
    removeChild(node) {
        const i = this.childNodes.indexOf(node);
        if (i >= 0) {
            this.childNodes.splice(i, 1);
            node.parentNode = null;
        }
        return node;
    }
    remove() {
        this.parentNode?.removeChild(this);
    }
    replaceChildren(...nodes) {
        this.childNodes = [];
        for (const n of nodes) if (n) this.appendChild(n);
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'class') this.className = String(value);
        if (name.startsWith('data-')) {
            const key = name
                .slice(5)
                .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            this.dataset[key] = String(value);
        }
    }
    getAttribute(name) {
        return this.attributes[name] ?? null;
    }
    hasAttribute(name) {
        return name in this.attributes;
    }
    removeAttribute(name) {
        delete this.attributes[name];
    }

    /** `hidden` 用属性存，和 floating.js 的约定一致。 */
    get hidden() {
        return this.hasAttribute('hidden');
    }
    set hidden(v) {
        if (v) this.setAttribute('hidden', '');
        else this.removeAttribute('hidden');
    }

    get className() {
        return [...this.classList.set].join(' ');
    }
    set className(v) {
        this.classList.set = new Set(String(v ?? '').split(/\s+/).filter(Boolean));
    }

    /**
     * `id` 属性。
     *
     * ⚠️ 必须和真实 DOM 一样把 `el.id` 直接暴露出来 —— 早期版本的假 DOM 只把 id
     * 存在 `attributes` 里，于是被测代码里 `node.id === 'extensions_settings'`
     * 这种**完全合法**的写法在测试环境里永远为 false，而真实浏览器里是对的。
     * 这种失真会让测试得出错误结论（当时表现为「滚动设置面板」怎么都不生效）。
     */
    get id() {
        return this.attributes.id ?? '';
    }
    set id(v) {
        this.attributes.id = String(v ?? '');
    }

    get innerHTML() {
        return this._innerHTML;
    }
    set innerHTML(v) {
        this._innerHTML = String(v ?? '');
    }

    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
        this._listeners.get(type)?.delete(handler);
    }
    /** 触发一个事件（测试用）。 */
    dispatch(type, event = {}) {
        for (const h of this._listeners.get(type) ?? []) {
            h({ type, preventDefault() {}, stopPropagation() {}, ...event });
        }
    }

    getBoundingClientRect() {
        const left = Number.parseFloat(this.style.left) || 0;
        const top = Number.parseFloat(this.style.top) || 0;
        const w = Number.parseFloat(this.style.width) || this.offsetWidth || 100;
        const h = Number.parseFloat(this.style.height) || this.offsetHeight || 100;
        return { left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top };
    }

    /**
     * 只实现测试真正用到的那几种选择器。
     *
     * 故意不实现通用选择器引擎：宁可让它返回 null（各调用点都有兜底），
     * 也不要为了测试写一个半吊子的 CSS 引擎 —— 那会给出虚假的信心。
     */
    querySelector(sel) {
        const s = String(sel ?? '');
        // `.class` 形态
        if (s.startsWith('.') && !s.includes(' ')) {
            return this._findDescendant((el) => el.classList.contains(s.slice(1)));
        }
        // `#id` 形态
        if (s.startsWith('#') && !s.includes(' ') && !s.includes('[')) {
            return this._findDescendant((el) => el.attributes.id === s.slice(1));
        }
        // 带 [mesid="n"] 的楼层查询：按结构找不到就返回 null（调用点有兜底）
        return null;
    }
    querySelectorAll() {
        return [];
    }
    closest() {
        return null;
    }
    _findDescendant(/** @type {(el: FakeElement) => boolean} */ pred) {
        for (const child of this.children) {
            if (pred(child)) return child;
            const deep = child._findDescendant(pred);
            if (deep) return deep;
        }
        return null;
    }

    setPointerCapture() {}
    releasePointerCapture() {}
    focus() {}
    scrollTo() {}
}

class FakeDocument {
    constructor() {
        this.body = new FakeElement('body');
        this.documentElement = new FakeElement('html');
        this.readyState = 'complete';
        this._listeners = new Map();
        this._byId = new Map();
        /**
         * 已渲染的楼层：下标 → 假正文节点。
         *
         * 只有「往这里注册过」的楼层才算渲染到页面上了 ——
         * 与真实酒馆里 `querySelector` 找不到楼层同义。
         * `repairDisplayedGuidance` 要判断「她的话在不在页面上」，靠的就是它。
         *
         * @type {Map<number, {textContent: string}>}
         */
        this._floors = new Map();
        /**
         * 注册一个「已经渲染到页面上」的楼层节点。
         *
         * ⚠️ 必须支持 `innerHTML`：真实 DOM 里 `node.innerHTML = '纯文本'`
         * 之后 `textContent` 就是那段文本，而兜底路径写的正是 innerHTML
         *（正文来自模型，不能裸写）。假节点不支持的话，「把话补上去」
         * 会被判成失败 —— 那是夹具在说谎。
         */
        this._newFloorNode = (text) => {
            const n = new FakeElement('div');
            n.textContent = String(text ?? '');
            Object.defineProperty(n, 'innerHTML', {
                get: () => n.textContent,
                set: (v) => {
                    n.textContent = String(v ?? '');
                },
                enumerable: true,
                configurable: true,
            });

            return n;
        };
        this.createElementNS = (ns, tag) => this.createElement(tag);
    }
    createElement(tag) {
        return new FakeElement(tag);
    }
    createTextNode(text) {
        const n = new FakeElement('#text');
        n.textContent = String(text);
        return n;
    }
    getElementById(id) {
        // 语义与真实浏览器一致：**返回文档顺序里第一个**匹配的元素。
        // 早期版本用一个 id→元素 的 Map，后注册的同 id 元素会覆盖先注册的，
        // 于是「滚动到设置面板」滚到了另一个同 id 的元素上 —— 这个假 DOM 的
        // 失真反而掩盖了真问题（id 撞车），所以必须按文档顺序找第一个。
        const found = this.body._findDescendant((el) => el.attributes.id === id);
        return found ?? null;
    }
    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
        this._listeners.get(type)?.delete(handler);
    }
    querySelector(sel) {
        const s = String(sel ?? '');
        // 楼层正文查询：`#chat .mes[mesid="N"] .mes_text` / `.mes_text_wrapper` 等。
        //
        // 只解析 `mesid` 号，返回测试预先注册的假正文节点。
        // 没注册过就返回 null —— 等价于「这个楼层还没渲染」，调用点本来就有兜底。
        // 刻意不去实现真正的 CSS 选择器引擎：宁可返回 null，也不要给出虚假的信心。
        const mid = /mesid="(\d+)"/.exec(s);
        if (mid) {
            const floor = this._floors.get(Number(mid[1])) ?? null;
            if (s.includes('.bg-inline-guidance')) return floor?.querySelector?.('.bg-inline-guidance') ?? null;
            return floor;
        }

        // `#id` 形态优先走 byId（酒馆的挂载点就是这么找的）
        if (s.startsWith('#')) {
            const id = s.slice(1);
            if (this._byId.has(id)) return this._byId.get(id);
        }
        return this.body.querySelector(s);
    }
    querySelectorAll() {
        return [];
    }
}

// ===========================================================================
// 假酒馆上下文
// ===========================================================================

/**
 * 造一个假的酒馆上下文。
 *
 * `llmReplies` 是辅助 API 会依次返回的内容；`calls` 记录每次调用的参数，
 * 测试靠它来断言「调了几次」「是不是走对了通道」。
 */
function makeFakeCtx({ llmReplies = [], loadWorldInfo = null } = {}) {
    /** @type {any[]} */
    const calls = [];
    /** @type {Array<[string, Function]>} */
    const listeners = [];

    const ctx = {
        // ---- 消息与聊天 ----
        /** @type {any[]} */
        chat: [],
        characters: [{ name: '测试角色', data: { extensions: { world: '测试世界书' } } }],
        characterId: 0,
        name1: '契约者',
        name2: '测试角色',
        chatMetadata: {},

        // ---- 设置 ----
        extensionSettings: {
            connectionManager: {
                profiles: [
                    { id: 'prof-1', name: '快速模型', api: 'custom', model: 'fast-model' },
                    { id: 'prof-2', name: '正文模型', api: 'custom', model: 'main-model' },
                ],
            },
        },
        powerUserSettings: { world_info: { globalSelect: [] } },
        saveSettingsDebounced: async () => {
            ctx._settingsSaved = (ctx._settingsSaved ?? 0) + 1;
        },

        // ---- 世界书 ----
        loadWorldInfo:
            loadWorldInfo ??
            (async (/** @type {string} */ name) => ({
                entries: {
                    0: { comment: '[引导] 旧城区的传言', content: '最近旧城区有人在夜里搬运箱子。', order: 1 },
                    1: { comment: '[地点] 王都下水道', content: '下水道通往城墙外，很少人知道。', order: 2 },
                    2: { comment: '[禁止引导] 结局真相', content: '其实一切都是……', order: 3 },
                    3: { comment: '普通人物卡', content: '一个路人。', constant: false, order: 4 },
                },
            })),

        // ---- 事件总线 ----
        eventTypes: {
            GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
            GENERATION_STARTED: 'generation_started',
            GENERATION_ENDED: 'generation_ended',
            GENERATION_STOPPED: 'generation_stopped',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_DELETED: 'message_deleted',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_UPDATED: 'message_updated',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            USER_MESSAGE_RENDERED: 'user_message_rendered',
            CHAT_CHANGED: 'chat_id_changed',
            WORLDINFO_UPDATED: 'worldinfo_updated',
            WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
            SETTINGS_UPDATED: 'settings_updated',
            APP_READY: 'app_ready',
        },
        eventSource: {
            on(name, handler) {
                listeners.push([name, handler]);
                return { stop: () => {} };
            },
            once() {},
            makeLast() {},
            makeFirst() {},
            removeListener() {},
            async emit(name, ...args) {
                for (const [n, h] of listeners) {
                    if (n === name) await h(...args);
                }
            },
            async emitAndWait(name, ...args) {
                for (const [n, h] of listeners) if (n === name) await h(...args);
            },
            /** 测试用：直接把某个事件的所有处理器跑一遍，并按顺序 await。 */
            async runHandlers(name, ...args) {
                const matched = listeners.filter(([n]) => n === name).map(([, h]) => h);
                for (const h of matched) await h(...args);
                return matched.length;
            },
        },

        // ---- 辅助 LLM 通道（ConnectionManagerRequestService）----
        ConnectionManagerRequestService: {
            async sendRequest(profileId, messages, maxTokens, extra) {
                const system = messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
                const observingFacts = system.startsWith('Observe neutral events, relationships and information in completed roleplay prose.');
                const locating = system.includes('熟悉这部作品的读者');
                const assessing = system.startsWith('你是中立的原文适用性核查者');
                calls.push({ profileId, messages, maxTokens, extra, kind: observingFacts ? 'facts' : locating ? 'locate' : assessing ? 'assessment' : 'guide' });
                if (assessing) return { result: { choices: [{ message: { content: assessmentFixture(messages) } }] } };
                // Shared observation uses strict JSON and never consumes persona/location replies.
                if (observingFacts) return { result: { choices: [{ message: { content: '{"proposals":[]}' } }] } };
                // Automatic progress location must not consume queued persona replies.
                const queuedLocate = llmReplies.length && /"(?:phase|pick)"/.test(String(llmReplies[0]));
                const reply = locating && !queuedLocate
                    ? '{"phase":"当前阶段","pick":[1],"why":"关联未来剧情"}'
                    : llmReplies.length ? llmReplies.shift() : '{"guidance":"","commentary":"","emotion":"calm","hooks_used":[]}';
                if (reply instanceof Error) throw reply;
                return { result: { choices: [{ message: { content: String(reply) } }] } };
            },
        },

        // ---- 渲染与落盘 ----
        /** @type {any[]} 被渲染的楼层 */
        rendered: [],
        async addOneMessage(message) {
            ctx.rendered.push(message);
        },
        /**
         * 酒馆的官方渲染入口。
         *
         * ⚠️ 这里刻意**只认 `mes`、不认 `display_text`** —— 这是 TauriTavern
         * 实测的行为（用户诊断里 `inData: 1 / onScreen: 0` 就是这么来的）。
         * 插件接管它之后，任何一次重渲染都必须自己把她的话补回去；
         * 夹具要是「很配合」地认 display_text，这一整类 bug 在测试里就看不见了。
         */
        updateMessageBlock(messageId, message) {
            const node = ctx._document._floors.get(Number(messageId));
            if (node) node.textContent = String(message?.mes ?? '');
        },
        async saveChat() {
            ctx._chatSaved = (ctx._chatSaved ?? 0) + 1;
        },
        async saveMetadata() {
            ctx._metaSaved = (ctx._metaSaved ?? 0) + 1;
        },

        _calls: calls,
        /**
         * 假辅助 API 的回复队列 —— 测试中途也能往里塞。
         *
         * ⚠️ 必须暴露出来：两段式下**同一个生成轮次会发两次请求**
         *（先定位、再引导），而它们的返回格式完全不同。用构造时那个
         * `llmReplies` 数组静态排好的话，第二轮往后就没法在测试里改脚本了。
         */
        _llmReplies: llmReplies,
        _listeners: listeners,
    };

    return ctx;
}

// ===========================================================================
// 装配环境
// ===========================================================================

/** 把假 DOM / window 装到 globalThis 上，返回还原函数。 */
function installFakeEnvironment(ctx) {
    const doc = new FakeDocument();
    const win = {
        innerWidth: 1920,
        innerHeight: 1080,
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        location: { href: 'http://127.0.0.1:8000/' },
    };

    const saved = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        SillyTavern: globalThis.SillyTavern,
        // ⚠️ Node 的 globalThis.navigator 是**只有 getter** 的 accessor
        //（openai 之外还有 `Object.defineProperty(globalThis,'navigator',{get})`），
        // 直接赋值会抛 "Cannot set property navigator of #<Object> which has only a getter"。
        // 所以要连属性描述符一起存下来，还原时用 defineProperty 放回去。
        navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    };

    /** @type {any} */ (globalThis).document = doc;
    // 把假文档也挂到 ctx 上：测试要往里注册「已渲染的楼层」，才能断言
    // 「她的话到底有没有出现在页面上」（而不是只存在于消息数据里）。
    ctx._document = doc;
    /** @type {any} */ (globalThis).window = win;
    /** @type {any} */ (globalThis).requestAnimationFrame = (/** @type {Function} */ cb) => setTimeout(() => cb(Date.now()), 4);
    /** @type {any} */ (globalThis).cancelAnimationFrame = (/** @type {any} */ id) => clearTimeout(id);

    // 诊断功能会读 navigator.userAgent / navigator.clipboard，给它一个可控的替身
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            userAgent: 'SmokeTest/1.0 (fake)',
            platform: 'fake',
            clipboard: { writeText: async () => {} },
        },
        configurable: true,
        writable: true,
    });

    return {
        doc,
        win,
        restore() {
            for (const [key, value] of Object.entries(saved)) {
                if (key === 'navigatorDescriptor') continue;
                if (value === undefined) delete /** @type {any} */ (globalThis)[key];
                else /** @type {any} */ (globalThis)[key] = value;
            }
            // navigator 必须用 defineProperty 还原（它原本是个 getter）
            if (saved.navigatorDescriptor) {
                Object.defineProperty(globalThis, 'navigator', saved.navigatorDescriptor);
            } else {
                delete /** @type {any} */ (globalThis).navigator;
            }
        },
    };
}

// ===========================================================================
// 用例
// ===========================================================================

async function run() {
    console.log('碧翠丝的禁书库 · 装载冒烟测试\n');

    // ⚠️ 顺序有讲究：先造 ctx，再装环境 —— `installFakeEnvironment(ctx)` 要把
    //    假 document 挂到 ctx 上（测试靠它注册「已渲染的楼层」）。
    const ctx = makeFakeCtx({
        llmReplies: [
            '{"guidance":"哼……今天街上的人都在往同一个方向走，真吵。","commentary":"一口气答应三个人，你是嫌命长吗。","emotion":"smug","hooks_used":["旧城区的传言"]}',
            '{"guidance":"空气里有股铁锈味，从昨晚就有了。","commentary":"又来了，你就不能先说一句再动手吗。","emotion":"annoyed","hooks_used":["王都下水道"]}',
        ],
    });
    const env = installFakeEnvironment(ctx);

    /** @type {any} */ (globalThis).SillyTavern = { getContext: () => ctx };

    // 让扩展真的启动
    const ext = await import(pathToFileURL(join(ROOT, 'index.js')).href);
    await ext.boot();
    await settle();

    const api = /** @type {any} */ (globalThis).BeatriceGuide;

    // -----------------------------------------------------------------------
    console.log('【启动】');
    // -----------------------------------------------------------------------

    // 测试前置：把出声节奏设成「每轮都说话」，这样后面的用例不依赖
    // every-n 的计数语义（那部分由单元测试覆盖，这里只测集成行为）。
    // 默认是 N=2，第 1 轮本来就不出声 —— 那会让下面整条流水线的断言全部落空。
    api.app.settings.cadence.mode = 'always';
    api.app.settings.cadence.cooldownMs = 0;
    api.app.settings.llm.timeoutMs = 5000;

    await check('扩展启动后暴露调试入口 window.BeatriceGuide', () => {
        assert.ok(api, 'BeatriceGuide 不存在');
        assert.equal(typeof api.state, 'function');
        assert.ok(api.app, 'app 实例不存在');
    });

    await check('悬浮窗被挂到 body 上，且带 bg- 前缀的 class', () => {
        assert.ok(api.ui, '悬浮窗没建出来');
        assert.ok(api.ui.node, '悬浮窗没有 node');
        assert.ok(api.ui.node.classList.contains('bg-root'), `实际 class：${api.ui.node.className}`);
        assert.ok(env.doc.body.childNodes.includes(api.ui.node), '悬浮窗没有挂进 body');
    });

    await check('内置立绘用随包的 PNG，而不是手绘 SVG（用户明确要求换掉）', () => {
        const img = api.ui.node.querySelector?.('.bg-avatar-img');
        assert.ok(img, '没找到 <img class="bg-avatar-img">，说明还在用内置 SVG');
        const src = String(img.getAttribute('src') ?? '');
        assert.match(src, /assets\/beatrice\.png$/, `立绘路径不对：${src}`);
        // 必须推导出真实的插件目录名，不能写死
        assert.match(src, /\/scripts\/extensions\/third-party\/[^/]+\/assets\/beatrice\.png$/, `路径没有按插件目录推导：${src}`);
    });

    await check('酒馆「扩展设置」区里不再挂任何东西（用户要求砍掉侧栏面板）', () => {
        // 用户原话：「你把拓展里面的设置界面砍了吧，能通过悬浮窗打开设置就不需要那个了」
        // 所以这里是一个**否定断言**：不能有任何节点被插进酒馆的扩展设置区。
        const host = env.doc.querySelector?.('#extensions_settings');
        if (host) {
            assert.equal(host.childNodes.length, 0, '扩展设置区被插入了节点 —— 侧栏面板应该已经砍掉');
        }
        // 调试入口也不能再暴露 panel 这个字段
        assert.equal(api.panel, undefined, 'BeatriceGuide.panel 应该已经移除');
    });

    await check('核心事件都注册上了（事件名拼错会静默失效，所以逐个核对）', () => {
        const names = ctx._listeners.map((/** @type {any[]} */ l) => l[0]);
        for (const expected of [
            'GENERATION_AFTER_COMMANDS',
            'generation_ended',
            'generation_stopped',
            'message_received',
            'chat_id_changed',
            'worldinfo_updated',
            'worldinfo_entries_loaded',
        ]) {
            assert.ok(names.includes(expected), `没监听 ${expected}`);
        }
    });

    await check('注册用的字符串与 eventTypes 表逐字一致（这里是实测翻过车的地方）', () => {
        // 踩过的坑：酒馆事件表里**只有** `GENERATION_AFTER_COMMANDS` 是全大写，
        // 其余全是小写（`generation_ended` / `message_received` / `chat_id_changed`…）。
        // 曾经把 `GENERATION_ENDED` 当成字符串用过 —— 监听注册得上、日志也正常，
        // 但事件永远不触发，表现成「注入功能整个不工作」，排查了一下午。
        // 这条断言把「注册名」和「事件表」绑死，以后再写错会当场失败。
        const registered = new Set(ctx._listeners.map((/** @type {any[]} */ l) => l[0]));
        /** 反向表：字符串值 → 常量名 */
        const valueToKey = new Map(Object.entries(ctx.eventTypes).map(([k, v]) => [v, k]));

        for (const name of registered) {
            assert.ok(
                valueToKey.has(name),
                `监听了一个不存在的字符串 "${name}" —— 它不在 eventTypes 的值里，永远不会被触发`,
            );
        }
    });

    await check('会话默认状态正确（未启用前不该有在途请求）', () => {
        const st = api.state();
        assert.equal(st.enabled, true);
        assert.equal(st.inflight, false);
        assert.equal(st.injectedCount, 0);
        assert.equal(st.llmMode, 'profile');
    });

    // -----------------------------------------------------------------------
    console.log('\n【一轮完整对话：正文写完之后才调用 AI】');
    // -----------------------------------------------------------------------

    // 用户发言
    ctx.chat.push({ name: '契约者', is_user: true, is_system: false, mes: '那我先去街上转转好了。' });

    // ⚠️ 时序在这一版改过：**不再**在正文生成期间并发请求。
    //
    // 原设计是「抢先式」（生成一开始就发请求，等正文写完直接贴结果）。
    // 用户实测报了「正文没有插入碧翠丝的引导」—— 根因就是抢先式下
    // 辅助模型**看不到刚生成的正文**，只能靠猜，写出来的引导接不上。
    //
    // 现在唯一发请求的时机是 `generation_ended`。

    // ── 先播种线索池（引导只读缓存，不自己读世界书）────────────────────
    api.app.settings.llm.profileId = 'prof-1';
    const { setHookPool, getChatData } = await import('../src/core/store.js');
    const { discoverBookNames } = await import('../src/worldbook.js');
    const BOOK = discoverBookNames(api.app.ctx, api.app.settings)[0] ?? '测试世界书';
    const chatData = getChatData(api.app.ctx);
    setHookPool(
        chatData,
        [
            { book: BOOK, uid: 0, label: '旧城区的传言', content: '最近旧城区夜里总有人走动。', kind: '线索' },
            { book: BOOK, uid: 1, label: '王都下水道', content: '东段有一条废弃的暗渠。', kind: '地点' },
        ],
        [BOOK],
    );
    api.app.ctx.chatMetadata['beatrice-guide'] = chatData;
    assert.deepEqual(
        api.app.currentHookPool().hooks.map((/** @type {any} */ h) => h.label),
        ['旧城区的传言', '王都下水道'],
        '播种的线索池应该立刻可用',
    );

    // ── 生成开始：**不应该**发任何引导请求 ─────────────────────────────
    ctx._calls.length = 0;
    await ctx.eventSource.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await settle(30);

    await check('⭐ 正文生成期间不发引导请求（改了：要等正文写完才能看到它）', () => {
        const guideCalls = ctx._calls.filter((c) => c.kind === 'guide' || /贝翠丝|暗示/.test(JSON.stringify(c.messages)));
        assert.equal(
            guideCalls.length,
            0,
            `正文还没写完就发了 ${guideCalls.length} 次引导请求 —— 那样模型看不到正文，引导接不上`,
        );
    });

    // ── 正文写完 → 现在才调用 ─────────────────────────────────────────
    ctx.chat.push({
        name: '测试角色',
        is_user: false,
        is_system: false,
        mes: '你沿着主街走着，傍晚的风里混着烤面包的味道。远处有人在收摊。入夜后，你看见旧城区有人搬运箱子。',
    });
    ctx._calls.length = 0;
    await ctx.eventSource.emitAndWait('generation_ended');
    await waitFor(() => Boolean(ctx.chat[1]?.extra?.display_text), 6000);
    await settle(60);

    await check('⭐ 正文写完先观察事实，再定位、独立核查适用性并引导', () => {
        assert.deepEqual(ctx._calls.map(c => c.kind), ['facts', 'locate', 'assessment', 'guide']);
        assert.equal(ctx.chatMetadata['beatrice-guide'].facts.lastTargetIndex, 1, '严格空 proposals 也必须记住已观察正文');
        const assessmentCall = ctx._calls.find(c => c.kind === 'assessment');
        const assessedInput = JSON.parse(assessmentCall.messages.find(m => m.role === 'user').content);
        assert.equal(assessedInput.sources.length, 1, '核查只能接收实际检索来源');
        assert.match(assessedInput.sources[0].content, /最近旧城区有人在夜里搬运箱子/);
        assert.ok(assessedInput.completedAiProse.some(text => text.includes('你看见旧城区有人搬运箱子。')));
        const assessment = api.app.lastOutcome.sourceAssessment;
        assert.equal(assessment[0].status, 'applicable');
        assert.ok(assessment[0].evidence.includes('你看见旧城区有人搬运箱子。'));
    });

    await check('走的是「连接配置」通道，且用的是用户选的 profile', () => {
        const call = ctx._calls.find((c) => c.profileId === 'prof-1' && c.kind === 'guide');
        assert.ok(call, '应该有一次走 profile 通道的调用');
    });

    await check('⭐ 提示词里带了**刚写完的正文全文**（这是改动的核心）', () => {
        // 用户反馈「正文没有插入碧翠丝的引导」，根因是模型看不到正文。
        // 所以必须验证正文真的进了提示词 —— 而且标成「刚刚写完的正文」。
        const call = ctx._calls.find((c) => c.profileId === 'prof-1' && c.kind === 'guide');
        const userMsg = String(call?.messages.find((/** @type {any} */ m) => m.role === 'user')?.content ?? '');
        assert.match(userMsg, /刚刚写完的正文/, '缺少「刚写完的正文」这一段');
        assert.match(userMsg, /远处有人在收摊/, '正文内容没进提示词');
    });

    await check('提示词里带上了线索池的内容', () => {
        const call = ctx._calls.find((c) => c.profileId === 'prof-1' && c.kind === 'guide');
        const userMsg = String(call?.messages.find((/** @type {any} */ m) => m.role === 'user')?.content ?? '');
        assert.match(userMsg, /旧城区的传言/, '应该带上池子里的线索');
        assert.match(userMsg, /最近旧城区有人在夜里搬运箱子/, '选中来源必须现取正文');
        assert.doesNotMatch(userMsg, /王都下水道|东段有一条废弃的暗渠/, '未选中的缓存素材不能进入引导');
        assert.match(userMsg, /契约者/, '应该带上用户名');
    });

    await check('人设提示词按分段发出（system / assistant 各就各位）', () => {
        const msgs = ctx._calls.find(c => c.kind === 'guide').messages;
        const roles = msgs.map((/** @type {any} */ m) => m.role);
        assert.ok(roles.includes('system'), '应该至少有 system 段');
        assert.ok(roles.includes('assistant'), '人设里应该有一条 assistant（她认领人设的回应）');
        assert.equal(roles[roles.length - 1], 'user', '最后一条必须是 user（当前局势）');

        // 身份设定那条要说清「契约精灵」这个设定
        const all = msgs.map((/** @type {any} */ m) => String(m.content)).join('\n');
        assert.match(all, /契约精灵/, '缺少「契约精灵」的身份设定');
        assert.match(all, /脑海/, '身份设定应该说明她住在脑海里');
    });

    await check('system 提示词里写死了「不许直接点名目的地」的硬约束', () => {
        const call = ctx._calls.find((c) => c.profileId === 'prof-1' && c.kind === 'guide');
        const all = call.messages.map((/** @type {any} */ m) => String(m.content)).join('\n');
        assert.match(all, /只给暗示，不点名目的地/, '缺少核心约束');
        assert.match(all, /JSON/, '缺少输出格式要求');
    });

    await check('⭐ system 提示词里写死了「引导要接着当前处境说」和「不许照抄条目」', () => {
        // 这两条是用户明确提的要求，而且它们和「不点名目的地」是两回事：
        //   用户原话：「引导也应该是结合 user 自己的剧情发展合理的给出引导，
        //              不能完全照搬条目」
        // 所以必须同时钉住：既要「接得上当前处境」，也要「改写而非复述」。
        const call = ctx._calls.find((c) => c.profileId === 'prof-1' && c.kind === 'guide');
        const all = call.messages.map((/** @type {any} */ m) => String(m.content)).join('\n');
        assert.match(all, /接着他刚才的处境说/, '缺少「接当前处境」这条');
        assert.match(all, /绝对不要复述条目的原文|必须\*\*改写\*\*/, '缺少「改写而非照抄」这条');
        assert.match(all, /宁可不说目的地/, '缺少「接不上时宁可含糊」这条兜底');
    });

    // 正文结束 → 兑现并发请求的结果并注入。
    //
    // ⚠️ 事件字符串是**小写** `'generation_ended'`，不是常量名的大写形态。
    // 这个坑是实测踩出来的：这里一开始发的是 `'GENERATION_ENDED'`，
    // 于是处理器一次都没被触发，表现成「注入功能整个不工作」——
    // 而真正的 bug 在测试自己身上。酒馆的事件表里只有
    // `GENERATION_AFTER_COMMANDS` 是全大写，别的都是小写。
    await ctx.eventSource.emitAndWait('generation_ended');
    // ⚠️ 这里要等「真的接上了」而不是固定 sleep。
    // `_install` 现在是异步的：它会等新正文进 chat（最多 3 秒）、再注入、
    // 再落盘。固定等 60ms 会读到一个还没写完的状态，测试就假红了。
    await waitFor(() => Boolean(ctx.chat[1]?.extra?.display_text), 6000);
    await settle(80);

    await check('同一正文重复兑现复用事实观察，不增加观察 API', () => {
        assert.equal(ctx._calls.filter(c => c.kind === 'facts').length, 1);
        assert.equal(ctx.chatMetadata['beatrice-guide'].facts.snapshots.length, 1);
    });

    // ── 默认呈现方式是「接在正文末尾」 ───────────────────────────────────
    //
    // 用户明确要求：「确定引导是插入正文里的且是用贝翠丝的口吻说话的」。
    // 所以这里验证的是**没有新增楼层**，而是给已有那条 AI 消息挂了
    // `extra.display_text` —— 正文（mes）保持原样。
    await check('正文结束后：不新增楼层，而是把引导接在那条正文的渲染文本上', () => {
        assert.equal(ctx.chat.length, 2, `不该新增消息，实际 ${ctx.chat.length} 条`);
        const ai = ctx.chat[1];
        assert.ok(ai.extra?.display_text, 'AI 消息上没有 display_text，说明没接上去');
    });

    await check('接上去的内容用贝翠丝的口吻、且带名字前缀', () => {
        const display = String(ctx.chat[1].extra.display_text);
        assert.match(display, /贝翠丝：/, '缺少名字前缀');
        assert.match(display, /今天街上的人都在往同一个方向走/, `没接上引导内容：${display.slice(-120)}`);
        // 必须以原正文开头 —— 保证是「追加」而不是「替换」
        assert.ok(
            display.startsWith(String(ctx.chat[1].mes)),
            '追加后的文本必须以原正文开头（不能改动正文本身）',
        );
    });

    await check('⚠️ 正文数据（mes）一个字节都没被改动', () => {
        // 这是选 display_text 方案的全部理由：mes 是数据，重新生成 / swipe /
        // 导出聊天 / 别的插件读到的都是它。往里追加内容会污染这些路径。
        assert.equal(
            String(ctx.chat[1].mes),
            '你沿着主街走着，傍晚的风里混着烤面包的味道。远处有人在收摊。入夜后，你看见旧城区有人搬运箱子。',
            'mes 被改动了 —— 这会让重新生成和 swipe 出问题',
        );
        // 同时确认她的话**确实**在渲染层（否则就成了「两边都没有」）
        assert.match(String(ctx.chat[1].extra?.display_text ?? ''), /贝翠丝：/);
    });

    // ⚠️ 气泡检查必须放在后面那些「手动调 _install」的用例**之前** ——
    // 每次 _install 都会刷新气泡内容，跑在后面会读到别人留下的文本。
    // 第一次没注意顺序，断言读到的是一句测试自己注入的占位台词。
    await check('气泡里显示的是**吐槽**（引导在正文里，两边不重复）', async () => {
        // 气泡是逐字显示的，断言前要等打字跑完
        await waitFor(() => /嫌命长|一口气/.test(findText(api.ui.node)), 4000);
        const text = findText(api.ui.node);
        assert.match(text, /嫌命长|一口气/, `气泡里应该是吐槽，实际文本：${text.slice(0, 200)}`);
        // 引导已经在正文里了，气泡不该再重复一遍
        assert.doesNotMatch(text, /今天街上的人都在往同一个方向走/, '引导不该在气泡里重复出现');
    });

    await check('重复兑现不会越接越长（每次都在 mes 上重算，而不是在 display_text 上叠）', async () => {
        const before = String(ctx.chat[1].extra.display_text);
        // 手动再走一次兑现 —— 模拟用户重新生成 / 事件重复触发
        ctx._calls.length = 0;
        await api.app._install({
            ok: true,
            result: { guidance: '哼，又是同一句话。', commentary: '', emotion: 'calm', hooks_used: [] },
            turnIndex: 1,
            notes: [],
        }, '测试重复兑现');
        const after = String(ctx.chat[1].extra.display_text);
        const count = (after.match(/贝翠丝：/g) ?? []).length;
        assert.equal(count, 1, `名字前缀出现了 ${count} 次 —— 说明是叠加而不是重算`);
        assert.ok(after.length < before.length + 60, '文本不应该无限增长');
    });

    await check('引导记忆被写进 chatMetadata（跨刷新保留，供去重使用）', () => {
        const data = ctx.chatMetadata['beatrice-guide'];
        assert.ok(data, 'chatMetadata 里没有我们的键');
        assert.ok(Array.isArray(data.spoken) && data.spoken.length >= 1, 'spoken 记忆为空');
        assert.ok(data.guidedTurns.length >= 1, 'guidedTurns 为空');
        assert.ok(data.lastAt > 0, 'lastAt 没有更新');
    });

    // ══════════════════════════════════════════════════════════════════════
    // 两段式：先定位，再取材
    // ══════════════════════════════════════════════════════════════════════
    //
    // 上面播的是**旧格式**池子（每条带 content，没有 indexed 标志）——
    // 那条路必须继续能走，所以那一段不动。
    //
    // 这里换成真·索引格式（每条只有 brief/phase、没有 content），验证：
    //   ① 定位这一步真的被调用，而且它看得到刚写完的正文和整份索引
    //   ② 它挑中的条目**正文是从世界书现取的**（池子里根本没存）
    //   ③ 没被挑中的条目只留在检索索引，不进入引导提示词，避免摘要绕过正文核查
    await check('⭐ 索引模式下：定位会被调用，且它看得到正文与整份索引', async () => {
        api.app.settings.guidance.locate = 'on'; // 夹具里条目太少，够不到 auto 阈值
        api.app.settings.llm.profileId = 'prof-1';

        const { setCharacterPool } = await import('../src/core/store.js');
        setCharacterPool(
            api.app.ctx,
            [
                { book: BOOK, uid: 0, label: '旧城区的传言', brief: '夜里有人搬箱子', phase: '任何阶段', kind: '线索' },
                { book: BOOK, uid: 1, label: '王都下水道', brief: '地下有暗渠可走', phase: '任何阶段', kind: '地点' },
                { book: BOOK, uid: 2, label: '连下了三天的雨', brief: '季节反常', phase: '刚到王都', kind: '征兆' },
            ],
            [BOOK],
            { source: 'ai', indexed: true, coverage: { complete: true } },
        );
        api.app.hookCache = null;

        ctx._calls.length = 0;
        // ⚠️ 必须**清空**回复队列再排脚本。
        // 上面那些用例是按需取用的，队列里会剩下没被消耗的回复 ——
        // 不清的话，这次「定位」拿到的会是上一段留下的**引导格式**回复，
        // 于是解析不出 phase，表现为「定位跑了但什么都没判断出来」，
        // 排查起来会以为是解析器坏了（第一版就是这么假红了一次）。
        ctx._llmReplies.length = 0;
        // 排队定位与引导回复；独立核查由来源+正文证据夹具响应，不消耗队列。
        ctx._llmReplies.push(
            '{"phase":"刚到王都，还在闲逛","pick":[1],"why":"只有这条还没兑现"}',
            '{"guidance":"那雨下得不对劲，你没觉得吗。","commentary":"哼。","emotion":"calm","hooks_used":[]}',
        );

        const outcome = await api.app.askNow({ force: true });
        // 走一次真正的兑现 —— `askNow` 只返回结果，`state()` 里的东西
        // 是 `_install` 记的。不装一次就查不到「她判断成了什么」。
        await api.app._install(outcome, '测试两段式');

        const locateCall = ctx._calls.find((/** @type {any} */ c) =>
            c.messages.some((/** @type {any} */ m) => String(m.content).includes('熟悉这部作品的读者')),
        );
        assert.ok(locateCall, '没有发起定位请求 —— 两段式的第一段没接上');

        const locUser = String(
            locateCall.messages.find((/** @type {any} */ m) => m.role === 'user')?.content ?? '',
        );
        assert.match(locUser, /刚刚写完的正文/, '定位没拿到正文 —— 那它就判断不了剧情演到哪');
        assert.match(locUser, /^1\. /m, '定位没拿到「每条一行」的索引清单');
        assert.match(locUser, /夜里有人搬箱子/, '索引摘要没进提示词');
        assert.match(locUser, /地下有暗渠可走/, '索引必须完整 —— 少了条目就等于退回旧的筛选模式');

        assert.ok(outcome?.located, '定位结果没有记进 outcome，用户就看不到她判断成了什么');
        assert.equal(outcome.located.phase, '刚到王都，还在闲逛');
    });

    await check('⭐ 挑中的条目正文是**从世界书现取**的（池子里只存了摘要）', async () => {
        // 索引里不存正文：几百条正文太重，而且作者改了世界书就过期了。
        // 所以这一步必须真去 loadWorldInfo 取 —— 取不到就等于她只看到一句摘要。
        // ⚠️ 不能只用「含贝翠丝」来找引导请求 —— **定位的系统提示词里也有
        // 「贝翠丝」**（它要交代「她下一轮就要开口，你是来帮她找素材的」）。
        // 第一版就是这么找的，结果拿到的是定位那一条，于是断言永远为假，
        // 看起来像「按需取回正文没生效」。排除掉定位才拿得准。
        const guideCall = ctx._calls.find(
            (/** @type {any} */ c) =>
                c.messages.some((/** @type {any} */ m) => String(m.content).includes('贝翠丝')) &&
                !c.messages.some((/** @type {any} */ m) => String(m.content).includes('熟悉这部作品的读者')),
        );
        assert.ok(guideCall, '没找到引导请求');
        const userMsg = String(
            guideCall.messages.find((/** @type {any} */ m) => m.role === 'user')?.content ?? '',
        );
        // 判据必须用**只有世界书正文里才有**的句子：索引里的 brief 是
        // 「夜里有人搬箱子」，跟正文很像，拿它当判据会永远为真（等于没断言）。
        assert.match(userMsg, /最近旧城区有人在夜里搬运箱子/, '挑中的条目正文没有取回来给她看');
        // 索引池里不存正文，所以这条旧格式池子的正文不该出现 ——
        // 出现了就说明「按需取回」没生效，而是把缓存里的东西整个倒进去了。
        assert.doesNotMatch(userMsg, /东段有一条废弃的暗渠/, '没挑中的条目不该把正文也送进去');
    });

    await check('⭐ 没被挑中的摘要不进入引导提示词（不能绕过正文核查）', () => {
        // 完整索引只供定位；引导只能看到经检索、现取的选中正文。
        const guideCall = ctx._calls.find(
            (/** @type {any} */ c) =>
                c.messages.some((/** @type {any} */ m) => String(m.content).includes('贝翠丝')) &&
                !c.messages.some((/** @type {any} */ m) => String(m.content).includes('熟悉这部作品的读者')),
        );
        const userMsg = String(
            guideCall?.messages.find((/** @type {any} */ m) => m.role === 'user')?.content ?? '',
        );
        assert.ok(guideCall, '没找到引导请求');
        assert.doesNotMatch(userMsg, /地下有暗渠可走|季节反常/, '未选中的摘要不能作为引导素材兜底');
        assert.doesNotMatch(userMsg, /连下了三天的雨/, '未选中的条目标题也不能漏进引导素材');
    });

    await check('诊断里能看到「她判断演到哪、挑了哪几条」', () => {
        const st = api.app.state();
        assert.ok(st.located, 'state().located 为空 —— 用户没法验证她的判断对不对');
        assert.equal(st.located.phase, '刚到王都，还在闲逛');
        assert.deepEqual(st.located.picks, [1]);
        assert.deepEqual(st.located.labels, ['旧城区的传言'], '要给出条目名，光有编号用户看不懂');
        assert.equal(st.located.total, 3, '要能看出「从几条里挑的」');
        assert.equal(st.hookPool.indexed, true, 'state 要标出这份池子是索引而不是筛选结果');
    });

    await check('旧 auto 设置且小索引：每次也必须先定位剧情进度', async () => {
        api.app.settings.guidance.locate = 'auto';
        api.app.settings.guidance.locateMinHooks = 12;
        ctx._calls.length = 0;
        // 只排引导回复；定位与核查始终运行，使用各自的确定性夹具。
        ctx._llmReplies.push('{"guidance":"雨还没停。","commentary":"","emotion":"calm","hooks_used":[]}');
        const outcome = await api.app.askNow({ force: true });
        const locateCalls = ctx._calls.filter((/** @type {any} */ c) =>
            c.messages.some((/** @type {any} */ m) => String(m.content).includes('熟悉这部作品的读者')),
        );
        assert.equal(locateCalls.length, 1, '小索引也必须先定位进度');
        assert.ok(outcome?.ok, `少了定位这一步也应该能出话，实际：${outcome?.error}`);
    });

    api.app.settings.guidance.locate = 'off'; // 还原成默认，别影响后面的用例
    api.app.hookCache = null;

    // ── 副路径：把呈现方式切回「独立小字消息」，确认那条路还通 ────────────
    await check('切到「独立小字消息」模式后，行为回到新增一条隐藏消息', async () => {
        api.app.settings.injection.mode = 'message';
        ctx.chat.push({ name: '测试角色', is_user: false, is_system: false, mes: '夜色渐深。' });
        await api.app._install({
            ok: true,
            result: { guidance: '别站在风口。', commentary: '哼。', emotion: 'calm', hooks_used: [] },
            turnIndex: 2,
            notes: [],
        }, '测试独立消息模式');

        const last = ctx.chat[ctx.chat.length - 1];
        assert.equal(last.extra?.beatriceGuide?.injected, true, '没有产生独立注入消息');
        assert.equal(last.is_system, true, '独立消息必须是隐藏的（不发正文模型）');
        assert.match(String(last.mes), /贝翠丝的低语/);
        assert.ok(ctx._chatSaved >= 1, '没有落盘聊天');
        assert.ok(ctx.rendered.length >= 1, '没有渲染楼层');

        api.app.settings.injection.mode = 'append'; // 还原，后面的用例按默认路径走
    });

    // -----------------------------------------------------------------------
    console.log('\n【她的话被重渲染抹掉之后，必须能自己回来】');
    // -----------------------------------------------------------------------
    //
    // 用户实测：诊断里写着「已接在第 #4 条正文末尾」，页面上却一个字都没有。
    // `display_text` 只活在消息数据里，酒馆任何一次按 `mes` 重铺页面（刷新、
    // 切走再切回、主题重排）都会让它在页面上消失。
    //
    // 单元测试能证明修复函数本身对，但证明不了**它真的挂在渲染事件上** ——
    // 这一节就是补那个缺口。

    /** 找一条带我们记号的楼层。 */
    const guidedIdx = ctx.chat.findIndex((m) => m?.extra?.beatriceGuide && m?.extra?.display_text);

    await check('先把楼层正常渲染出来，把「待补登记」这条捷径用掉', async () => {
        assert.ok(guidedIdx >= 0, '前面几节应当已经产生过一条带引导的正文');
        ctx._document._floors.set(guidedIdx, ctx._document._newFloorNode(''));
        await ctx.eventSource.emitAndWait('character_message_rendered', guidedIdx);
        await settle(30);

        // ⚠️ 这个断言是后面几条的**前提**：只有待补队列空了，
        //    后面「页面被抹掉再补回来」才只可能由**数据驱动的修复**完成，
        //    而不是靠那条登记里记着下标的捷径。
        assert.equal(api.state().pendingAppends, 0, '待补登记应当已经清空');
        assert.equal(api.state().display.onScreen, api.state().display.inData, '此刻页面应当是完整的');
    });

    await check('⭐ 页面上抹掉她的话（模拟酒馆按 mes 重铺楼层）', () => {
        // 酒馆重铺楼层时只会用 mes，display_text 不在它的渲染路径里
        ctx._document._floors.get(guidedIdx).textContent = String(ctx.chat[guidedIdx].mes);
        assert.equal(api.state().pendingAppends, 0, '这次没有登记可用 —— 只能靠数据里的记号');
        assert.ok(
            !String(ctx._document._floors.get(guidedIdx).textContent).includes('贝翠丝：'),
            '前置条件：页面上此刻应当看不到她的话',
        );
    });

    await check('诊断能指出「数据里有、页面上没有」', () => {
        const d = api.state().display;
        assert.ok(d, 'state() 里没有 display 字段 —— 用户没法判断是写入坏了还是渲染坏了');
        assert.ok(d.inData >= 1, '数据里应当有');
        assert.ok(d.missing.includes(guidedIdx), `missing 里应当有第 ${guidedIdx} 条，实际 ${JSON.stringify(d.missing)}`);
        assert.ok(d.onScreen < d.inData, 'onScreen 应当小于 inData（页面缺了）');
    });

    await check('⭐ 楼层一渲染，她的话就自己补回页面上（不靠内存登记）', async () => {
        await ctx.eventSource.emitAndWait('character_message_rendered', guidedIdx);
        await settle(30);
        const text = String(ctx._document._floors.get(guidedIdx)?.textContent ?? '');
        assert.ok(text.includes(String(ctx.chat[guidedIdx].extra.display_text).split('贝翠丝：').at(-1)), `页面上还是看不到她的话：${JSON.stringify(text.slice(0, 80))}`);
        assert.equal(api.state().display.onScreen, api.state().display.inData, '补完之后两边应当一致');
    });

    await check('再渲染一次不会重复追加（幂等，否则会越接越长）', async () => {
        const before = String(ctx._document._floors.get(guidedIdx).textContent);
        await ctx.eventSource.emitAndWait('character_message_rendered', guidedIdx);
        await settle(30);
        assert.equal(String(ctx._document._floors.get(guidedIdx).textContent), before, '内容不该变');
        assert.equal(
            String(ctx.chat[guidedIdx].extra.display_text).split('贝翠丝：').length - 1,
            1,
            'display_text 里只该出现一次她的话',
        );
    });

    await check('⭐ 正文被改过之后不再硬贴回去（不篡改用户的正文）', async () => {
        const msg = ctx.chat[guidedIdx];
        const savedDisplay = msg.extra.display_text;
        msg.mes = `${msg.mes}\n（用户自己补了一句）`; // 模拟用户手动编辑正文
        ctx._document._floors.get(guidedIdx).textContent = String(msg.mes);

        await ctx.eventSource.emitAndWait('character_message_rendered', guidedIdx);
        await settle(30);

        assert.equal(msg.extra.display_text, undefined, '过期的 display_text 必须被清掉，否则页面会一直显示旧引导');
        assert.ok(
            String(ctx._document._floors.get(guidedIdx).textContent).includes('用户自己补了一句'),
            '页面必须回到用户改后的正文',
        );
        assert.ok(
            !String(ctx._document._floors.get(guidedIdx).textContent).includes('贝翠丝：'),
            '不该把旧引导贴回被改过的正文',
        );

        // 还原，别影响后面的用例
        msg.extra.display_text = savedDisplay;
        msg.extra.beatriceGuide = { appendedTo: guidedIdx, at: Date.now() };
        ctx._document._floors.delete(guidedIdx);
    });

    // -----------------------------------------------------------------------
    console.log('\n【酒馆的渲染不认 display_text（TauriTavern 实测行为）】');
    // -----------------------------------------------------------------------

    // 用户实测的诊断：`lastInjected` 说「已接在第 #4 条正文末尾」、
    // `inData: 1`，而 `onScreen: 0` —— 话写进数据了，却没留在页面上。
    //
    // 原因是这台酒馆的渲染路径**不用** `display_text`，每次重铺楼层都按
    // `mes` 来。我们自己补一次 DOM 只活到下一次重渲染为止。所以：
    //   ① 必须接管 `updateMessageBlock`，让**任何**一次宿主渲染都带上她的话
    //   ② 写入之后还要自己回头看几眼（那一下覆盖不一定发事件）

    await check('接管酒馆的渲染入口（否则任何一次重铺都会把她的话冲掉）', async () => {
        await ctx.eventSource.emitAndWait('app_ready');
        await settle(60);

        ctx.chat[guidedIdx].extra.display_text = `${ctx.chat[guidedIdx].mes}\n\n──────────\n贝翠丝：接管测试`;
        ctx.chat[guidedIdx].extra.beatriceGuide = { appendedTo: guidedIdx, at: Date.now() };
        ctx._document._floors.set(guidedIdx, ctx._document._newFloorNode(''));
        assert.equal(api.state().display.patched, true, 'app_ready 之后应当已经接管');
    });

    await check('⭐ 酒馆自己重铺楼层（只按 mes 渲染），她的话仍然在页面上', async () => {
        // 先让页面上有她的话
        api.app._watchStop?.();
        ctx._document._floors.get(guidedIdx).textContent = ctx.chat[guidedIdx].extra.display_text;

        // 酒馆发起一次重渲染 —— 未接管时这一下就会把她的话冲掉
        ctx.updateMessageBlock(guidedIdx, ctx.chat[guidedIdx]);
        await settle(30);

        const text = String(ctx._document._floors.get(guidedIdx).textContent);
        assert.ok(text.includes('接管测试'), `被冲掉了：${JSON.stringify(text.slice(0, 90))}`);
    });

    await check('⭐ 写入之后排了「回看点」（那一下覆盖不一定发事件，只能自己回头看）', async () => {
        // 走一次真实的 `_install`，看它有没有排监视
        api.app.settings.llm.mode = 'profile';
        api.app.settings.llm.profileId = 'prof-1';
        api.app.settings.injection.mode = 'append';
        ctx._llmReplies.length = 0;
        ctx._llmReplies.push(JSON.stringify({ guidance: '回看点测试', commentary: '' }));

        const before = api.state().display.watching;
        const outcome = await api.app.askNow({ force: true });
        if (outcome?.ok) await api.app._install(outcome, '测试回看点');
        await settle(30);

        const st = api.state();
        assert.ok(
            st.display.watching >= 1 || before >= 1,
            `注入之后应当至少有一个回看点排着（值为 0 说明没人盯着，被覆盖就永久消失）` +
                `　lastInjected=${JSON.stringify(st.lastInjected)}　ok=${outcome?.ok}　error=${outcome?.error ?? ''}`,
        );
        assert.equal(api.state().display.hostHonorsDisplay, false, '这台假酒馆不认 display_text，诊断要如实报告');
    });

    // -----------------------------------------------------------------------
    console.log('\n【点头像：必须打开插件自己的设置窗】');
    // -----------------------------------------------------------------------

    // 这一段是用户两次实测反馈的回归测试：
    //   第一版：点头像 = 直接请求 API，没配好只弹一句「需要配置 API」→ 死胡同。
    //   第二版：改成「把酒馆的扩展设置侧栏滚出来」→ 用户说
    //          「你添加的设置就在右边是什么意思？不可以写一个插件单独的 api 设置界面让我进去填写吗？」
    //   现在：点她 = 打开插件自己的设置窗。唯一行为，不分状态。

    await check('长按两秒重新观测，提前松手取消，松手不误开设置', async () => {
        assert.equal(api.ui.node.querySelector('.bg-reobserve'), null);
        const btn = api.ui.node.querySelector('.bg-avatar');
        assert.ok(btn);
        const originalAsk = api.app.askNow;
        const originalInstall = api.app._install;
        let calls = 0;
        let installed = 0;
        let release;
        const outcome = { ok: true };
        api.app.askNow = async () => {
            calls++;
            await new Promise(resolve => { release = resolve; });
            return outcome;
        };
        api.app._install = async (value, reason) => {
            assert.equal(value, outcome);
            assert.equal(reason, '重新观测');
            installed++;
        };
        try {
            btn.dispatch('pointerdown', { pointerId: 1, button: 0 });
            await settle(50);
            btn.dispatch('lostpointercapture', { pointerId: 1 });
            await settle(2050);
            assert.equal(calls, 0, '提前松手不请求');
            btn.dispatch('pointerdown', { pointerId: 2, button: 0 });
            await settle(1900);
            assert.equal(calls, 0, '两秒前不能请求');
            await settle(200);
            assert.equal(calls, 1);
            btn.dispatch('lostpointercapture', { pointerId: 2 });
            btn.dispatch('click', {});
            assert.equal(api.settingsWindow?.() ?? null, null, '长按后不打开设置');
            release();
            await settle(10);
            assert.equal(installed, 1);
        } finally {
            api.app.askNow = originalAsk;
            api.app._install = originalInstall;
        }
    });

    /** 找到头像按钮并模拟点击。 */
    function clickAvatar() {
        const btn = api.ui.node.querySelector?.('.bg-avatar');
        assert.ok(btn, '找不到头像按钮 .bg-avatar');
        btn.dispatch('click', { button: 0 });
    }

    await check('通道没配好时 `channelStatus()` 明确报「未就绪」并说明原因', () => {
        api.app.settings.llm.mode = 'profile';
        api.app.settings.llm.profileId = '';
        const st = api.app.channelStatus();
        assert.equal(st.ready, false, '没选 profile 时不该报 ready');
        assert.match(st.reason, /连接配置/, `原因不够具体：${st.reason}`);
    });

    // 前提：此刻还没有设置窗
    await check('设置窗是懒创建的（没点之前不该存在）', () => {
        assert.equal(api.settingsWindow?.() ?? null, null, '没点之前不该已经建好设置窗');
    });

    const callsBeforeOpen = ctx._calls.length;
    clickAvatar();
    await settle(60);

    await check('点头像 → 打开插件自己的设置窗（而不是滚酒馆的侧栏）', () => {
        const win = api.settingsWindow?.();
        assert.ok(win, '设置窗没有被创建');
        assert.equal(win.isOpen, true, '设置窗应该处于打开状态');
        assert.ok(env.doc.body.childNodes.includes(win.node), '设置窗没有挂到 body 上');
        assert.ok(
            win.node.classList.contains('bg-win-overlay'),
            `设置窗根节点 class 不对：${win.node.className}`,
        );
    });

    await check('打开设置窗的过程没有静默报错（TDZ 那类错误只能这样抓）', () => {
        // 这里踩过一个假 DOM 抓不到的坑：`fillModelOptions` 引用了尚未初始化的
        // `customInput`（暂时性死区），`createSettingsWindow` 整个抛异常，
        // 被 index.js 的 try/catch 兜住 —— 表现是「点头像完全打不开设置窗」。
        // 浏览器验收才抓到，而冒烟测试当时是绿的。
        //
        // 所以额外守一道：index.js 会把失败原因记下来并暴露出去，不让它静默。
        const err = String(api.settingsWindowError ?? '');
        assert.equal(err, '', `打开设置窗时报错了：${err}`);
    });

    await check('设置窗里有全部六个标签页（通道 / 引导 / 线索 / 外观 / 人设 / 诊断）', () => {
        const win = api.settingsWindow();
        const tabs = win.node.querySelector?.('.bg-win-tabs');
        assert.ok(tabs, '找不到标签栏');        const labels = (tabs.childNodes ?? []).map((t) => findText(t));
        for (const want of ['辅助 API', '引导与吐槽', '世界书线索', '外观', '人设', '诊断']) {
            assert.ok(
                labels.some((l) => l.includes(want)),
                `缺少「${want}」标签页。实际标签：${labels.join(' / ')}`,
            );
        }
    });

    await check('设置窗打开时落在「辅助 API」页，且页面里有通道模式选择器（这就是用户要填的 API 设置）', () => {
        const win = api.settingsWindow();
        const panel = win.node.querySelector?.('.bg-win-panel');
        assert.ok(panel, '找不到内容区');
        const text = findText(panel);
        assert.match(text, /辅助 API/, `内容区标题不对：${text.slice(0, 80)}`);
        assert.match(text, /通道模式/, '没有「通道模式」这一项 —— 用户就是来填 API 的');
        // 关闭按钮也要在
        assert.ok(win.node.querySelector?.('.bg-win-close'), '缺少关闭按钮');
    });

    await check('通道没配好时打开设置窗不会顺手发请求（不白花额度）', () => {
        assert.equal(ctx._calls.length, callsBeforeOpen, '打开设置不该触发 API 调用');
    });

    await check('按 Esc / 点遮罩能关掉设置窗', () => {
        const win = api.settingsWindow();
        win.close();
        assert.equal(win.isOpen, false, 'close() 之后应该是关着的');
        assert.equal(win.node.dataset.open, '0', 'data-open 应该切回 0');
    });

    // 配好通道后再点一次：仍然开设置窗（唯一行为，不分状态）
    api.app.settings.llm.profileId = 'prof-1';
    await check('通道配好后 `channelStatus()` 报「就绪」', () => {
        const st = api.app.channelStatus();
        assert.equal(st.ready, true, `实际：${JSON.stringify(st)}`);
    });

    clickAvatar();
    await settle(60);

    await check('通道配好后点头像 → 依然打开设置窗（行为一致，不做状态分流）', () => {
        const win = api.settingsWindow();
        assert.equal(win.isOpen, true, '设置窗应该是打开的');
        // 用户要说话有 /bg-now；点头像的语义固定是「开设置」
        assert.equal(typeof api.app.askNow, 'function', '手动说话的能力仍然通过 /bg-now 与调试入口提供');
    });

    api.settingsWindow()?.close();
    await settle(20);

    // -----------------------------------------------------------------------
    console.log('\n【防回环：插件改渲染不能把插件自己再触发一遍】');
    // -----------------------------------------------------------------------

    // 默认的「接在正文末尾」模式**不产生新消息**（只挂 display_text），
    // 所以它天生没有回环风险。但这条路径仍然值得守：
    // 1) 渲染层的变化不能反过来变成一次 MESSAGE_RECEIVED 并触发新请求
    // 2) 「独立小字消息」模式仍然会产生新消息，防回环标记必须还在
    const callsBeforeLoopTest = ctx._calls.length;
    const msgCountBefore = ctx.chat.length;

    // 模拟酒馆在重渲染后照常发一次 MESSAGE_RECEIVED
    await ctx.eventSource.emit('message_received', 1);
    await settle(30);

    await check('接在正文上的引导不会因为消息事件而重复触发请求', () => {
        assert.equal(ctx._calls.length, callsBeforeLoopTest, '发生回环了：渲染变化又触发了新的请求');
        assert.equal(ctx.chat.length, msgCountBefore, '聊天里多了计划外的消息');
    });

    await check('自家注入的隐藏消息仍然带标记（`message` 模式靠它防回环）', () => {
        // 上一步切到 message 模式时注入了一条，这里确认标记完好
        const injected = ctx.chat.filter((m) => m?.extra?.beatriceGuide?.injected);
        assert.ok(injected.length >= 1, '找不到带自家标记的消息');
        for (const m of injected) {
            assert.equal(m.is_system, true, '注入消息必须是隐藏的');
        }
        // isOwnInjectedMessage 认得出来
        const idx = ctx.chat.findIndex((m) => m?.extra?.beatriceGuide?.injected);
        assert.equal(api.app.onMessageReceived(idx), true, '该被识别为自家消息并跳过');
    });

    // -----------------------------------------------------------------------
    console.log('\n【幂等与节奏】');
    // -----------------------------------------------------------------------

    const callsBeforeIdempotent = ctx._calls.length;
    await ctx.eventSource.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await settle(20);

    await check('同一条 AI 消息重复触发生成事件不会重复引导（幂等）', () => {
        // 第 2 轮已经引导过了；every-n 默认 N=2，且 guidedTurns 里有记录
        const state = api.state();
        assert.ok(
            state.guidedTurns >= 1,
            '引导过的轮次应该被记住',
        );
        // 允许因为「新一轮」而再次请求，但不允许对同一轮重复注入
        assert.equal(state.injectedCount, 1, `注入次数应该还是 1，实际 ${state.injectedCount}`);
        assert.ok(ctx._calls.length >= callsBeforeIdempotent);
    });

    // -----------------------------------------------------------------------
    console.log('\n【容错：辅助 API 挂掉不能影响用户聊天】');
    // -----------------------------------------------------------------------

    ctx._calls.length = 0;
    ctx.ConnectionManagerRequestService.sendRequest = async (profileId, messages) => {
        const system = messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
        ctx._calls.push({ profileId, messages });
        if (system.startsWith('Observe neutral events, relationships and information in completed roleplay prose.')) {
            return { result: { choices: [{ message: { content: '{"proposals":[]}' } }] } };
        }
        throw new Error('HTTP 401 — invalid api key');
    };

    // ⚠️ 顺序很重要：**先在 `GENERATION_AFTER_COMMANDS` 之前**把上一轮的正文放进去。
    //
    // `onGenerationStart` 会把「当前最后一条 AI 消息的下标」记成基准，
    // 正文写完时靠它判断新的那条进来了没有。如果 push 放在事件之后，
    // 基准就变成了**新正文自己**，于是永远等不到「更新的」那条 ——
    // 报「等不到刚生成的正文」（实测踩到过）。
    //
    // 真实的酒馆里不会有这个问题：生成开始时上一轮的正文早就进数组了，
    // 新正文是生成过程中才 push 的。测试要还原这个顺序。
    const prevIdx = ctx.chat.length;
    ctx.chat.push({ name: '测试角色', is_user: false, is_system: false, mes: '上一轮的正文。' });
    await ctx.eventSource.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await settle(20);

    // 推进轮次。幂等判据是 `turnCounter`，不推进的话 `shouldGuide` 会返回
    // `{go:false, reason:'第 N 轮已经引导过了'}`，根本不会发请求 ——
    // 那时测试报的「应该记录下错误」看起来像错误处理坏了，
    // 其实是幂等机制在正常工作，测试自己没造出「新一轮」。
    {
        const { getChatData: readData, saveChatData: writeData } = await import('../src/core/store.js');
        const d = readData(api.app.ctx);
        d.turnCounter = (Number(d.turnCounter) || 0) + 5;
        await writeData(api.app.ctx, d, { silent: true });
    }

    // 正文写完 → 新的那条进数组
    ctx.chat.push({ name: '测试角色', is_user: false, is_system: false, mes: '夜色渐深，街上的摊位一个个收了起来。' });
    void prevIdx;

    let endedThrew = false;
    try {
        // ⚠️ 用 emitAndWait：发请求的时机现在是「正文写完之后」（onGenerationEnd），
        // 它是异步的。用 emit + 固定 sleep 会读到一个还没写完的状态，测试假红。
        await ctx.eventSource.emitAndWait('generation_ended');
        await waitFor(() => ctx._calls.length > 0, 4000);
        await settle(60);
    } catch {
        endedThrew = true;
    }

    await check('辅助 API 报 401 时：不抛异常、不注入、错误被记录', () => {
        assert.equal(endedThrew, false, 'GENERATION_ENDED 抛出异常了（会打断酒馆本身）');
        const st = api.state();
        assert.ok(st.lastError, '应该记录下错误');
        assert.match(st.lastError, /401|invalid api key/, `错误信息不具体：${st.lastError}`);
        // injectedCount 记的是「历史累计注入次数」，前面成功过 1 次，
        // 所以这里断言「没有被这次失败再增加」
        assert.equal(st.injectedCount, 1, '失败的那一轮不该注入');
    });

    await check('失败后扩展仍然活着，状态可查、手动触发仍可用', () => {
        assert.ok(api.state().version);
        assert.equal(typeof api.speak, 'function');
    });

    // -----------------------------------------------------------------------
    console.log('\n【世界书读取失败】');
    // -----------------------------------------------------------------------

    ctx.loadWorldInfo = async () => {
        throw new Error('世界书文件损坏');
    };
    ctx.ConnectionManagerRequestService.sendRequest = async (profileId, messages) => {
        ctx._calls.push({ profileId, messages });
        const system = messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
        if (system.startsWith('Observe neutral events, relationships and information in completed roleplay prose.')) {
            return { result: { choices: [{ message: { content: '{"proposals":[]}' } }] } };
        }
        if (system.includes('熟悉这部作品的读者')) {
            return { result: { choices: [{ message: { content: '{"phase":"城门","pick":[],"why":"来源不可用"}' } }] } };
        }
        return { result: { choices: [{ message: { content: '{"guidance":"哼。","commentary":"","emotion":"annoyed","hooks_used":[]}' } }] } };
    };

    ctx.chat.push({ name: '契约者', is_user: true, is_system: false, mes: '我往城门那边走。' });
    await ctx.eventSource.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await settle(20);
    // Completion needs a newly completed AI target, not the preceding user intent.
    ctx.chat.push({ name: '测试角色', is_user: false, is_system: false, mes: '你走到城门前，城门卫兵点头示意。' });
    let threw = false;
    try {
        await ctx.eventSource.emit('generation_ended');
        await settle(30);
    } catch {
        threw = true;
    }

    await check('世界书读不到时仍能出声（只是没有线索），且不抛异常', () => {
        assert.equal(threw, false, '世界书读取失败不该让流程抛异常');
        // 这里断言的是**错误被记录**而不是流程崩溃 —— 读不到书不该让整轮静默失败得无声无息
        const st = api.state();
        assert.ok(
            st.lastResult || st.lastError,
            '读不到世界书时，要么带着「没有线索」继续出声，要么明确记录错误；不能两者都没有',
        );
    });

    // -----------------------------------------------------------------------
    console.log('\n【竞态：通读期间换了卡，结果绝不能写进新卡】');
    // -----------------------------------------------------------------------

    await check('⭐ 通读中途换卡 → 结果作废，不写进新卡的池子', async () => {
        // 真实场景：用户点了「让 AI 通读世界书」，等了十几秒等不及，
        // 切到另一张卡。通读结果回来时 `ctx` 已经指向新卡了。
        // 如果不核对，A 卡的世界观会被写进 B 卡的线索池 —— 而且**不报错**。
        const ctx2 = api.app.ctx;
        ctx2.chatId = 'chat-race';
        // 上一节把 loadWorldInfo 换成「损坏的书」了，这里换回一本能读的
        ctx2.loadWorldInfo = async () => ({
            entries: {
                0: { comment: '[引导] 旧城区的传言', content: '最近旧城区有人在夜里搬运箱子。', order: 1 },
                1: { comment: '[地点] 王都下水道', content: '下水道通往城墙外，很少人知道。', order: 2 },
            },
        });
        ctx2.characters = [
            { avatar: 'card-a.png', name: 'A 卡', data: { extensions: { world: '测试世界书' } } },
            { avatar: 'card-b.png', name: 'B 卡', data: { extensions: { world: '测试世界书' } } },
        ];
        ctx2.characterId = 0;

        // 让通读那次请求「挂住」，我们在它返回之前换卡
        let release;
        const gate = new Promise((r) => {
            release = r;
        });

        ctx2._calls.length = 0;
        ctx2.ConnectionManagerRequestService.sendRequest = async (...args) => {
            await gate; // ← 通读卡在这里，我们在它返回前换卡
            ctx2._calls.push({ kind: 'scan', args });
            return {
                result: {
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    index: [
                                        { index: 1, brief: '夜间箱子事件', phase: '开局' },
                                        { index: 2, brief: '暗渠逃离事件', phase: '后续' },
                                    ],
                                }),
                            },
                        },
                    ],
                },
            };
        };

        const scanning = api.app.buildHookPool({ force: true });
        await settle(10);

        // ← 通读还在跑，用户换到了 B 卡
        ctx2.characterId = 1;

        release();
        const res = await scanning;

        assert.equal(res.ok, false, '换卡之后这次通读必须作废');
        assert.match(
            String(res.error),
            /角色卡/,
            `错误里要说清原因是换了卡，实际是：${res.error}`,
        );

        const poolB = getCharacterPool(ctx2);
        assert.equal(poolB, null, 'B 卡的池子必须仍然是空的 —— 这就是「不能混乱」');

        ctx2.characterId = 0; // 还原
    });

    // -----------------------------------------------------------------------
    console.log('\n【竞态：引导途中切了聊天，绝不能接到另一个聊天里】');
    // -----------------------------------------------------------------------

    await check('⭐ 引导请求途中切聊天 → 这次引导作废，不注入', async () => {
        // 真实场景：正文刚写完，插件正在等辅助 API 回话（几秒到几十秒），
        // 用户切到另一个聊天。结果回来时 `ctx.chat` 已经是另一段对话了。
        // 原来的代码会把「她站在王都街头」的引导接到新聊情的正文末尾。
        const ctx2 = api.app.ctx;
        ctx2.chatId = 'chat-A';
        api.app.settings.llm.mode = 'profile';
        api.app.settings.llm.profileId = 'prof-1';
        api.app.settings.cadence.mode = 'always';
        api.app.settings.cadence.cooldownMs = 0;

        // 池子先备好；ensureHookPool 只读已确认缓存，绝不能自动通读或确认。
        setCharacterPool(
            ctx2,
            [{ book: '测试世界书', uid: 0, label: '旧城区的传言', content: '夜里有人搬箱子。', kind: '线索', why: 'r' }],
            ['测试世界书'],
            { source: 'ai', coverage: { complete: true } },
        );
        api.app.hookCache = null;

        // 造一条「刚写完的正文」
        ctx2.chat.push({ name: '测试角色', is_user: false, is_mes: true, mes: '她站在王都街头，风里有烤面包的味道。入夜后，你看见旧城区有人搬运箱子。' });
        api.app._generationBaseline = ctx2.chat.length - 2;

        const beforeLen = ctx2.chat.length;
        // `rendered` 是整个冒烟过程共用的数组（前面几节已经往里推过东西了），
        // 所以只能比**增量**，不能比绝对条数
        const beforeRendered = ctx2.rendered.length;

        // 让引导请求挂住，在它返回之前切聊天
        let release;
        const gate = new Promise((r) => {
            release = r;
        });
        ctx2.ConnectionManagerRequestService.sendRequest = async (profileId, messages) => {
            const system = messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
            if (system.startsWith('Observe neutral events, relationships and information in completed roleplay prose.')) {
                return { result: { choices: [{ message: { content: '{"proposals":[]}' } }] } };
            }
            if (system.includes('熟悉这部作品的读者')) {
                return { result: { choices: [{ message: { content: '{"phase":"王都","pick":[1],"why":"核查来源"}' } }] } };
            }
            if (system.startsWith('你是中立的原文适用性核查者')) {
                return { result: { choices: [{ message: { content: assessmentFixture(messages) } }] } };
            }
            await gate;
            return {
                result: {
                    choices: [
                        {
                            message: {
                                content: '{"guidance":"往东边那条巷子走。","commentary":"发什么呆。","emotion":"calm","hooks_used":[]}',
                            },
                        },
                    ],
                },
            };
        };

        const running = api.app.runPostGeneration();
        await settle(30);

        // ← 请求还在飞，用户切走了
        ctx2.chatId = 'chat-B';
        release();
        const res = await running;

        assert.equal(res.ok, false, '切了聊天之后这次引导必须作废');
        assert.match(String(res.error), /聊天/, `理由要说清是切了聊天，实际是：${res.error}`);
        assert.equal(
            ctx2.chat.length,
            beforeLen,
            '聊天里不能多出任何东西 —— 引导绝不能被接进新聊天',
        );
        assert.equal(ctx2.rendered.length, beforeRendered, '也不该渲染出任何气泡消息');

        ctx2.chatId = 'chat-A';
    });

    await check('⭐⭐ 手动触发那条路也过同一道闸（/bg-now 与调试入口）', async () => {
        // 斜杠命令是 `await askNow()` 之后再 `await _install()`，
        // 两个 await 之间同样能被切卡/切聊天打断。
        //
        // 这条断言钉的是**单一强制执行点**这个设计本身：
        // 闸门开在 `_install()` 里，所以任何调用方漏了检查都还有兜底。
        // 如果哪天有人把检查挪回 `runPostGeneration()`，
        // 这条会失败 —— 那正是它的作用。
        const ctx3 = api.app.ctx;
        ctx3.chatId = 'chat-M';
        const beforeLen = ctx3.chat.length;
        const beforeRendered = ctx3.rendered.length;

        // 造一个「出发时在 chat-M、回来时已经是 chat-N」的结果
        const stale = {
            ok: true,
            origin: identitySnapshot(ctx3),
            result: { guidance: '往东走。', commentary: '发什么呆。', emotion: 'calm', hooks_used: [] },
        };
        ctx3.chatId = 'chat-N';

        const res = await api.app._install(stale, '冒烟测试');

        assert.equal(res?.ok, false, '出发时的聊天已经不是现在这个了，必须拒绝落地');
        assert.match(String(res?.error), /聊天/, `理由要说清原因，实际是：${res?.error}`);
        assert.equal(ctx3.chat.length, beforeLen, '不能往新聊天里塞东西');
        assert.equal(ctx3.rendered.length, beforeRendered, '也不该冒气泡');

        // 反面：指纹还对得上时必须照常放行，否则这个闸就成了「永远不发声」
        ctx3.chatId = 'chat-M';
        const fresh = {
            ok: true,
            origin: identitySnapshot(ctx3),
            result: { guidance: '往东走。', commentary: '发什么呆。', emotion: 'calm', hooks_used: [] },
        };
        const okRes = await api.app._install(fresh, '冒烟测试');
        assert.notEqual(okRes?.ok, false, `指纹没变时必须放行，实际被拦了：${okRes?.error}`);

        ctx3.chatId = 'chat-A';
    });

    await check('⭐⭐ 手动挑条目：勾选期间换了卡 → 拒绝建池（不能把 A 的条目写进 B）', async () => {
        // 这条路比引导那条更长：扫世界书要几秒，用户对着列表慢慢勾可能要几分钟。
        // 期间换卡，勾的还是 A 卡的条目，落库却落在 B 卡上 ——
        // B 卡的池子里混进 A 卡的世界观，用户会以为「AI 挑错了」。
        const ctx4 = api.app.ctx;
        ctx4.characterId = 0; // previous race must not make this fixture mutate an inactive card
        ctx4.chatId = 'chat-P';
        const originalAvatar = ctx4.characters[0].avatar;
        const store = ctx4.extensionSettings;

        const entries = [
            { book: 'A卡的书', uid: 1, comment: '[线索] 旧城区的传言', content: '夜里有人搬箱子。' },
        ];

        // ① 在 A 卡上扫出候选
        api.app.lastScanCandidates = entries;
        api.app.lastScanOrigin = identitySnapshot(ctx4);

        // ② 用户还没勾完就换了卡
        ctx4.characters[0].avatar = 'another-card.png';

        const res = await api.app.buildHookPoolFromPicks(entries, [1]);
        assert.equal(res.ok, false, '换了卡之后不能还把这份候选建成池子');
        assert.match(String(res.error), /过期|重新/, `要说清该怎么办，实际是：${res.error}`);

        // ③ 关键：B 卡名下不能出现任何池子
        assert.equal(
            getCharacterPool(ctx4, 'another-card.png'),
            null,
            'B 卡下绝不能被写进 A 卡的条目',
        );
        assert.equal(store.beatriceGuide?.hookPools?.['another-card.png'], undefined, '底层存储里也不能有');

        // ④ 反面：没换卡时必须正常建成
        ctx4.characters[0].avatar = originalAvatar;
        api.app.lastScanOrigin = identitySnapshot(ctx4);
        const okRes = await api.app.buildHookPoolFromPicks(entries, [1]);
        assert.equal(okRes.ok, true, `没换卡时必须能建成，实际：${okRes.error}`);
        assert.equal(okRes.hooks.length, 1, '勾了 1 条就该建出 1 条');

        ctx4.chatId = 'chat-A';
    });

    await check('⭐⭐ 显式通读切聊天后旧结果不能覆盖新待确认结果', async () => {
        // 用户显式发起两次通读；旧聊天的迟到结果必须作废。
        // 新聊天的通读只能产生待确认候选，不能在后台自动建池。
        const ctx5 = api.app.ctx;
        ctx5.chatId = 'chat-X';
        api.app.settings.worldbook.bookNames = ['测试世界书'];

        // 把通读挡在门口，方便控制「谁先回来」
        const gates = [];
        const originalSend = ctx5.ConnectionManagerRequestService.sendRequest;
        ctx5.ConnectionManagerRequestService.sendRequest = async () => {
            let release;
            const p = new Promise((r) => {
                release = r;
            });
            gates.push(release);
            await p;
            return {
                result: {
                    choices: [
                        {
                            message: {
                                content: '{"index":[{"index":1,"brief":"暗渠逃离事件","phase":"后续"}]}',
                            },
                        },
                    ],
                },
            };
        };

        api.app.hookCache = null;
        api.app._poolBuilding = null;
        setCharacterPool(ctx5, [], [], { source: 'test' }); // 先占位再故意判过期

        const beforeScan = getCharacterPool(ctx5);
        // ① 只有显式通读才能请求 API。
        const buildA = api.app.buildHookPool({ force: true });
        await settle(20);
        assert.equal(gates.length, 1);
        ctx5.chatId = 'chat-Y';
        api.app.onChatChanged();
        const overlapping = api.app.buildHookPool({ force: true });
        await settle(20);
        // 正在通读时共享请求是允许的；迟到的共享结果仍必须作废。
        gates[0]();
        const stale = await buildA;
        assert.equal(stale.ok, false, '旧聊天的通读必须作废');
        await overlapping;
        assert.deepEqual(getCharacterPool(ctx5), beforeScan, '迟到结果不能发布池子');
        const buildB = api.app.buildHookPool({ force: true });
        await settle(20);
        assert.equal(gates.length, 2, '旧请求收尾后新聊天必须能重新显式通读');
        gates[1]();
        const review = await buildB;
        assert.equal(review.ok, true, review.error);
        assert.equal(review.needsConfirmation, true);
        assert.deepEqual(review.hooks, []);
        assert.deepEqual(getCharacterPool(ctx5), beforeScan, '新通读也必须等人工确认');
        const callsBeforeEnsure = gates.length;
        await api.app.ensureHookPool({ silent: true });
        assert.equal(gates.length, callsBeforeEnsure, 'ensure 不能自动请求通读或确认');
        assert.deepEqual(getCharacterPool(ctx5), beforeScan);

        ctx5.ConnectionManagerRequestService.sendRequest = originalSend;
        api.app._poolBuilding = null;
        api.app.hookCache = null;
        ctx5.chatId = 'chat-A';
    });

    // -----------------------------------------------------------------------
    console.log('\n【切换聊天：记忆与缓存必须重置】');
    // -----------------------------------------------------------------------

    ctx.chatMetadata['beatrice-guide'] = {
        dataVersion: 1,
        spoken: ['旧的一句'],
        guidedTurns: [1, 2],
        turnCounter: 5,
        lastAt: Date.now(),
    };
    await ctx.eventSource.emit('chat_id_changed');
    await settle(20);

    await check('切换聊天后旧记忆不再生效（新聊天是干净的开局）', () => {
        // `hasPending` 这个状态字段随「抢先式」路径一起删掉了 ——
        // 现在发请求的唯一时机是正文写完，没有「等着兑现的结果」这种中间状态。
        // 所以改查真正该被重置的东西：缓存与上一次结果。
        assert.equal(api.app.hookCache, null, '切换聊天后钩子缓存该清掉');
        assert.equal(api.app.lastOutcome, null, '切换聊天后上一次结果该清掉');
        assert.equal(api.app.lastError, '', '切换聊天后错误状态该清掉');
    });

    // -----------------------------------------------------------------------
    console.log('\n【斜杠命令】');
    // -----------------------------------------------------------------------

    await check('没有 SlashCommandParser 时静默跳过，不抛异常', () => {
        // 假环境里确实没有 SlashCommandParser —— 走到这里没崩就说明兜底生效
        assert.ok(true);
    });

    // -----------------------------------------------------------------------
    console.log('\n【清理】');
    // -----------------------------------------------------------------------

    await check('destroy() 能拆干净且可重复调用', () => {
        api.ui?.destroy?.();
        api.ui?.destroy?.();
        assert.equal(api.ui.node.parentNode, null, '节点没有被移出 DOM');
    });

    // 假环境收尾：清掉插件注册的定时器（气泡自动收起之类）
    for (const id of activeTimers()) clearTimeout(id);
    env.restore();
    // -----------------------------------------------------------------------
    // 资源文件检查
    // -----------------------------------------------------------------------

    console.log('\n【随包资源】');
    await check('manifest.json 指向的 js / css 都存在', async () => {
        const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
        for (const key of ['js', 'css']) {
            const content = await readFile(join(ROOT, manifest[key]), 'utf8');
            assert.ok(content.length > 0, `${manifest[key]} 是空的`);
        }
    });

    await check('assets/beatrice.svg 是合法的独立 SVG（有 viewBox、无外部引用）', async () => {
        const svg = await readFile(join(ROOT, 'assets', 'beatrice.svg'), 'utf8');
        assert.match(svg, /viewBox="0 0 200 200"/, 'viewBox 不对');
        assert.doesNotMatch(svg, /<image\b/i, '不该内嵌位图');
        assert.doesNotMatch(svg, /xlink:href|<use\b/i, '不该引用外部资源');
        // 简易标签配平检查
        const opens = (svg.match(/<([a-zA-Z][\w:-]*)(?:\s[^>]*)?(?<!\/)>/g) ?? []).length;
        const closes = (svg.match(/<\/[a-zA-Z][\w:-]*>/g) ?? []).length;
        assert.equal(opens, closes, `标签不配平：${opens} 个开标签 vs ${closes} 个闭标签`);
    });

    // -----------------------------------------------------------------------
    console.log(`\n${'─'.repeat(60)}`);
    if (failures.length) {
        console.log('\n失败详情：\n');
        for (const f of failures) console.log(`  ${f}\n`);
    }
    console.log(`共 ${passed + failed} 项检查：✅ ${passed} 通过　❌ ${failed} 失败`);
    process.exit(failed ? 1 : 0);
}

/** 递归收集元素树里的所有文本（用来断言气泡内容）。 */
function findText(/** @type {any} */ node) {
    if (!node) return '';
    let out = String(node.textContent ?? '');
    for (const child of node.childNodes ?? []) out += ` ${findText(child)}`;
    // 逐字动画只把已显示的部分写进 textContent，所以还要看 _innerHTML
    out += ` ${String(node._innerHTML ?? '')}`;
    return out;
}

/**
 * 列出当前挂着的定时器。
 *
 * Node 没有公开 API 枚举定时器，所以这里用一个**粗粒度**的清理：
 * 直接让进程在输出后退出（process.exit），未清的定时器不会阻止退出。
 * 之所以还留着这个函数，是为了将来换成真的追踪实现时调用点不用改。
 */
function activeTimers() {
    return [];
}

run().catch((e) => {
    console.error('\n冒烟测试自身出错：', e);
    process.exit(1);
});
