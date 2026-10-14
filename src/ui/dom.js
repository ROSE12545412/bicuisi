/**
 * 碧翠丝的禁书库 / src/ui/dom.js
 * ---------------------------------------------------------------------------
 * DOM 小工具。没有 jQuery、没有框架 —— 扩展是免构建的原生 ESM，
 * 引入依赖会让用户装插件前还得先跑一次 npm install，不值当。
 *
 * 全部函数都对「DOM 不存在」的环境（冒烟测试、非浏览器宿主）保持沉默，
 * 让纯逻辑模块可以在 Node 里被测试。
 */

import { CSS_PREFIX } from '../config.js';

/** 取 document，没有就返回 null。 */
export function doc() {
    try {
        return /** @type {any} */ (globalThis)?.document ?? null;
    } catch {
        return null;
    }
}

/**
 * 建一个元素。
 * @param {string} tag
 * @param {Record<string, any>} [attrs] class / id / title / text / html / style / 其它属性 / on* 事件
 * @param {Array<any>|string|number} [children]
 * @returns {any}
 */
export function el(tag, attrs = {}, children = []) {
    const d = doc();
    if (!d) return null;

    const node = d.createElement(tag);

    for (const [key, value] of Object.entries(attrs ?? {})) {
        if (value === undefined || value === null) continue;

        if (key === 'class' || key === 'className') {
            node.className = String(value);
        } else if (key === 'text') {
            // 用 textContent 而不是 innerHTML —— 模型输出会走到这里，必须防 XSS
            node.textContent = String(value);
        } else if (key === 'html') {
            // 只在**我们自己写死的**模板上用（图标之类），绝不用于模型/用户文本
            node.innerHTML = String(value);
        } else if (key === 'style' && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) {
                try {
                    node.style[k] = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v);
                } catch {
                    /* 个别属性在旧 WebView 上不支持，跳过 */
                }
            }
        } else if (key === 'dataset' && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) node.dataset[k] = String(v);
        } else if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
            try {
                node.setAttribute(key, String(value));
            } catch {
                /* ignore */
            }
        }
    }

    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
        if (child === null || child === undefined || child === false) continue;
        if (typeof child === 'string' || typeof child === 'number') {
            node.appendChild(d.createTextNode(String(child)));
        } else {
            node.appendChild(child);
        }
    }

    return node;
}

/** 这些 CSS 属性的数值不需要加 px。 */
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order']);

/**
 * 安全地绑事件。
 * @param {any} node
 * @param {string} type
 * @param {Function} handler
 * @param {any} [options]
 * @returns {() => void} 解绑函数
 */
export function on(node, type, handler, options) {
    if (!node?.addEventListener) return () => {};
    node.addEventListener(type, handler, options);
    return () => {
        try {
            node.removeEventListener(type, handler, options);
        } catch {
            /* ignore */
        }
    };
}

/** 清空一个节点的子元素。 */
export function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
}

/** 用一串子元素替换节点内容。 */
export function setChildren(node, children) {
    clear(node);
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === 'object' ? child : doc()?.createTextNode(String(child)));
    }
}

/**
 * 让一个元素可拖拽。
 *
 * 用 Pointer Events 而不是 mouse + touch 两套：
 * Tauri 的 WebView 在触屏设备上 mouse 事件会延迟 300ms，拖起来很粘手。
 *
 * @param {any} handle 拖拽把手（通常是元素自身）
 * @param {any} target 被移动的元素
 * @param {{ onEnd?: (pos: {x: number, y: number}) => void, onStart?: () => void, bounds?: () => {w: number, h: number} }} [opts]
 * @returns {() => void} 解绑
 */
export function makeDraggable(handle, target, opts = {}) {
    if (!handle?.addEventListener || !target) return () => {};

    let dragging = false;
    let offset = { x: 0, y: 0 };
    const offs = [];

    offs.push(
        on(handle, 'pointerdown', (/** @type {any} */ e) => {
            // 只响应左键 / 触摸
            if (e.button !== undefined && e.button !== 0) return;
            dragging = true;
            const rect = target.getBoundingClientRect?.() ?? { left: 0, top: 0 };
            offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            opts.onStart?.();
            try {
                handle.setPointerCapture?.(e.pointerId);
            } catch {
                /* 某些 WebView 不支持，靠 window 上的监听兜底 */
            }
            e.preventDefault?.();
        }),
    );

    offs.push(
        on(/** @type {any} */ (globalThis)?.window ?? handle, 'pointermove', (/** @type {any} */ e) => {
            if (!dragging) return;
            const size = opts.bounds?.() ?? measure(target);
            const next = clampToViewport(e.clientX - offset.x, e.clientY - offset.y, size.w, size.h);
            target.style.left = `${next.x}px`;
            target.style.top = `${next.y}px`;
            target.style.right = 'auto';
            target.style.bottom = 'auto';
        }),
    );

    const end = () => {
        if (!dragging) return;
        dragging = false;
        const rect = target.getBoundingClientRect?.() ?? { left: 0, top: 0 };
        opts.onEnd?.({ x: Math.round(rect.left), y: Math.round(rect.top) });
    };
    offs.push(on(/** @type {any} */ (globalThis)?.window ?? handle, 'pointerup', end));
    offs.push(on(/** @type {any} */ (globalThis)?.window ?? handle, 'pointercancel', end));

    return () => offs.forEach((fn) => fn());
}

