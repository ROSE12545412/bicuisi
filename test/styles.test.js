/**
 * 样式覆盖率测试。
 *
 * ── 为什么必须有这个文件（这是一个真实事故的回归测试）
 *
 * 第一版设置面板看起来是「浏览器默认控件的裸拼盘」：系统灰底输入框、
 * 原生复选框、带横向滚动条的 select，在酒馆的暗色主题里非常刺眼，
 * 窄侧栏里还会溢出。
 *
 * 根因不是样式写错了，而是**样式根本不存在**：
 * `src/ui/dom.js` 生成的 class（`bg-input` / `bg-btn` / `bg-check` /
 * `bg-drawer-*` / `bg-slider` …）在 `style.css` 里**一条规则都没有**。
 * 写面板时借用了姊妹项目的 class 命名，却忘了把样式一起移植过来。
 *
 * 这类问题单元测试和冒烟测试都抓不到 —— 它们只检查「class 对不对」，
 * 不检查「这个 class 有没有被样式表定义」。只有人眼把它渲染出来才会发现，
 * 而人眼不一定每次都看。所以这里做自动化：
 *
 *   1. 从 `src/ui/*.js` 里抠出所有 `bg-xxx` class 名
 *   2. 从 `style.css` 里抠出所有被定义过的 `.bg-xxx`
 *   3. 断言前者是后者的子集（用到的必须有样式）
 *   4. 反向也查一遍（定义了却没人用 = 死样式，会让人误以为某处在生效）
 *   5. 单独守住几个「必须显式声明」的性质，例如 `.bg-field` 必须 `display:grid`
 *      —— 只写 `grid-template-columns` 而没有 `display` 是完全无效的，
 *         这个坑实测踩到过（控件被塞进一行并溢出容器）。
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe } from './_harness.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('图片立绘的原色保护规则位于情绪调色规则之后', async () => {
    const css = await readFile(join(ROOT, 'style.css'), 'utf8');
    const guard = css.indexOf('.bg-root[data-emotion] .bg-avatar-img {\n    filter: none;');
    assert.ok(guard > css.lastIndexOf('filter: hue-rotate('));
    assert.ok(guard > css.lastIndexOf('filter: saturate('));
});

/** 读所有 UI 源码。 */
async function readUiSources() {
    const dir = join(ROOT, 'src', 'ui');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
    /** @type {Map<string, string>} */
    const out = new Map();
    for (const f of files) out.set(f, await readFile(join(dir, f), 'utf8'));
    // index.js 也可能直接写 class
    out.set('index.js', await readFile(join(ROOT, 'index.js'), 'utf8'));
    out.set('src/inject.js', await readFile(join(ROOT, 'src/inject.js'), 'utf8'));
    return out;
}

/**
 * 从一个源码文件里抠出用到的 bg- class。
 *
 * 要处理两种写法：
 *   1. 模板串：`` `${CSS_PREFIX}btn-row` `` → `bg-btn-row`
 *   2. 字符串字面量：`'bg-quick-close'`、`class: 'bg-root bg-foo'` → 直接就是名字
 */
/**
 * 从一个源码文件里抠出用到的 bg- class。
 *
 * 只认「明确用作 class」的位置，不扫所有字符串 —— 否则会误报：
 *  - `bg-config` / `bg-now` 是**斜杠命令名**，不是 class
 *  - `bg-hair-glow` / `bg-soft` 是内联 SVG 里的**渐变与滤镜 id**
 * 这两类都长得像 class 名，第一版提取器把它们全当成 class，报了十条假问题。
 *
 * 认这些位置：
 *   1. 模板串：`` `${CSS_PREFIX}xxx` ``
 *   2. `class:` / `className:` 后面跟着的字符串
 *   3. `classList.add/remove/toggle/contains('bg-xxx')`
 *   4. HTML 模板里的 `class="bg-xxx ..."`
 *   5. 查询选择器里的 `.bg-xxx`（用于回查节点）
 */
