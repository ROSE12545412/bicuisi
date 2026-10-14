/**
 * 碧翠丝的禁书库 / src/ui/floating.js
 * ---------------------------------------------------------------------------
 * 悬浮窗组件：一个可以拖动、会说话、有情绪的 Q 版贝翠丝。
 *
 * ## 设计取舍（都踩过坑，写下来免得后来者改回去）
 *
 * 1. **不用 innerHTML 拼文本。**
 *    气泡里显示的是**模型输出**。模型可能复述玩家的输入，玩家可能打 `<img onerror=...>`。
 *    一旦拼 HTML 就是自带的 XSS 后门。这里一律 `textContent` / `createTextNode`，
 *    唯一的 `innerHTML` 用在**自家写死的 SVG 常量**上（见 `inlineSvg`）。
 *
 * 2. **内置 SVG 走「字符串 → innerHTML → 取 firstElementChild」而不是手搓
 *    `createElementNS` 树。**
 *    SVG 的命名空间很挑：用 `document.createElement('circle')` 造出来的元素
 *    挂在浏览器里**什么都不显示**（这是最常见的「SVG 画不出来」原因）。
 *    `innerHTML` 由 HTML 解析器负责命名空间映射，反而更可靠、代码也短得多。
 *    造完就 `importNode` 进当前 document，避免跨文档节点（adopt 语义更稳）。
 *
 * 3. **位置存左上角坐标 + 每次 resize 重新钳制。**
 *    契约里 `ui.avatarPos` 就是 `{x, y}`。相比「相对右下角的偏移」，
 *    左上角坐标在保存时更直观；代价是窗口变小后头像可能落在屏幕外，
 *    所以 `applyPosition()` 必须在 resize 时把坐标拉回可视区 —— 这是姊妹项目
 *    实测踩过的坑（缩小窗口后悬浮球找不回来，用户以为插件坏了）。
 *
 * 4. **气泡朝向交给 CSS。**
 *    JS 只写 `data-side="left|right"`，三角尾巴、贴边距离全在 style.css 里。
 *    用 JS 算绝对坐标的话，头像一缩放/一拖动就要跟着重算，必然出现错位帧。
 *
 * 5. **打字机与自动收起是两套计时。**
 *    自动收起的计时**从打字结束才开始**（否则长文本还没打完气泡就消失了）。
 *    `say()` 再来一次时必须**立刻结束**上一次打字，不然两次输出会串在一起。
 */

import { isVoid, guideName, modeImageUrl } from '../mode.js';

/** 情绪白名单。与 CONTRACTS.md §4 的 emotion 枚举一致。 */
export const EMOTIONS = Object.freeze(['calm', 'smug', 'annoyed', 'worried', 'smile', 'thinking']);

/** 打字机速度：每字毫秒。契约要求「约 28ms」。 */
const TYPE_MS = 28;

/** 拖动阈值（px）。位移不超过它就算「点击」，避免手抖导致点不动头像。 */
const DRAG_THRESHOLD = 4;

/** 窗口边缘至少露出多少像素，防止头像被拖/挤到完全看不见。 */
const MIN_VISIBLE = 48;

/** 头像的最小估算尺寸，取不到真实布局时用它做钳制。 */
const MIN_AVATAR_SIZE = 48;

/**
 * 内置 Q 版贝翠丝。
 *
 * 与 `assets/beatrice.svg` **内容一致**，只是那边是给用户看/替换的独立文件。
 * ⚠️ 免构建的扩展**不能** `import './x.svg'`（浏览器不会把 .svg 当字符串模块），
 * 所以这里必须内联一份；改图请两边一起改（test/_tmp 自检里有配平检查兜底）。
 *
 * @type {string}
 */