/** 量一个元素的尺寸。 */
export function measure(node) {
    try {
        const rect = node.getBoundingClientRect?.();
        if (rect?.width) return { w: rect.width, h: rect.height };
        const w = Number.parseFloat(node.style?.width) || node.offsetWidth || 0;
        const h = Number.parseFloat(node.style?.height) || node.offsetHeight || 0;
        return { w, h };
    } catch {
        return { w: 0, h: 0 };
    }
}

/**
 * 把坐标夹进可视区。
 *
 * 为什么必须有：用户把酒馆窗口缩小、或者切换显示器分辨率之后，
 * 之前保存的坐标就落在屏幕外了，悬浮球会「消失」—— 用户以为插件坏了。
 * 这是姊妹项目（tavern-dice）实测踩到的坑。
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [w]
 * @param {number} [h]
 * @returns {{x: number, y: number}}
 */
export function clampToViewport(x, y, w = 0, h = 0) {
    const win = /** @type {any} */ (globalThis)?.window;
    const vw = Number(win?.innerWidth) || 1920;
    const vh = Number(win?.innerHeight) || 1080;
    const margin = 4;
    return {
        x: Math.max(margin, Math.min(vw - w - margin, Number(x) || 0)),
        y: Math.max(margin, Math.min(vh - h - margin, Number(y) || 0)),
    };
}

/**
 * 酒馆风格的浮动提示。
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 * @param {number} [durationMs]
 */
export function toast(message, type = 'info', durationMs = 4200) {
    const d = doc();
    if (!d) return;

    const existing = d.querySelector?.(`.${CSS_PREFIX}toast-host`);
    const host =
        existing ??
        (() => {
            const node = el('div', { class: `${CSS_PREFIX}toast-host` });
            d.body?.appendChild(node);
            return node;
        })();

    const item = el('div', { class: `${CSS_PREFIX}toast`, dataset: { type } }, String(message));
    host.appendChild(item);

    // 入场动画由 CSS 负责，这里只安排退场
    setTimeout(() => {
        item.classList?.add(`${CSS_PREFIX}toast-out`);
        setTimeout(() => item.remove?.(), 320);
    }, Math.max(800, durationMs));
}

/**
 * 一行设置项：左边文字 + 说明，右边控件。
 * @param {{ label: string, hint?: string, control: any, wide?: boolean }} opts
 * @returns {any}
 */
let fieldId = 0;
export function field(opts) {
    const id = `${CSS_PREFIX}field-${++fieldId}`;
    const controls = [];
    const collect = (node) => {
        if (!node) return;
        if (['input', 'select', 'textarea'].includes(String(node.tagName).toLowerCase())) controls.push(node);
        for (const child of node.childNodes ?? []) collect(child);
    };
    collect(opts.control);
    for (const control of controls) {
        control.setAttribute?.('aria-labelledby', `${id}-label`);
        if (opts.hint) control.setAttribute?.('aria-describedby', `${id}-hint`);
    }
    const left = el('div', { class: `${CSS_PREFIX}field-label` }, [
        el('span', { id: `${id}-label`, class: `${CSS_PREFIX}field-title`, text: opts.label }),
        opts.hint ? el('span', { id: `${id}-hint`, class: `${CSS_PREFIX}field-hint`, text: opts.hint }) : null,
    ]);
    return el('div', { class: `${CSS_PREFIX}field`, dataset: { wide: opts.wide ? '1' : '0' } }, [
        left,
        el('div', { class: `${CSS_PREFIX}field-control` }, [opts.control]),
    ]);
}

/**
 * 多行文本框（人设提示词那种要写一大段的字段）。
 * @param {{ value: string, placeholder?: string, rows?: number, onChange: (v: string) => void }} opts
 * @returns {any}
 */
export function textarea(opts) {
    const node = el('textarea', {
        class: `${CSS_PREFIX}input ${CSS_PREFIX}textarea`,
        rows: opts.rows ?? 8,
        placeholder: opts.placeholder,
        'aria-label': opts.ariaLabel ?? opts.placeholder,
    });
    if (node) {
        node.value = String(opts.value ?? '');
        // 用 change 而不是 input：提示词很长，每敲一个字就落盘会写爆 settings.json，
        // 而且重画界面会把光标顶掉。失焦时提交是这里正确的粒度。
        on(node, 'change', () => opts.onChange(String(node.value ?? '')));
    }
    return node;
}