function extractUsedClasses(source) {
    const names = new Set();
    const add = (/** @type {string} */ raw) => {
        for (const cls of String(raw).split(/\s+/)) {
            // 必须以字母结尾：`bg-btn-` 这种是模板串的前半截（`bg-btn-${variant}`），
            // 不是真实存在的 class 名，收进来会变成假问题
            if (/^bg-[a-z][a-z0-9-]*[a-z0-9]$/.test(cls)) names.add(cls);
        }
    };

    // ① `${CSS_PREFIX}xxx` 形态
    for (const m of source.matchAll(/\$\{CSS_PREFIX\}([a-z][a-z0-9-]*)/g)) add(`bg-${m[1]}`);

    // ② `class: '...'` / `className: '...'`（el() 的属性写法）
    for (const m of source.matchAll(/\bclass(?:Name)?\s*:\s*['"`]([^'"`\n]+)['"`]/g)) add(m[1]);

    // ②b `setAttribute('class', '...')`（原生 DOM 写法）
    for (const m of source.matchAll(/setAttribute\(\s*['"`]class['"`]\s*,\s*['"`]([^'"`\n]+)['"`]/g)) add(m[1]);

    // ③ classList 操作
    for (const m of source.matchAll(/classList\.\w+\(\s*['"`]([^'"`\n]+)['"`]/g)) add(m[1]);

    // ④ HTML 模板里的 class="..."
    for (const m of source.matchAll(/\bclass\s*=\s*\\?["']([^"'\n]+)/g)) add(m[1]);

    // ⑤ 选择器里的 .bg-xxx（节点回查用）
    for (const m of source.matchAll(/\.(bg-[a-z][a-z0-9-]*)/g)) names.add(m[1]);

    // ⑥ `createEl('div', 'bg-avatar')` —— floating.js 自带的建元素助手，
    //     class 是第二个位置参数，不带 `class:` 前缀，所以前面的规则都抓不到
    for (const m of source.matchAll(/createEl\(\s*['"`][^'"`]*['"`]\s*,\s*['"`]([^'"`\n]+)['"`]/g)) add(m[1]);

    return names;
}

/**
 * 抠出**动态拼接**的 class 名。
 *
 * `dom.js` 里的按钮是这样构造 class 的：`` `${CSS_PREFIX}btn-${opts.variant}` ``，
 * 调用方写 `{ variant: 'primary' }`。静态扫描看不到 `bg-btn-primary`
 * 这个字符串，于是会误报成「死样式」。
 *
 * 所以这里额外做一步：发现 `btn-${...}` 这种拼接后，把所有调用点里
 * 对应的取值（`variant: 'xxx'`）收集起来，还原成真实的 class 名。
 *
 * @param {Map<string, string>} sources
 * @returns {Set<string>}
 */
function extractDynamicClasses(sources) {
    const out = new Set();
    const all = [...sources.values()].join('\n');

    // 已知的动态拼接：class 前缀 ←→ 调用点上的属性名
    const PATTERNS = [
        { prefix: 'btn-', prop: 'variant' },
        { prefix: 'note-type-', prop: 'type' },
    ];

    for (const { prefix, prop } of PATTERNS) {
        // 源码里确实存在 `${CSS_PREFIX}${prefix}${...}` 这种拼接吗？
        const concatRe = new RegExp(`\\$\\{CSS_PREFIX\\}${prefix.replace('-', '\\-')}\\$\\{`);
        if (!concatRe.test(all)) continue;

        // 收集所有 `prop: 'value'` 的取值
        const valueRe = new RegExp(`${prop}\\s*:\\s*['"\`]([a-z][a-z0-9-]*)['"\`]`, 'g');
        for (const m of all.matchAll(valueRe)) out.add(`bg-${prefix}${m[1]}`);
    }

    return out;
}

/** 从样式表里抠出所有被定义的 .bg- class。 */
function extractDefinedClasses(css) {
    const names = new Set();
    // 去掉注释，避免注释里的示例 class 被当成定义
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of clean.matchAll(/\.(bg-[a-z][a-z0-9-]*)/g)) names.add(m[1]);
    return names;
}

/**
 * 已知的「故意没有样式」的 class。
 * 每一个都要写清理由 —— 否则这个白名单会变成掩盖问题的垃圾桶。
 */
const ALLOWED_UNSTYLED = new Map([
    ['bg-injected-mes', '独立消息模式的识别标记，沿用酒馆消息样式，无额外视觉规则'],
    // 由 floating.js 动态拼出来的情绪态，样式在 style.css 里是按 [data-emotion] 写的，不是按 class
    ['bg-open', '抽屉箭头的展开态，由 drawer.js 切换；样式写成 .bg-drawer-arrow.bg-open（复合选择器，见下）'],
]);

describe('样式覆盖率 —— 用到的 bg- class 必须有样式', () => {
    test('src/ui/*.js 与 index.js 里用到的每个 bg- class 都在 style.css 里定义了', async () => {
        const [css, sources] = await Promise.all([readFile(join(ROOT, 'style.css'), 'utf8'), readUiSources()]);
        const defined = extractDefinedClasses(css);

        /** @type {string[]} */
        const missing = [];
        for (const [file, source] of sources) {
            for (const cls of extractUsedClasses(source)) {
                if (defined.has(cls)) continue;
                if (ALLOWED_UNSTYLED.has(cls)) continue;
                missing.push(`${cls}（${file}）`);
            }
        }

        assert.deepEqual(
            missing.sort(),
            [],
            `以下 class 被代码使用但样式表里没有定义 —— 界面上会显示成浏览器默认控件：\n  ` +
                missing.sort().join('\n  '),
        );
    });

    test('样式表里定义的 bg- class 都应该有人用（死样式会误导人以为某处在生效）', async () => {
        const [css, sources] = await Promise.all([readFile(join(ROOT, 'style.css'), 'utf8'), readUiSources()]);
        const defined = extractDefinedClasses(css);

        const used = new Set();
        for (const source of sources.values()) {
            for (const cls of extractUsedClasses(source)) used.add(cls);
        }
        // 动态拼出来的也算「有人用」（见 extractDynamicClasses 的说明）
        for (const cls of extractDynamicClasses(sources)) used.add(cls);

        /** 允许「只被 CSS 自己引用」的情况：动画名、被 JS 通过属性而非 class 控制的态 */
        const cssOnlyOk = new Set(['bg-flash', 'bg-float', 'bg-glow-pulse', 'bg-drift', 'bg-bubble-in', 'bg-caret', 'bg-dot-bounce', 'bg-fume']);

        /**
         * 暂时没用上的按钮变体。
         *
         * 这类「预留样式」如果悄悄留着，很容易让人以为某处正在生效 ——
         * 所以要么用起来，要么在这里写明理由。这里两条都有明确用途，
         * 只是当前面板里还没有对应的危险操作 / 图标按钮。
         */
        const reservedVariants = new Set(['bg-btn-ghost', 'bg-btn-danger']);

        const dead = [...defined].filter(
            (c) => !used.has(c) && !cssOnlyOk.has(c) && !reservedVariants.has(c),
        );
        assert.deepEqual(
            dead.sort(),
            [],
            `以下样式定义了但没有任何代码使用（死样式）：\n  ${dead.sort().join('\n  ')}`,
        );
    });

    test('动态拼出来的按钮变体也必须有样式（`bg-btn-${variant}`）', async () => {
        // 单独再守一道：`variant` 是 `bg-btn-${variant}` 拼出来的，静态扫描看不到。
        // 如果样式漏了某个变体，界面上会出现「点了没反应的普通按钮」。
        // 反过来，如果某个变体长期没人用，也应该从 reserv 白名单里清理掉。
        const [css, sources] = await Promise.all([readFile(join(ROOT, 'style.css'), 'utf8'), readUiSources()]);
        const defined = extractDefinedClasses(css);
        const dynamic = extractDynamicClasses(sources);

        assert.ok(dynamic.size > 0, '没有识别到任何动态 class —— 检测逻辑可能失效了（应当至少识别出按钮变体）');
        for (const cls of dynamic) {
            assert.ok(defined.has(cls), `动态拼出的 ${cls} 没有样式定义`);
        }
    });
});

describe('设置区块的组装（参数不匹配会静默炸掉交互）', () => {
    /**
     * 装一个最小 DOM。
     *
     * ⚠️ 必须装：`ui/dom.js` 的 `el()` 在拿不到 `document` 时返回 `null`，
     * 于是区块构造里的 `parent.appendChild(...)` 会抛
     * 「Cannot read properties of null」—— 那是测试环境的问题，
     * 会掩盖我们真正想测的「参数不匹配」。
     */
    function withFakeDom(/** @type {Function} */ fn) {
        const saved = globalThis.document;
        const makeEl = () => {
            /** @type {any} */
            const node = {
                childNodes: [],
                attributes: {},
                dataset: {},
                style: {},
                _listeners: new Map(),
                textContent: '',
                innerHTML: '',
                className: '',
                classList: {
                    _s: new Set(),
                    add(...n) {
                        n.forEach((x) => x && this._s.add(x));
                    },
                    remove(...n) {
                        n.forEach((x) => this._s.delete(x));
                    },
                    toggle(n, f) {
                        const on = f === undefined ? !this._s.has(n) : Boolean(f);
                        if (on) this._s.add(n);
                        else this._s.delete(n);
                        return on;
                    },
                    contains(n) {
                        return this._s.has(n);
                    },
                },
                appendChild(c) {
                    this.childNodes.push(c);
                    return c;
                },
                removeChild(c) {
                    const i = this.childNodes.indexOf(c);
                    if (i >= 0) this.childNodes.splice(i, 1);
                    return c;
                },
                replaceChildren(...c) {
                    this.childNodes = c.filter(Boolean);
                },
                setAttribute(k, v) {
                    this.attributes[k] = String(v);
                },
                getAttribute(k) {
                    return this.attributes[k] ?? null;
                },
                addEventListener(t, h) {
                    if (!this._listeners.has(t)) this._listeners.set(t, new Set());
                    this._listeners.get(t).add(h);
                },
                removeEventListener() {},
                querySelector: () => null,
                querySelectorAll: () => [],
                focus() {},
            };
            return node;
        };
        /** @type {any} */ (globalThis).document = {
            createElement: makeEl,
            createTextNode: (t) => ({ textContent: String(t) }),
            body: makeEl(),
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: () => null,
        };
        try {
            return fn();
        } finally {
            if (saved === undefined) delete /** @type {any} */ (globalThis).document;
            else /** @type {any} */ (globalThis).document = saved;
        }
    }

    test('buildConfigSections 能容忍 rerender 缺失 / 不是函数', async () => {
        // 这里踩过坑：`sectionPersona` 需要 4 个参数（比别的多一个 rerender，
        // 用于增删人设分段后重画列表），调用时却只传了 3 个 ——
        // 于是它内部的 `rerender()` 实际调到了 `commit`，
        // 抛 `rerender is not a function`。异常发生在 onChange 里，
        // 表现成「改人设提示词没反应」。
        //
        // 所以这里用假 app 把整组装流程跑一遍，分别喂 null / 非函数 / 正常函数。
        const { buildConfigSections } = await import('../src/ui/panel.js');
        const { defaultSettings } = await import('../src/config.js');

        withFakeDom(() => {
            for (const rerender of [null, undefined, 'not-a-function', 42, () => {}]) {
                const fakeApp = {
                    settings: defaultSettings(),
                    persistSettings: () => {},
                    log: () => {},
                };

                let sections;
                assert.doesNotThrow(() => {
                    sections = buildConfigSections(fakeApp, /** @type {any} */ (rerender));
                }, `rerender = ${String(rerender)} 时组装抛异常`);

                assert.equal(sections.length, 8, '包括独立书签与日记栏');
                assert.deepEqual(
                    sections.map((s) => s.id),
                    ['llm', 'guide', 'memories', 'lore', 'pool', 'ui', 'persona', 'diag'],
                );
                for (const sec of sections) {
                    assert.ok(Array.isArray(sec.body), `区块 ${sec.id} 的 body 不是数组`);
                    assert.ok(sec.title, `区块 ${sec.id} 缺少标题`);
                    assert.ok(sec.icon, `区块 ${sec.id} 缺少图标`);
                }
            }
        });
    });

    test('人设区块真的渲染出了七条内置分段', async () => {
        const { buildConfigSections } = await import('../src/ui/panel.js');
        const { defaultSettings } = await import('../src/config.js');

        withFakeDom(() => {
            // 假 app 要把区块用到的控制器方法都补上 ——
            // 少一个就会在组装时抛异常，而那和「参数不匹配」是两回事，
            // 会把这个测试的意图搅浑。
            const fakeApp = {
                settings: defaultSettings(),
                persistSettings: () => {},
                log: () => {},
                readHookPool: () => ({
                    ok: false,
                    hooks: [],
                    books: [],
                    character: '测试卡',
                    at: null,
                    source: '',
                    edited: false,
                    fresh: false,
                    note: '还没建立',
                }),
            };

            const sections = buildConfigSections(fakeApp, null);
            const persona = sections.find((s) => s.id === 'persona');
            assert.ok(persona, '找不到人设区块');

            // 数一数 .bg-prompt-item（每条内置分段一个）
            const flatten = (/** @type {any} */ node, out = []) => {
                if (!node) return out;
                out.push(node);
                for (const c of node.childNodes ?? []) flatten(c, out);
                return out;
            };
            const all = persona.body.flatMap((n) => flatten(n));
            const items = all.filter((n) => String(n?.className ?? '').includes('bg-prompt-item'));
            // 七条：identity / personality / speech / timing / guidance / commentary + 一条 assistant 认领
            assert.equal(items.length, 7, `应该渲染出七条内置分段，实际 ${items.length}`);

            // 身份那条要包含「契约精灵」设定
            const texts = all.map((n) => String(n?.textContent ?? '')).join('\n');
            const values = all.map((n) => String(n?.value ?? '')).join('\n');
            assert.match(texts + values, /契约精灵/, '内置人设里应该有「契约精灵」的设定');
        });
    });

    test('引导栏解释每次定位剧情进度，不再提供旧的开关与门槛', async () => {
        // 新管线每次先定位当前进度，再检索事件人物池；界面应解释代价而不是提供无效开关。
        const { buildConfigSections } = await import('../src/ui/panel.js');
        const { defaultSettings } = await import('../src/config.js');

        withFakeDom(() => {
            const makeApp = (over = {}) => ({
                settings: { ...defaultSettings(), ...over },
                persistSettings: () => {},
                log: () => {},
                readHookPool: () => ({ ok: false, hooks: [], books: [], character: '', note: '' }),
            });

            const flatten = (/** @type {any} */ node, out = []) => {
                if (!node) return out;
                out.push(node);
                for (const c of node.childNodes ?? []) flatten(c, out);
                return out;
            };
            const guideText = (/** @type {any} */ app) => {
                const sec = buildConfigSections(app, null).find((s) => s.id === 'guide');
                assert.ok(sec, '找不到引导区块');
                return sec.body
                    .flatMap((n) => flatten(n))
                    .map((n) => `${n?.textContent ?? ''} ${n?.value ?? ''}`)
                    .join('\n');
            };

            for (const locate of ['auto', 'off', 'on']) {
                const settings = defaultSettings();
                settings.guidance.locate = locate;
                const text = guideText(makeApp({ guidance: settings.guidance }));
                assert.match(text, /每次先定位剧情进度，再查事件人物池/);
                assert.match(text, /多一次辅助 API 请求/);
                assert.match(text, /最多挑几条/);
                assert.doesNotMatch(text, /索引够大时才跑|索引超过几条才跑|关掉（整份索引都给她）/);
            }
        });
    });
});
describe('样式覆盖率 —— 几条必须显式声明的性质', () => {
    test('`.bg-field` 必须显式写 display:grid（只写 grid-template-columns 是无效的）', async () => {
        // 实测踩到的坑：`.bg-field` 只有 `grid-template-columns` 而没有 `display: grid`。
        // block 布局下那两列完全不会被使用，于是标签与控件挤在一行并溢出容器。
        // 这个错误**不会报任何错**，只是看起来「样式没生效」。
        const css = await readFile(join(ROOT, 'style.css'), 'utf8');
        const block = css.match(/\.bg-field\s*\{[^}]*\}/);
        assert.ok(block, '找不到 .bg-field 规则');
        assert.match(block[0], /display\s*:\s*grid/, `.bg-field 缺少 display:grid：\n${block[0]}`);
    });

    test('输入类控件都给了暗色底（否则在酒馆暗色主题里会是刺眼的白底）', async () => {
        const css = await readFile(join(ROOT, 'style.css'), 'utf8').then((s) => s.replace(/\/\*[\s\S]*?\*\//g, ''));
        for (const sel of ['.bg-input', '.bg-textarea', '.bg-select']) {
            const block = new RegExp(`\\${sel}[^{]*\\{[^}]*\\}`).exec(css);
            assert.ok(block, `找不到 ${sel} 的规则`);
            // `背景色` 要么写成 background:（简写），要么 background-color:
            assert.match(
                block[0],
                /background(?:-color)?\s*:/,
                `${sel} 没有设置背景色 —— 暗色主题下会是刺眼的白底：\n${block[0]}`,
            );
        }
    });

    test('隐藏态用属性选择器而不是 [hidden]（避免被主题的 display 规则盖掉）', async () => {
        const css = await readFile(join(ROOT, 'style.css'), 'utf8');
        // 设置窗与气泡都用 data-open / data-visible 控制显隐
        assert.match(css, /\.bg-win-overlay\[data-open='1'\]/, '设置窗的显示态没有用 [data-open]');
        assert.match(css, /\.bg-root\[data-visible='off'\]/, '悬浮窗的隐藏态没有用 [data-visible]');
    });

    test('样式表里没有 BOM（BOM 会让部分浏览器丢掉第一条规则）', async () => {
        const buf = await readFile(join(ROOT, 'style.css'));
        const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        assert.equal(hasBom, false, 'style.css 带 BOM');
    });
});