export const BEATRICE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-hidden="true" focusable="false">
  <title>Q 版贝翠丝</title>
  <defs>
    <radialGradient id="bg-hair-glow" cx="50%" cy="42%" r="58%">
      <stop offset="0%" stop-color="#fbe6ac"/>
      <stop offset="55%" stop-color="#f2cd6b"/>
      <stop offset="100%" stop-color="#cb9427"/>
    </radialGradient>
    <linearGradient id="bg-dress" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#443a6b"/>
      <stop offset="60%" stop-color="#2a2447"/>
      <stop offset="100%" stop-color="#171331"/>
    </linearGradient>
    <filter id="bg-soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
  </defs>

  <ellipse cx="100" cy="104" rx="74" ry="70" fill="#f2cd6b" opacity="0.3" filter="url(#bg-soft)"/>

  <path d="M100 8 C58 8 40 38 40 74 C40 114 60 146 100 146 C140 146 160 114 160 74 C160 38 142 8 100 8 Z" fill="url(#bg-hair-glow)"/>

  <path d="M42 72 C30 102 32 136 40 168 C44 184 58 184 60 168 C64 142 58 112 56 84 Z" fill="#e0a93a"/>
  <path d="M158 72 C170 102 168 136 160 168 C156 184 142 184 140 168 C136 142 142 112 144 84 Z" fill="#e0a93a"/>
  <path d="M44 152 C36 158 36 168 44 172 C54 176 64 168 60 158 C58 150 48 148 44 152 Z" fill="#e0a93a"/>
  <path d="M156 152 C164 158 164 168 156 172 C146 176 136 168 140 158 C142 150 152 148 156 152 Z" fill="#e0a93a"/>

  <path d="M70 36 C72 28 76 24 80 24 C86 24 88 30 86 40 C84 50 78 58 76 66 C72 58 68 44 70 36 Z" fill="#f7dc92"/>
  <path d="M132 38 C134 30 138 26 142 26 C148 26 148 34 146 44 C144 54 138 60 136 68 C132 60 130 46 132 38 Z" fill="#f7dc92"/>

  <path d="M62 88 C56 100 60 116 66 126 C70 118 70 104 68 92 Z" fill="#e0a93a"/>
  <path d="M138 88 C144 100 140 116 134 126 C130 118 130 104 132 92 Z" fill="#e0a93a"/>
  <path d="M48 72 C42 86 44 98 50 106 C54 98 52 84 54 74 Z" fill="#efc25a"/>
  <path d="M152 72 C158 86 156 98 150 106 C146 98 148 84 146 74 Z" fill="#efc25a"/>

  <circle cx="100" cy="74" r="44" fill="#fff2dd"/>
  <ellipse cx="70" cy="94" rx="10" ry="6" fill="#f5a3b0" opacity="0.55"/>
  <ellipse cx="130" cy="94" rx="10" ry="6" fill="#f5a3b0" opacity="0.55"/>

  <path d="M100 8 C58 8 40 38 40 74 C40 96 48 116 62 130 C58 104 60 74 76 56 C88 42 112 42 124 56 C140 74 142 104 138 130 C152 116 160 96 160 74 C160 38 142 8 100 8 Z" fill="#f7dc92"/>

  <path d="M74 64 C82 52 118 52 126 64 C116 58 84 58 74 64 Z" fill="#e0a93a" opacity="0.65"/>

  <ellipse cx="82" cy="80" rx="11" ry="13" fill="#dceaff"/>
  <ellipse cx="118" cy="80" rx="11" ry="13" fill="#dceaff"/>
  <ellipse cx="82" cy="81" rx="9" ry="11" fill="#4a86d8"/>
  <ellipse cx="118" cy="81" rx="9" ry="11" fill="#4a86d8"/>
  <ellipse cx="82" cy="83" rx="5" ry="7" fill="#1c3f77"/>
  <ellipse cx="118" cy="83" rx="5" ry="7" fill="#1c3f77"/>
  <circle cx="78" cy="76" r="3.5" fill="#ffffff"/>
  <circle cx="114" cy="76" r="3.5" fill="#ffffff"/>
  <circle cx="86" cy="87" r="1.8" fill="#ffffff" opacity="0.85"/>
  <circle cx="122" cy="87" r="1.8" fill="#ffffff" opacity="0.85"/>
  <path d="M70 67 C76 62 88 62 93 66 C86 65 74 65 70 67 Z" fill="#b0842a"/>
  <path d="M130 67 C124 62 112 62 107 66 C114 65 126 65 130 67 Z" fill="#b0842a"/>

  <path d="M92 96 C96 92 104 92 108 96 C106 103 94 103 92 96 Z" fill="#b96a6a"/>
  <path d="M75 142 C86 124 114 124 125 142 C110 136 90 136 75 142 Z" fill="#ffffff"/>
  <circle cx="75" cy="133" r="8" fill="#ffffff"/>
  <circle cx="125" cy="133" r="8" fill="#ffffff"/>
  <path d="M100 146 C82 155 66 161 64 168 C80 176 120 176 136 168 C134 161 118 155 100 146 Z" fill="url(#bg-dress)"/>
  <path d="M82 189 C82 181 92 178 98 182 C102 185 102 189 99 191 C93 194 85 194 82 189 Z" fill="#413a63"/>
  <path d="M118 189 C118 181 108 178 102 182 C98 185 98 189 101 191 C107 194 115 194 118 189 Z" fill="#413a63"/>
  <path d="M100 146 C82 155 66 161 64 168 C74 176 90 180 100 180 C110 180 126 176 136 168 C134 161 118 155 100 146 Z" fill="url(#bg-dress)"/>
  <path d="M100 169 C90 169 80 171.5 74 175 C82 179 91 180 100 180 C109 180 118 179 126 175 C120 171.5 110 169 100 169 Z" fill="#f2cd6b" opacity="0.85"/>

  <path d="M78 24 C86 18 104 16 120 20 C106 20 92 22 82 28 Z" fill="#ffffff" opacity="0.6"/>
  <path d="M130 14 C134 6 141 3 146 7 C151 11 148 18 142 18 C146 22 143 29 137 27 C142 31 139 37 133 34 C136 38 131 42 126 37 C129 33 126 26 130 22 C133 18 129 16 130 14 Z" fill="#eef3ff" stroke="#8ea6e0" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M131 17 C134 12 139 11 142 14 C145 17 142 21 138 21 C140 25 138 29 134 28 C136 32 132 34 129 30 C131 27 129 22 131 19 Z" fill="#8fb4ee" opacity="0.75"/>
  <circle cx="136" cy="21" r="2.6" fill="#3d5fae"/>