/**
 * 复选框。
 * @param {{ checked: boolean, onChange: (v: boolean) => void, title?: string }} opts
 * @returns {any}
 */
export function checkbox(opts) {
    const input = el('input', { type: 'checkbox', class: `${CSS_PREFIX}check`, title: opts.title, 'aria-label': opts.ariaLabel ?? opts.title });
    if (input) {
        input.checked = Boolean(opts.checked);
        on(input, 'change', () => opts.onChange(Boolean(input.checked)));
    }
    return input;
}

/**
 * 数字输入（带范围约束）。
 * @param {{ value: number, min?: number, max?: number, step?: number, onChange: (v: number) => void, width?: number }} opts
 * @returns {any}
 */
export function numberInput(opts) {
    const input = el('input', {
        type: 'number',
        class: `${CSS_PREFIX}input ${CSS_PREFIX}input-num`,
        min: opts.min,
        max: opts.max,
        step: opts.step ?? 1,
        style: { width: `${opts.width ?? 88}px` },
    });
    if (input) {
        input.value = String(opts.value ?? '');
        on(input, 'change', () => {
            const n = Number(input.value);
            opts.onChange(Number.isFinite(n) ? n : Number(opts.value) || 0);
        });
    }
    return input;
}

/**
 * 文本输入。
 * @param {{ value: string, placeholder?: string, onChange: (v: string) => void, onInput?: (v: string) => void, type?: string, width?: number|string }} opts
 * @returns {any}
 */
export function textInput(opts) {
    const input = el('input', {
        type: opts.type ?? 'text',
        class: `${CSS_PREFIX}input`,
        placeholder: opts.placeholder,
        'aria-label': opts.ariaLabel ?? opts.placeholder,
        style: opts.width ? { width: typeof opts.width === 'number' ? `${opts.width}px` : opts.width } : undefined,
    });
    if (input) {
        input.value = String(opts.value ?? '');
        on(input, 'change', () => opts.onChange(String(input.value ?? '')));
        // Live persistence must not invoke a commit callback that rebuilds the DOM.
        on(input, 'input', () => opts.onInput?.(String(input.value ?? '')));
    }
    return input;
}

/**
 * 下拉框。
 * @param {{ value: string, options: Array<{value: string, label: string}>, onChange: (v: string) => void, width?: number|string }} opts
 * @returns {any}
 */
export function select(opts) {
    const node = el('select', {
        class: `${CSS_PREFIX}input ${CSS_PREFIX}select`,
        'aria-label': opts.ariaLabel,
        style: opts.width ? { width: typeof opts.width === 'number' ? `${opts.width}px` : opts.width } : undefined,
    });
    if (node) {
        for (const opt of opts.options ?? []) {
            const o = el('option', { value: opt.value, text: opt.label });
            if (o) node.appendChild(o);
        }
        node.value = String(opts.value ?? '');
        on(node, 'change', () => opts.onChange(String(node.value ?? '')));
    }
    return node;
}

/**
 * 滑块。
 * @param {{ value: number, min: number, max: number, step?: number, onChange: (v: number) => void, format?: (v: number) => string }} opts
 * @returns {any}
 */
export function slider(opts) {
    const readout = el('span', { class: `${CSS_PREFIX}slider-readout`, text: opts.format?.(opts.value) ?? String(opts.value) });
    const input = el('input', {
        type: 'range',
        class: `${CSS_PREFIX}slider`,
        min: opts.min,
        max: opts.max,
        step: opts.step ?? 1,
    });
    if (input) {
        input.value = String(opts.value);
        on(input, 'change', () => {
            const n = Number(input.value);
            readout.textContent = opts.format?.(n) ?? String(n);
            opts.onChange(n);
        });
        on(input, 'input', () => {
            const n = Number(input.value);
            readout.textContent = opts.format?.(n) ?? String(n);
        });
    }
    return el('span', { class: `${CSS_PREFIX}slider-wrap` }, [input, readout]);
}

/** 一行说明文字。 */
export function note(text, type = 'info') {
    return el('p', { class: `${CSS_PREFIX}note`, dataset: { type }, text: String(text) });
}

/** 一个按钮。 */
export function button(label, onClick, opts = {}) {
    const node = el('button', {
        class: `${CSS_PREFIX}btn ${opts.variant ? `${CSS_PREFIX}btn-${opts.variant}` : ''}`,
        type: 'button',
        title: opts.title,
    }, [label]);
    on(node, 'click', (/** @type {any} */ e) => {
        e.preventDefault?.();
        onClick?.(e);
    });
    return node;
}

/** 行内代码块（用于展示原文/JSON）。 */
export function pre(text, maxHeight = 260) {
    return el('pre', {
        class: `${CSS_PREFIX}pre`,
        text: String(text ?? ''),
        style: { maxHeight: `${maxHeight}px` },
    });
}