</svg>`;

// ---------------------------------------------------------------------------
// 小工具（本文件自给自足：只依赖 document / window，不 import 兄弟模块）
//
// ⚠️ 这里刻意不去 import `src/ui/dom.js`：那个文件由别人负责写，
//    多一个跨文件依赖就多一种「它还没写好 → 悬浮窗整个挂掉」的失败模式。
// ---------------------------------------------------------------------------

/**
 * 建元素。
 *
 * 行内样式一律走 `setProperty` 而不是 `node.style.left = ...`：
 * 测试桩里的 `style` 常常只是个普通对象，赋值不会进 `_props`，
 * 用 `setProperty` 两边都能观察到（更早发现「样式根本没写上去」）。
 *
 * @param {string} tag
 * @param {string} [className]
 * @param {Record<string, string|number>} [style]
 * @returns {any}
 */
function createEl(tag, className, style) {
    const node = document.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (style) for (const [k, v] of Object.entries(style)) setStyle(node, k, v);
    return node;
}

/** 安全设置一条行内样式。 */
function setStyle(node, prop, value) {
    try {
        if (node?.style && typeof node.style.setProperty === 'function') {
            node.style.setProperty(prop, String(value));
            return;
        }
    } catch {
        /* 某些实现会对未知属性抛错，走下面的兜底 */
    }
    try {
        if (node?.style) node.style[prop] = String(value);
    } catch {
        /* 样式写不上不该让整个组件挂掉 */
    }
}

/** 安全设置属性。 */
function setAttr(node, name, value) {
    try {
        node?.setAttribute?.(name, String(value));
    } catch {
        /* 忽略：桩环境可能没有 setAttribute */
    }
}

/** 安全绑定事件（目标不支持时静默跳过）。 */
function bind(target, type, handler) {
    try {
        target?.addEventListener?.(type, handler);
    } catch {
        /* 忽略 */
    }
}

/** 安全解绑事件。 */
function unbind(target, type, handler) {
    try {
        target?.removeEventListener?.(type, handler);
    } catch {
        /* 忽略 */
    }
}

/**
 * 只读地读一个布尔设置，缺字段就退回默认值。
 * 设置对象理论上已被 `deepDefaults` 补全过，但 UI 层不该信任这件事。
 * @param {any} obj
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
function readBool(obj, key, fallback) {
    return typeof obj?.[key] === 'boolean' ? obj[key] : fallback;
}

/**
 * 只读地读一个数字设置。
 * @param {any} obj
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function readNum(obj, key, fallback) {
    const n = Number(obj?.[key]);
    return Number.isFinite(n) ? n : fallback;
}

/** requestAnimationFrame 兜底（老 WebView / 桩环境可能没有）。 */
function raf(cb) {
    const fn = typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame : null;
    return fn ? fn(cb) : setTimeout(cb, 16);
}

/** 与 `raf` 对称。 */
function caf(id) {
    const fn = typeof globalThis.cancelAnimationFrame === 'function' ? globalThis.cancelAnimationFrame : null;
    if (fn) fn(id);
    else clearTimeout(id);
}

/** 读视口尺寸，取不到就给一个保守值。 */
function viewport() {
    const w = Number(globalThis.window?.innerWidth);
    const h = Number(globalThis.window?.innerHeight);
    return {
        w: Number.isFinite(w) && w > 0 ? w : 1024,
        h: Number.isFinite(h) && h > 0 ? h : 768,
    };
}

/** 是否开启了「减少动态效果」。 */
function prefersReducedMotion() {
    try {
        return globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    } catch {
        return false;
    }
}

/**
 * 把 SVG 字符串变成可挂载的元素。
 * 解析失败（老 WebView）时返回 null，调用方退化成「只有光环没有立绘」，
 * 总比整个悬浮窗抛异常消失强。
 *
 * @param {string} markup
 * @returns {any|null}
 */
function inlineSvg(markup) {
    try {
        const host = document.createElement('div');
        // ⚠️ 这里唯一的 innerHTML：内容是本文件顶部写死的常量，不含任何外部输入
        host.innerHTML = String(markup ?? '');
        const svg = host.firstElementChild;
        if (!svg) return null;
        svg.setAttribute('class', 'bg-svg');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        return svg;
    } catch {
        return null;
    }
}

/**
 * 把任意长度的文本按 `\n` 拆成段落。
 * 全角换行、`\r\n` 都要认 —— 模型经常吐 `\r\n`。
 * @param {string} text
 * @returns {string[]}
 */
function splitParagraphs(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * 悬浮窗组件。
 *
 * @param {{
 *   settings: any,
 *   onAvatarClick?: () => void,
 *   onReobserve?: () => Promise<void>,
 *   onAvatarMove?: (pos: {x: number, y: number}) => void,
 *   onBubbleClose?: () => void,
 * }} options
 * @returns {{
 *   node: any,
 *   say: (text: string, opts?: {emotion?: string, durationMs?: number, sticky?: boolean, author?: string}) => void,
 *   hide: () => void,
 *   setVisible: (visible: boolean) => void,
 *   setEmotion: (name: string) => void,
 *   setBadge: (text: string|null) => void,
 *   setTyping: (on: boolean) => void,
 *   destroy: () => void,
 *   isBubbleOpen: boolean,
 * }}
 */
export function createFloatingBeatrice(options) {
    const opts = options ?? {};
    const settings = opts.settings ?? {};

    /** 每次读设置都走这里：设置是活对象，用户随时可能在面板里改。 */
    const uiNow = () => settings.ui ?? {};
    const realmNow = () => isVoid(settings) ? 'void' : 'beatrice';
    const avatarSrcNow = () => modeImageUrl(settings, 'floating') || (!isVoid(settings) && opts.extensionFolder
        ? `/scripts/extensions/third-party/${opts.extensionFolder}/assets/beatrice.png` : '');

    // ---- DOM 骨架（结构与 CONTRACTS.md §8 一一对应）----
    const node = createEl('div', 'bg-root');
    const particle = createEl('div', 'bg-particle');
    const avatar = createEl('button', 'bg-avatar');
    const badge = createEl('span', 'bg-badge');

    const bubble = createEl('div', 'bg-bubble');
    const head = createEl('div', 'bg-bubble-head');
    const body = createEl('div', 'bg-bubble-body');
    const closeBtn = createEl('button', 'bg-bubble-close');
    setAttr(avatar, 'title', '点击打开设置；长按 2 秒重新观测');
    let longPressTimer = null;
    function cancelLongPress() {
        if (longPressTimer !== null) clearTimeout(longPressTimer);
        longPressTimer = null;
    }
    const typing = createEl('div', 'bg-typing');
    /**
     * 文字标签，排在三点**前面**。
     *
     * 用户要求：「气泡吐槽生成中在文字框展示 碧翠丝正在观测」。
     * 原来只有一个三点动画 —— 用户知道"在忙"，但不知道在忙什么。
     * 加一行文字就清楚了：辅助模型正在读世界书与最近对话。
     */
    const typingText = createEl('span', 'bg-typing-text');

    // `hidden` 属性比 `display:none` 更可靠：CSS 里只要有一条
    // 针对 .bg-bubble 的 display 规则就可能盖掉行内样式，属性选择器不会。
    setAttr(bubble, 'hidden', '');
    setAttr(badge, 'hidden', '');
    setAttr(typing, 'hidden', '');
    setAttr(bubble, 'role', 'status');
    setAttr(typing, 'aria-hidden', 'true');
    typing.appendChild(typingText);
    for (let i = 0; i < 3; i++) typing.appendChild(createEl('span', 'bg-typing-dot'));

    setAttr(avatar, 'type', 'button');
    setAttr(avatar, 'aria-label', guideName(settings));
    setAttr(closeBtn, 'type', 'button');
    setAttr(closeBtn, 'aria-label', '关闭');
    // × 用字符而不是图标字体：酒馆的 fontawesome 版本不保证，缺字会显示成方框
    closeBtn.textContent = '×';

    // 立绘：自定义图片优先，其次**随包的内置 PNG**，最后才退回内置 SVG。
    //
    // 路径解析：用户在设置里填的是**相对插件目录**的路径（例如 `assets/my-beatrice.png`），
    // 但插件目录名取决于用户安装时的文件夹名（可能是 `beatrice-guide-main`），
    // 所以由 index.js 在启动时把完整 URL 写进 `ui.customImageSrc`。
    // 这里优先读那个解析好的值，读不到才退回原始字符串（兼容手工填绝对路径的情况）。
    //
    // 顺序说明：内置 PNG 是正式立绘；SVG 只作为「PNG 加载失败」时的兜底
    //（例如用户只拷了部分文件、或者插件目录名推导不出来）。
    let currentAvatarSrc = avatarSrcNow();
    let currentRealm = realmNow();
    setAttr(node, 'data-bg-realm', currentRealm);

    const onAvatarError = (event) => {
        // 已移除的旧图仍可能派发 error，不能让它删除新模式的头像。
        const failed = event?.currentTarget ?? event?.target;
        const broken = avatar.querySelector?.('.bg-avatar-img');
        if (failed && failed !== broken) return;
        console.warn('[碧翠丝] 立绘加载失败，已退回内置形象');
        broken?.remove?.();
        showBuiltinAvatar();
    };

    /** 换成内置 SVG 立绘（最后的兜底）。 */
    function showBuiltinAvatar() {
        if (isVoid(settings)) {
            // Never substitute Beatrice for a missing Hitogami asset.
            const fallback = createEl('span', 'bg-void-fallback');
            fallback.textContent = guideName(settings);
            avatar.appendChild(fallback);
            return;
        }
        const svg = inlineSvg(BEATRICE_SVG);
        if (!svg) return;
        avatar.appendChild(svg);
    }

    /** 用图片当立绘。 */
    function showImageAvatar(/** @type {string} */ src) {
        const img = createEl('img', 'bg-avatar-img');
        setAttr(img, 'alt', '');
        setAttr(img, 'draggable', 'false');
        setAttr(img, 'src', src);
        bind(img, 'error', onAvatarError);
        avatar.appendChild(img);
    }

    if (currentAvatarSrc) showImageAvatar(currentAvatarSrc);
    else showBuiltinAvatar();

    avatar.appendChild(badge);
    bubble.appendChild(head);
    bubble.appendChild(body);
    bubble.appendChild(typing);
    bubble.appendChild(closeBtn);
    node.appendChild(particle);
    node.appendChild(bubble);
    node.appendChild(avatar);


    // ---- 状态 ----
    let visible = true;
    let bubbleOpen = false;
    let destroyed = false;
    let emotion = 'calm';
    /** @type {number|null} 自动收起计时器 */
    let hideTimer = null;
    /** 收起截止时间戳；悬停暂停时用它换算剩余时间 */
    let hideDeadline = 0;
    /** @type {number|null} 打字机 rAF 句柄 */
    let typeRaf = null;
    /** @type {Array<{el: any, text: string}>} 待逐字填充的段落 */
    let typeQueue = [];
    /** @type {(number|null)} 打字完成后要排的自动收起草稿（毫秒；null = 不收） */
    let pendingDuration = null;
    /** 当前气泡里已生成的段落元素 */
    let paragraphs = [];

    // 拖动状态
    let pointerId = null;
    let dragMoved = false;
    /** 这次交互是否已经算作拖动；拖动过之后紧随其后的 click 要吞掉。 */
    let suppressClick = false;
    let dragStart = { x: 0, y: 0 };
    let dragOrigin = { x: 0, y: 0 };
    let dragLast = { x: 0, y: 0 };
    /** 最近一次生效的坐标。拖动起点必须用它，不能回头读设置 ——
     *  设置要等 onAvatarMove 的调用方落盘后才会更新，拖第二次时会跳回原位。 */
    let currentPos = { x: 0, y: 0 };

    // -----------------------------------------------------------------------
    // 位置
    // -----------------------------------------------------------------------

    /**
     * 把头像坐标钳进可视区。
     *
     * 至少保证 `MIN_VISIBLE` 像素在屏幕内：用户可以接受它「贴着边」，
     * 但不能接受它「彻底消失且找不回来」。
     *
     * @param {{x: number, y: number}} pos
     * @returns {{x: number, y: number}}
     */
    function clampToViewport(pos) {
        const { w, h } = viewport();
        const size = Math.max(MIN_AVATAR_SIZE, readNum(uiNow(), 'avatarSize', 96));
        // 视口比头像还小时（手机横屏 / 窗口被压扁），下限会大于上限，
        // 这时以「贴左上角」为准，Math.min/max 的顺序保证不会算出负的可用区
        const maxX = Math.max(0, w - Math.max(MIN_VISIBLE, Math.min(size, w)));
        const maxY = Math.max(0, h - Math.max(MIN_VISIBLE, Math.min(size, h)));
        const x = Number.isFinite(Number(pos?.x)) ? Number(pos.x) : 0;
        const y = Number.isFinite(Number(pos?.y)) ? Number(pos.y) : 0;
        return {
            x: Math.round(Math.min(maxX, Math.max(0, x))),
            y: Math.round(Math.min(maxY, Math.max(0, y))),
        };
    }

    /** 应用（并钳制）头像位置。窗口 resize 时必须再跑一次。 */
    function applyPosition() {
        const size = readNum(uiNow(), 'avatarSize', 96);
        setStyle(node, '--bg-avatar-size', `${Math.max(MIN_AVATAR_SIZE, Math.round(size))}px`);

        const pos = clampToViewport(uiNow().avatarPos ?? {});
        setStyle(node, 'left', `${pos.x}px`);
        setStyle(node, 'top', `${pos.y}px`);
        currentPos = pos;
        applySide(pos);
        applyBubbleWidth(pos, size);
        return pos;
    }

    /**
     * 把「气泡能占多宽」算成 CSS 变量。
     *
     * 为什么必须由 JS 算而不是纯 CSS：
     * `.bg-root` 是一个 0×0 的 fixed 定位点，气泡用 `position:absolute` 挂在它下面。
     * 这种情况下气泡的**包含块就是那个 0 宽的盒子** —— 只写 `max-width` 而不写
     * `width` 时，`shrink-to-fit` 会在这个几乎为零的可用宽度上算，中文就变成
     * 一字一行（实测就是这个现象：气泡被压成细长条）。
     *
     * 所以这里按「头像到同侧视口边缘」的实际空间给出一个具体宽度：
     *  - 气泡在头像右边（data-side=right）→ 可用 = 视口宽 - 头像右缘 - 边距
     *  - 气泡在头像左边（data-side=left） → 可用 = 头像左缘 - 边距
     * 再夹在 [MIN, MAX] 之间。上限 340px 是「一次能舒服读完一句引导」的宽度，
     * 不跟着屏幕变宽无限拉伸（否则在 4K 上会变成一条长横幅，很难读）。
     *
     * @param {{x: number, y: number}} pos
     * @param {number} size 头像边长
     */
    function applyBubbleWidth(pos, size) {
        const vp = viewport();
        const MARGIN = 12;
        const MAX = 340;
        const MIN = 180;

        const side = node.getAttribute?.('data-side') === 'left' ? 'left' : 'right';
        const available =
            side === 'right' ? vp.w - (pos.x + size) - MARGIN * 2 : pos.x - MARGIN * 2;

        const width = Math.max(MIN, Math.min(MAX, Math.round(available)));
        setStyle(node, '--bg-bubble-w', `${width}px`);
    }

    /**
     * 决定气泡朝哪边：左半边 → 右，右半边 → 左。
     * 只写 `data-side`，具体几何在 CSS 里。
     * @param {{x: number, y: number}} pos
     */
    function applySide(pos) {
        const forced = String(uiNow().bubbleSide ?? 'auto');
        if (forced === 'left' || forced === 'right') {
            setAttr(node, 'data-side', forced);
            return;
        }
        // 用头像**中心**而不是左边缘判断，否则贴边的头像会一直判成同一侧
        const size = Math.max(MIN_AVATAR_SIZE, readNum(uiNow(), 'avatarSize', 96));
        const centerX = pos.x + size / 2;
        setAttr(node, 'data-side', centerX < viewport().w / 2 ? 'right' : 'left');
    }

    // -----------------------------------------------------------------------
    // 气泡
    // -----------------------------------------------------------------------

    /** 停掉自动收起计时。 */
    function clearHideTimer() {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    /** 按 `durationMs`（毫秒）排一个自动收起；0 / NaN 表示不自动收。 */
    function scheduleHide(durationMs) {
        clearHideTimer();
        const ms = Number(durationMs);
        if (!Number.isFinite(ms) || ms <= 0) return;
        hideDeadline = Date.now() + ms;
        hideTimer = setTimeout(() => {
            hideTimer = null;
            hideBubble();
        }, ms);
    }

    /** 悬停暂停：记下剩余时间后清掉计时器。 */
    function pauseHide() {
        if (hideTimer === null) return;
        clearHideTimer();
        pendingDuration = Math.max(0, hideDeadline - Date.now());
    }

    /** 移开继续：用剩余时间重新排。 */
    function resumeHide() {
        if (pendingDuration === null) return;
        const rest = pendingDuration;
        pendingDuration = null;
        if (!bubbleOpen) return;
        scheduleHide(rest);
    }

    /** 收起气泡（不动头像）。 */
    function hideBubble() {
        clearHideTimer();
        pendingDuration = null;
        if (!bubbleOpen) return;
        bubbleOpen = false;
        setAttr(bubble, 'hidden', '');
        setAttr(node, 'data-open', 'off');
    }

    /** 展开气泡外壳；head 有没有内容由调用方决定。 */
    function openBubble() {
        bubbleOpen = true;
        try {
            bubble.removeAttribute('hidden');
        } catch {
            /* 桩环境可能没有 removeAttribute */
        }
        setAttr(node, 'data-open', 'on');
    }

    /**
     * 结束打字机（**不**触发自动收起，收起计时由调用方决定）。
     * `say()` 重入与 `destroy()` 都走它。
     */
    function finishTypingNow() {
        if (typeRaf !== null) {
            caf(typeRaf);
            typeRaf = null;
        }
        for (const item of typeQueue) {
            if (item.el && item.el.textContent !== item.text) item.el.textContent = item.text;
        }
        typeQueue = [];
        // ⚠️ 光标标志必须一起撤掉：`setAttr(body, 'data-typing', 'on')` 是持久状态，
        // 只停 rAF 的话 CSS 里的打字光标会一直闪（`destroy()` 之后都还在）。
        setAttr(body, 'data-typing', 'off');
    }

    /**
     * 打字机：把队列里的段落逐字填进各自的元素。
     *
     * 用 rAF 做节拍、按「时间差」决定这一次该吐几个字，而不是每 28ms 固定一个字 ——
     * 长文本下后者会因为 rAF 丢帧而明显变慢（甚至追不上自动收起的计时）。
     */
    function typeTick() {
        typeRaf = null;
        if (destroyed) return;
        if (!typeQueue.length) {
            onTypingDone();
            return;
        }

        const item = typeQueue[0];
        // 每帧最多补 `elapsed / TYPE_MS` 个字；用真实时间差保证总时长可控
        const now = Date.now();
        const target = Math.min(item.text.length, Math.floor((now - item.startedAt) / TYPE_MS) + 1);
        const shown = item.shown ?? 0;

        if (target > shown) {
            item.shown = target;
            item.el.textContent = item.text.slice(0, target);
        }

        if (item.shown >= item.text.length) {
            item.el.textContent = item.text;
            typeQueue.shift();
            if (!typeQueue.length) {
                onTypingDone();
                return;
            }
        }
        typeRaf = raf(typeTick);
    }

    /** 打字结束：撤掉光标，并按 `durationMs` 开始计时。 */
    function onTypingDone() {
        setAttr(body, 'data-typing', 'off');
        // ⚠️ 计时**从打字完成才开始**（契约要求），否则长文本还没读完就消失了
        if (pendingDuration !== null) scheduleHide(pendingDuration);
    }

    /**
     * 说话。
     *
     * @param {string} text 用 `\n` 分段，每段渲染成一个 `<p>`
     * @param {{emotion?: string, durationMs?: number, sticky?: boolean, author?: string}} [sayOpts]
     */
    function say(text, sayOpts = {}) {
        if (destroyed) return;

        // 再来一次就立刻结束上一次：否则两段输出会串在一起打
        finishTypingNow();
        clearHideTimer();
        pendingDuration = null;

        const o = sayOpts ?? {};
        if (o.emotion) setEmotion(o.emotion);

        // 作者头：默认人设名（契约 §8），显式传空串表示这次不要头
        const author = o.author === undefined ? guideName(settings) : String(o.author ?? '');
        head.textContent = author;
        if (author) head.removeAttribute?.('hidden');
        else setAttr(head, 'hidden', '');

        const lines = splitParagraphs(text);

        // 清空旧段落。
        //
        // ⚠️ 这里原本写的是 `body.textContent = ''`。按 DOM 语义它**应该**清空子节点，
        // 但在某些 WebView / 框架代理节点上这个行为不保证；一旦没清掉，
        // 新消息就会接在旧消息下面，用户看到两句话拼在一起（像串台）。
        // `replaceChildren()` 是显式的、语义明确的清空，不依赖 textContent 的副作用。
        if (typeof body.replaceChildren === 'function') body.replaceChildren();
        else body.textContent = '';
        paragraphs = [];
        for (const line of lines) {
            const p = createEl('p', 'bg-bubble-p');
            body.appendChild(p);
            paragraphs.push(p);
        }

        // 空文本 = 只要一个「壳」（比如配合 setTyping 用）；不排自动收起，免得空泡一闪
        if (!lines.length) {
            openBubble();
            setAttr(body, 'data-typing', 'off');
            return;
        }
        openBubble();

        // 自动收起草稿：默认取设置里的 bubbleDurationMs；传 0 或 sticky 表示不收
        const wantSticky = o.sticky === true;
        const duration = o.durationMs === undefined ? readNum(uiNow(), 'bubbleDurationMs', 15000) : Number(o.durationMs);
        pendingDuration = wantSticky ? null : Number.isFinite(duration) ? duration : null;
        if (pendingDuration === 0) pendingDuration = null;

        // 尊重系统的「减少动态效果」：直接出全文，不做逐字
        if (prefersReducedMotion()) {
            paragraphs.forEach((p, i) => {
                p.textContent = lines[i];
            });
            setAttr(body, 'data-typing', 'off');
            if (pendingDuration !== null) scheduleHide(pendingDuration);
            return;
        }

        // 打字机的起跑时刻在**这里**就固定，不能等第一帧再记：
        // rAF 在后台标签页/重绘压力下可能几百毫秒后才跑第一帧，
        // 那时按「已过去的时间」补字会一口气把整句吐完，打字机效果直接没了。
        const startedAt = Date.now();
        typeQueue = paragraphs.map((p, i) => ({ el: p, text: lines[i], shown: 0, startedAt }));
        setAttr(body, 'data-typing', 'on');
        if (typeRaf === null) typeRaf = raf(typeTick);
    }

    // -----------------------------------------------------------------------
    // 情绪 / 角标 / 打字中
    // -----------------------------------------------------------------------

    /** 切换情绪（同时写进 data-emotion 给 CSS 用）。非法值忽略，不退回默认。 */
    function setEmotion(name) {
        const value = String(name ?? '');
        if (!EMOTIONS.includes(value) || value === emotion) return;
        emotion = value;
        setAttr(node, 'data-emotion', value);
    }

    /** 右上角小圆点数字；传 null / '' 隐藏。 */
    function setBadge(text) {
        const value = text === null || text === undefined ? '' : String(text).trim();
        if (!value) {
            badge.textContent = '';
            setAttr(badge, 'hidden', '');
            return;
        }
        badge.textContent = value;
        badge.removeAttribute?.('hidden');
    }

    /**
     * 「正在观测…」状态（辅助 API 请求进行中）。
     *
     * @param {boolean|string} on
     *   `true`  → 用默认文案「正在观测…」
     *   字符串  → 用这句自定义文案（例如「正在读世界书…」）
     *   `false` → 收起
     */
    function setTyping(on) {
        if (on === true || typeof on === 'string') {
            typingText.textContent = typeof on === 'string' && on.trim() ? on.trim() : `${guideName(settings)}正在观测…`;
            typing.removeAttribute?.('hidden');
            // 状态条出现时要确保气泡是打开的，否则用户看不到状态
            openBubble();
            setAttr(body, 'data-typing', 'on');
        } else {
            setAttr(typing, 'hidden', '');
            setAttr(body, 'data-typing', 'off');
        }
    }

    // -----------------------------------------------------------------------
    // 显隐
    // -----------------------------------------------------------------------

    /** 整体显隐（头像 + 气泡）。 */
    function setVisible(next) {
        visible = next !== false;
        setStyle(node, 'display', visible ? '' : 'none');
        setAttr(node, 'data-visible', visible ? 'on' : 'off');
        if (!visible) {
            cancelLongPress();
            hideBubble();
        }
    }

    // -----------------------------------------------------------------------
    // 拖动（Pointer Events：鼠标 / 触摸 / 触控笔一套代码）
    // -----------------------------------------------------------------------

    /** 从事件里取坐标；老实现可能只有 clientX/Y。 */
    function pointOf(ev) {
        const e = ev ?? {};
        const x = Number(e.clientX ?? e.pageX ?? 0);
        const y = Number(e.clientY ?? e.pageY ?? 0);
        return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
    }

    const onPointerDown = (ev) => {
        if (destroyed || visible === false) return;
        const e = ev ?? {};
        // 只认左键/触摸主指针；右键菜单不该把人拖走
        if (e.button !== undefined && e.button !== 0) return;
        if (e.isPrimary === false || pointerId !== null) return;
        cancelLongPress();
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            if (destroyed || !visible || dragMoved) return;
            suppressClick = true;
            void onReobserveClick();
        }, 2000);
        const p = pointOf(e);
        pointerId = e.pointerId ?? null;
        dragMoved = false;
        suppressClick = false;
        dragStart = p;
        dragLast = currentPos;
        // 起点用「当前生效坐标」而不是回头读 ui.avatarPos：
        // 设置要等 onAvatarMove 的调用方落盘后才更新，否则连拖两次会跳回原位
        dragOrigin = currentPos;
        try {
            avatar.setPointerCapture?.(pointerId);
        } catch {
            /* 桩环境 / 不支持的宿主：忽略 */
        }
    };

    const onPointerMove = (ev) => {
        if (destroyed || pointerId === null) return;
        const e = ev ?? {};
        if (e.pointerId !== undefined && pointerId !== null && e.pointerId !== pointerId) return;
        const p = pointOf(e);

        if (!dragMoved) {
            const dx = Math.abs(p.x - dragStart.x);
            const dy = Math.abs(p.y - dragStart.y);
            // 阈值内不算拖动：手抖不能吃掉点击
            if (dx + dy <= DRAG_THRESHOLD) return;
            cancelLongPress();
            dragMoved = true;
            suppressClick = true;
            // 拖动期间关掉过渡/漂浮动画，否则头像会「黏」在指针后面。
            // 停动画靠 .bg-dragging 一条规则（CSS 里 animation: none），
            // 不需要再动 data-idle —— 那个属性归 ui.idleAnimation 管，两处都写会打架。
            node.classList?.add('bg-dragging');
        }

        const pos = clampToViewport({
            x: dragOrigin.x + (p.x - dragStart.x),
            y: dragOrigin.y + (p.y - dragStart.y),
        });
        dragLast = pos;
        setStyle(node, 'left', `${pos.x}px`);
        setStyle(node, 'top', `${pos.y}px`);
        applySide(pos);
        if (typeof e.preventDefault === 'function') e.preventDefault();
    };

    /** 结束拖动：只有真的拖动过才回调 onAvatarMove。 */
    const onPointerUp = (ev) => {
        if (pointerId === null) return;
        const e = ev ?? {};
        if (e.pointerId !== undefined && pointerId !== null && e.pointerId !== pointerId) return;
        cancelLongPress();
        try {
            avatar.releasePointerCapture?.(pointerId);
        } catch {
            /* 忽略 */
        }
        pointerId = null;
        node.classList?.remove('bg-dragging');
        if (!dragMoved) return;
        dragMoved = false;
        const pos = clampToViewport(dragLast);
        currentPos = pos;
        try {
            opts.onAvatarMove?.({ x: pos.x, y: pos.y });
        } catch (err) {
            console.error('[碧翠丝] onAvatarMove 回调出错', err);
        }
    };

    const onAvatarClick = (ev) => {
        if (destroyed) return;
        if (typeof ev?.preventDefault === 'function') ev.preventDefault();
        // 拖动过就不算点击。pointerup 先于 click 触发，所以这里读的是它留下的标志位
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        try {
            opts.onAvatarClick?.();
        } catch (err) {
            console.error('[碧翠丝] onAvatarClick 回调出错', err);
        }
    };

    const onCloseClick = (ev) => {
        if (typeof ev?.stopPropagation === 'function') ev.stopPropagation();
        if (typeof ev?.preventDefault === 'function') ev.preventDefault();
        hideBubble();
        try {
            opts.onBubbleClose?.();
        } catch (err) {
            console.error('[碧翠丝] onBubbleClose 回调出错', err);
        }
    };

    let reobserving = false;
    const onReobserveClick = async (ev) => {
        ev?.stopPropagation?.();
        ev?.preventDefault?.();
        if (destroyed || reobserving) return;
        reobserving = true;

        try {
            await opts.onReobserve?.();
        } catch (err) {
            if (!destroyed) say(`重新观测失败：${err?.message ?? err}`, { sticky: true });
        } finally {
            reobserving = false;

        }
    };

    const onResize = () => {
        if (destroyed) return;
        // 窗口变小后头像可能整个跑到屏幕外 —— 必须拉回来
        applyPosition();
    };

    // 悬停暂停自动收起（进气泡、进头像都算「用户在看」）
    const onBubbleEnter = () => pauseHide();
    const onBubbleLeave = () => resumeHide();

    bind(avatar, 'pointerdown', onPointerDown);
    bind(avatar, 'click', onAvatarClick);
    bind(closeBtn, 'click', onCloseClick);
    const onContextMenu = (ev) => ev.preventDefault?.();
    bind(avatar, 'contextmenu', onContextMenu);
    bind(avatar, 'lostpointercapture', onPointerUp);
    bind(globalThis.window, 'blur', cancelLongPress);
    bind(bubble, 'pointerenter', onBubbleEnter);
    bind(bubble, 'pointerleave', onBubbleLeave);
    bind(bubble, 'mouseenter', onBubbleEnter);
    bind(bubble, 'mouseleave', onBubbleLeave);
    bind(globalThis.window, 'pointermove', onPointerMove);
    bind(globalThis.window, 'pointerup', onPointerUp);
    bind(globalThis.window, 'pointercancel', onPointerUp);
    bind(globalThis.window, 'resize', onResize);

    // ---- 初始化 ----
    setStyle(node, 'position', 'fixed');
    setEmotion('calm'); // 先设初值再让外部覆盖，保证 data-emotion 一定存在
    emotion = 'calm';
    setAttr(node, 'data-emotion', 'calm');
    setAttr(node, 'data-idle', readBool(uiNow(), 'idleAnimation', true) ? 'on' : 'off');
    setVisible(readBool(uiNow(), 'showAvatar', true));
    applyPosition();

    return {
        node,

        /** 说话。`say()` 会把上一次的逐字动画立刻收尾。 */
        say,

        /** 收起气泡（不隐藏头像）。 */
        hide: hideBubble,

        setVisible,
        setEmotion,
        setBadge,
        setTyping,

        /**
         * 设置变了之后重新同步（面板改了头像大小 / 常驻动画 / 自定义立绘时调）。
         * 契约外的方法：不改设置对象，只重读。
         */
        refresh() {
            if (destroyed) return;
            const nextRealm = realmNow();
            if (nextRealm !== currentRealm) {
                finishTypingNow();
                hideBubble();
                setTyping(false);
                head.textContent = '';
                body.replaceChildren?.();
            }
            currentRealm = nextRealm;
            setAttr(node, 'data-bg-realm', nextRealm);
            setAttr(avatar, 'aria-label', guideName(settings));
            setAttr(avatar, 'title', `${guideName(settings)}：点击打开设置；长按 2 秒重新观测`);
            applyPosition();
            setAttr(node, 'data-idle', readBool(uiNow(), 'idleAnimation', true) ? 'on' : 'off');

            // 立绘换了要重建（用户可能在设置面板里填了新路径）
            const wantSrc = avatarSrcNow();
            if (wantSrc !== currentAvatarSrc) {
                currentAvatarSrc = wantSrc;
                const stale = avatar.querySelector?.('.bg-avatar-img');
                const staleSvg = avatar.querySelector?.('svg');
                stale?.remove?.();
                staleSvg?.remove?.();
                avatar.querySelector?.('.bg-void-fallback')?.remove?.();
                if (wantSrc) {
                    const img = createEl('img', 'bg-avatar-img');
                    setAttr(img, 'alt', '');
                    setAttr(img, 'draggable', 'false');
                    setAttr(img, 'src', wantSrc);
                    bind(img, 'error', onAvatarError);
                    avatar.appendChild(img);
                } else {
                    showBuiltinAvatar();
                }
                avatar.appendChild(badge);
            }
        },

        get isBubbleOpen() {
            return bubbleOpen;
        },

        /** 拆干净：计时器、rAF、监听器、DOM 一个不留。可重复调用。 */
        destroy() {
            if (destroyed) return;
            destroyed = true;
            finishTypingNow();
            clearHideTimer();
            pendingDuration = null;
            if (typeRaf !== null) {
                caf(typeRaf);
                typeRaf = null;
            }

            unbind(avatar, 'pointerdown', onPointerDown);
            unbind(avatar, 'click', onAvatarClick);
            unbind(closeBtn, 'click', onCloseClick);
            cancelLongPress();
            unbind(avatar, 'contextmenu', onContextMenu);
            unbind(avatar, 'lostpointercapture', onPointerUp);
            unbind(globalThis.window, 'blur', cancelLongPress);
            unbind(bubble, 'pointerenter', onBubbleEnter);
            unbind(bubble, 'pointerleave', onBubbleLeave);
            unbind(bubble, 'mouseenter', onBubbleEnter);
            unbind(bubble, 'mouseleave', onBubbleLeave);
            unbind(globalThis.window, 'pointermove', onPointerMove);
            unbind(globalThis.window, 'pointerup', onPointerUp);
            unbind(globalThis.window, 'pointercancel', onPointerUp);
            unbind(globalThis.window, 'resize', onResize);

            bubbleOpen = false;
            try {
                node.remove?.();
            } catch {
                /* 已经不在文档里也无所谓 */
            }
        },
    };
}
