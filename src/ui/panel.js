/**
 * 碧翠丝的禁书库 / src/ui/panel.js
 * ---------------------------------------------------------------------------
 * 设置界面：**插件自己的设置窗**（点悬浮窗里的贝翠丝 / `/bg-config` 打开）。
 *
 * ── 只剩一个入口，这是刻意的
 *
 * 一开始设置有两处：酒馆「扩展设置」区的侧栏面板 + 插件自己的弹窗，
 * 内容只写一遍（`buildConfigSections`），两个外壳各自排版。
 *
 * 后来用户要求砍掉侧栏那份：
 *   「你把拓展里面的设置界面砍了吧，能通过悬浮窗打开设置就不需要那个了」
 * 理由成立 —— 同一份设置有两个入口，除了让人疑惑「改哪个才生效」之外
 * 没有任何好处，而且侧栏那份要单独维护一套排版（抽屉 vs 标签页）。
 *
 * 现在设置只在这里。`buildConfigSections` 保留「内容与外壳分离」的形状 ——
 * 那是它本身的价值（一段能在没有 DOM 的测试里跑的组装逻辑），
 * 而不只是为了支持多个外壳。
 *
 * ── 结构
 *
 *   buildConfigSections(app, rerender)   六个区块的内容（DOM 节点数组）
 *   createSettingsWindow({app})          带标签页的窗口外壳
 *   sectionLlm / sectionGuide / …        各区块的字段定义
 */

import {
    CADENCE_MODES,
    CODE_REVISION,
    CSS_PREFIX,
    EXT_NAME,
    LLM_MODES,
    formatListInput,
    parseListInput,
} from '../config.js';
import { LlmClient } from '../llm/client.js';
import { isVoid, guideName, modeImageUrl } from '../mode.js';
import {
    BUILTIN_PROMPTS_VERSION,
    defaultPersonaPrompts,
    defaultVoidPersonaPrompts,
    resolvePersonaPrompts,
} from '../prompts.js';
import { formatHooksForPrompt, listAllBooks } from '../worldbook.js';
import {
    button,
    checkbox,
    el,
    field,
    note,
    numberInput,
    on,
    pre,
    select,
    slider,
    textarea,
    textInput,
    toast,
} from './dom.js';

/** 通道模式的中文名。多处用到，集中一份。 */
const MODE_LABELS = {
    profile: '连接配置（推荐）',
    'tavern-helper': '酒馆助手 generateRaw',
    custom: '直连 OpenAI 兼容端点',
    main: '复用当前主连接',
};

/**
 * 模型下拉框里「自定义」那一项的哨兵值。
 *
 * 用一个不可能与真实模型名冲突的字符串，而不是空串 ——
 * 空串在 `select` 里和「没选」无法区分。
 */
export const CUSTOM_MODEL = '__bg_custom_model__';

/** 诊断信息里这些字段的值必须隐藏，避免用户把凭据贴进公开 Issue。 */
const DIAGNOSTIC_SECRET_KEYS = new Set(['key', 'apikey', 'api_key', 'authorization', 'token', 'secret', 'password', 'access_token', 'refresh_token', 'client_secret', 'auth', 'auth_key', 'x_api_key', 'proxy_password']);
const secretKey = (key) => DIAGNOSTIC_SECRET_KEYS.has(String(key).toLowerCase().replace(/[\s-]/g, '_')) || /(?:token|secret|password|api_?key|authorization|auth_?key)$/i.test(String(key));

/**
 * 返回可安全分享的深拷贝，不修改原设置。
 *
 * 使用字段名白名单而不是只处理 `llm.custom.key`，这样导入的前向兼容字段
 * 或将来新增的认证配置也不会意外进入诊断信息。
 *
 * @param {any} value
 * @returns {any}
 */
export function redactDiagnostics(value, known = value) {
    const secrets = new Set();
    const seen = new WeakSet();
    const gather = (item) => {
        if (!item || typeof item !== 'object' || seen.has(item)) return;
        seen.add(item);
        for (const [key, v] of Object.entries(item)) {
            if (secretKey(key) && typeof v === 'string' && v) secrets.add(v);
            if (typeof v === 'string') {
                for (const match of v.matchAll(/[?&]([^=&#\s]+)=([^&#\s]+)/g)) {
                    if (secretKey(match[1])) {
                        secrets.add(match[2]);
                        try { secrets.add(decodeURIComponent(match[2])); } catch { /* malformed URL */ }
                    }
                }
            }
            gather(v);
        }
    };
    gather(known);
    gather(value);
    const clean = (text) => {
        let out = text;
        for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('[REDACTED]');
        return out.replace(/([?&])([^=&#\s]+)=([^&#\s]+)/g, (m, sep, key) => secretKey(key) ? `${sep}${key}=[REDACTED]` : m)
            .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1 [REDACTED]')
            .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization|auth[_-]?key|password)\s*[:=]\s*)[^\s,;"'<>]+/gi, '$1[REDACTED]');
    };
    const visited = new WeakSet();
    const copy = (item) => {
        if (typeof item === 'string') return clean(item);
        if (!item || typeof item !== 'object') return item;
        if (visited.has(item)) return '[Circular]';
        visited.add(item);
        const out = Array.isArray(item) ? [] : {};
        for (const [key, v] of Object.entries(item)) out[key] = secretKey(key) ? '[REDACTED]' : copy(v);
        return out;
    };
    return copy(value);
}

/**
 * 算出模型下拉框该有哪些选项、该选中哪一个。
 *
 * 抽成纯函数是为了能测：这里有三个容易错的分支 ——
 *   1. 还没拉取过（列表为空）
 *   2. 当前模型在列表里（正常选中它）
 *   3. **当前模型不在列表里**（手填的、或换了端点）——
 *      这时不能把它悄悄丢掉。否则用户会看到下拉框"自己变了"，
 *      而他设置的模型其实还在生效，两边对不上。
 *
 * 另外永远追加一个「（自定义…）」出口：有些端点不提供 `/models`，
 * 只给下拉框会把「手填」这条路堵死。
 *
 * @param {string[]} models 拉到的模型列表
 * @param {string} current 当前生效的模型名
 * @returns {{values: string[], labels: string[], selected: string}}
 */
export function planModelOptions(models, current) {
    const list = Array.isArray(models) ? models.filter(Boolean) : [];
    const cur = String(current ?? '').trim();

    /** @type {string[]} */
    const values = [];
    /** @type {string[]} */
    const labels = [];

    if (!list.length) {
        // 还没拉取过：只放当前值（或提示）+ 自定义出口
        values.push(cur);
        labels.push(cur || '（点右边「拉取模型」）');
        values.push(CUSTOM_MODEL);
        labels.push('（自定义…）');
        return { values, labels, selected: cur };
    }

    for (const m of list) {
        values.push(m);
        labels.push(m);
    }
    // 当前模型不在列表里 → 额外补一项，避免被无声丢掉
    if (cur && !list.includes(cur)) {
        values.push(cur);
        labels.push(`（当前）${cur}`);
    }
    values.push(CUSTOM_MODEL);
    labels.push('（自定义…）');

    return { values, labels, selected: cur || list[0] };
}

/** 每种通道模式的一句话说明。 */
function modeHint(/** @type {string} */ mode) {
    switch (mode) {
        case 'profile':
            return '复用你已存好的连接配置，不用重复填 Key。TauriTavern 一定支持这条。';
        case 'tavern-helper':
            return '功能最强（支持 JSON Schema 强约束），但需要先装「酒馆助手 / JS-Slash-Runner」扩展。';
        case 'custom':
            return '自己填 URL / Key / Model，不依赖其它扩展。注意可能被 WebView 的域名策略拦截。';
        case 'main':
            return '直接用正文那个模型，会被当前预设和上下文影响，只作兜底。';
        default:
            return '';
    }
}

// ===========================================================================
// 一、设置内容（两个外壳共用）
// ===========================================================================

/**
 * 构造全部设置区块。
 *
 * @param {any} app GuideController
 * @param {() => void} rerender 改完设置后重画当前外壳
 * @returns {Array<{id: string, title: string, icon: string, body: any[]}>}
 */
export function buildConfigSections(app, rerender, recap = { spoilers: false, clearArmed: false }) {
    const s = app.settings;
    // 兜一层：外部调用方（测试、或将来别的宿主）可能不传 rerender。
    // 不兜的话「改一个设置」会直接抛 `rerender is not a function`，
    // 而异常发生在 onChange 里，表现成「点了没反应」——很难查。
    const safeRerender = typeof rerender === 'function' ? rerender : () => {};

    /** 改完设置统一走这里：落盘 + 记日志 + 重画。 */
    const commit = (/** @type {string} */ what) => {
        app.persistSettings();
        app.log(`设置已更新：${what}`);
        safeRerender();
    };

    // ⚠️ 每个 section 的参数表必须和它的签名对齐。
    // 这里踩过坑：`sectionPersona` 需要 4 个参数（多一个 rerender，用于
    // 增删分段后重画列表），调用时却只传了 3 个 —— 于是它内部的
    // `rerender()` 实际调到了 `commit`，抛 `rerender is not a function`。
    const lazy = (id, icon, title, build) => {
        let body;
        return { id, icon, title, get body() { return body ??= build(); } };
    };
    return [
        lazy('llm', '🔌', '辅助 API', () => sectionLlm(app, s, commit, safeRerender, recap)),
        lazy('guide', '🎯', '引导与吐槽', () => sectionGuide(app, s, commit)),
        ...(isVoid(s) ? [lazy('adversary', '♟', '人神对抗', () => sectionAdversary(app, s, safeRerender, recap))] : []),
        lazy('memories', '📚', '书签与日记', () => sectionMemories(app, recap)),
        lazy('lore', '📖', '世界书线索', () => sectionLore(app, s, commit)),
        lazy('pool', '🗂', '线索池', () => sectionPool(app, s, commit, safeRerender)),
        lazy('ui', '🪟', '外观', () => sectionUi(app, s, commit)),
        lazy('persona', '🧙', '人设', () => sectionPersona(app, s, commit, safeRerender)),
        lazy('diag', '🧪', '诊断', () => sectionDiag(app)),
    ];
}

// ---------------------------------------------------------------------------
// 区块 1：辅助 API（用户最关心的一块，所以放第一个）
// ---------------------------------------------------------------------------

function sectionLlm(/** @type {any} */ app, /** @type {any} */ s, /** @type {Function} */ commit, /** @type {Function} */ rerender, lifecycle) {
    let request = 0;
    const epoch = lifecycle.epoch;
    const fingerprint = () => JSON.stringify(app.settings?.llm);
    const isCurrent = (id, config, node) => id === request && !app.abort?.signal?.aborted && lifecycle.epoch === epoch && fingerprint() === config && node?.isConnected !== false;
    const probe = LlmClient.probe(app.ctx);
    const profiles = probe.profiles;
    const body = [];

    body.push(
        field({
            label: '通道模式',
            hint: modeHint(s.llm.mode),
            control: select({
                value: s.llm.mode,
                options: LLM_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] ?? m })),
                width: 250,
                onChange: (v) => {
                    s.llm.mode = v;
                    commit(`通道模式 → ${MODE_LABELS[v] ?? v}`);
                    rerender();
                },
            }),
        }),
    );

    // 环境探测：把「装了什么」直接摊开，省掉一半排查时间
    body.push(
        el('div', { class: `${CSS_PREFIX}probe` }, [
            note(
                `酒馆助手（JS-Slash-Runner）：${probe.tavernHelper ? '✅ 已安装' : '❌ 未检测到'}`,
                probe.tavernHelper ? 'ok' : 'warn',
            ),
            note(
                `连接配置服务：${probe.profileService ? '✅ 可用' : '❌ 不可用'}`,
                probe.profileService ? 'ok' : 'warn',
            ),
            note(`连接配置数量：${profiles.length} 个`),
        ]),
    );

    if (s.llm.mode === 'profile') {
        if (!profiles.length) {
            body.push(
                note(
                    '没有找到任何连接配置。请到酒馆的「连接配置」里新建一个 —— 可以直接用你正文那个，也可以单独建一个便宜快速的模型给贝翠丝用（她每 2 轮就要调一次）。',
                    'warn',
                ),
            );
        } else {
            body.push(
                field({
                    label: '使用哪个配置',
                    hint: '建议单独建一个便宜快速的配置。',
                    control: select({
                        value: s.llm.profileId,
                        options: [
                            { value: '', label: '（未选择）' },
                            ...profiles.map((p) => ({ value: p.id, label: p.name })),
                        ],
                        width: 250,
                        onChange: (v) => {
                            s.llm.profileId = v;
                            const name = profiles.find((p) => p.id === v)?.name ?? '（清空）';
                            commit(`连接配置 → ${name}`);
                        },
                    }),
                }),
            );
        }
    }

    if (s.llm.mode === 'custom' || s.llm.mode === 'tavern-helper') {
        // ── API 地址 / Key ──────────────────────────────────────────────
        for (const [key, label, placeholder, type, hint] of [
            ['url', 'API 地址', 'https://api.deepseek.com/v1', 'text', 'OpenAI 兼容端点。酒馆助手模式留空则复用主连接。'],
            ['key', 'API Key', 'sk-…', 'password', ''],
        ]) {
            body.push(
                field({
                    label,
                    hint,
                    wide: true,
                    control: textInput({
                        value: s.llm.custom?.[key] ?? '',
                        placeholder,
                        type,
                        width: '100%',
                        onInput: key === 'key' ? (v) => { ++request; lifecycle.cancel?.(); s.llm.custom[key] = v; app.persistSettings(); } : undefined,
                        onChange: (v) => {
                            s.llm.custom[key] = v;
                            commit(label);
                        },
                    }),
                }),
            );
        }

        // ── 模型：一个下拉框，拉取后可选 ───────────────────────────────
        //
        // 用户反馈：「拉取模型做的不对，应该有下拉框让我选择模型」。
        // 第一版是「拉取按钮 + 下拉框 + 另一个手打输入框」三个控件并排，
        // 结果是两个控件抢同一个值、互相不同步，用户也不知道该看哪个。
        //
        // 现在：**一个下拉框就是选模型的地方**。
        //  - 拉取之前：只有「（点右边拉取模型）」一项
        //  - 拉取之后：列出所有模型，自动选中当前生效的那个
        //  - 当前模型不在列表里（手填的 / 自定义部署名）→ 补一项「（当前）xxx」，
        //    不会被拉取动作悄悄冲掉
        //  - 选了「（自定义…）」才露出一个手填框 —— 既保证了「下拉选择」是主路径，
        //    又没把「端点不提供 /models」这条路堵死
        const modelOut = el('div', { class: `${CSS_PREFIX}preview` });
        /** 拉到的模型缓存。跨重画保留，这样改别的设置不会把列表清空。 */
        const modelCache = Array.isArray(s.llm.custom?.modelList) ? s.llm.custom.modelList.slice() : [];

        // ⚠️ 声明顺序在这里是**功能正确性**问题，不是风格问题。
        //
        // 最初的写法把 `fillModelOptions` 定义在 `customInput` 之前、并在里面直接
        // 引用 `customInput`，同时又在 `customInput` 之前就调用了它 —— 那是
        // **暂时性死区（TDZ）**：`Cannot access 'customInput' before initialization`。
        // 后果是 `createSettingsWindow` 整个抛异常，被 index.js 的 try/catch 兜住，
        // 表现成「点头像完全打不开设置窗」。冒烟测试用的是假 DOM，没暴露出来，
        // 是浏览器验收时才抓到的。
        //
        // 所以这里刻意按「被引用者先声明」的顺序排：
        //   customInput → customField → modelSelect → fillModelOptions 的定义与调用

        // ── 自定义模型名（默认收起，选了「（自定义…）」才出现） ─────────
        const customInput = textInput({
            value: String(s.llm.custom?.model ?? ''),
            placeholder: '手打模型名，例如 deepseek-chat',
            width: '100%',
            onChange: (v) => {
                s.llm.custom.model = v;
                commit(`模型（自定义）→ ${v}`);
            },
        });
        const customField = field({
            label: '自定义模型名',
            hint: '填完点别处让它失焦即可生效。',
            wide: true,
            control: customInput,
        });
        customField.style.display = 'none';

        /** 重画下拉框的选项。 */
        const fillModelOptions = (/** @type {string[]} */ models) => {
            const current = String(s.llm.custom?.model ?? '').trim();
            const plan = planModelOptions(models, current);

            modelSelect.replaceChildren?.();
            plan.values.forEach((v, i) => {
                modelSelect.appendChild(el('option', { value: v, text: plan.labels[i] }));
            });
            modelSelect.value = plan.selected;
            customInput.value = current;
        };

        const modelSelect = select({
            value: String(s.llm.custom?.model ?? ''),
            options: [],
            width: '100%',
            onChange: (v) => {
                if (v === CUSTOM_MODEL) {
                    // 切到自定义：露出输入框并把焦点给它
                    customField.style.display = '';
                    try {
                        customInput.focus?.();
                    } catch {
                        /* ignore */
                    }
                    return;
                }
                customField.style.display = 'none';
                s.llm.custom.model = v;
                commit(`模型 → ${v}`);
            },
        });
        fillModelOptions(modelCache);

        const pullBtn = button(
            '🔄 拉取模型',
            async () => {
                const url = String(s.llm.custom?.url ?? '').trim();
                if (!url) {
                    modelOut.replaceChildren?.(note('先填上面的 API 地址。', 'warn'));
                    return;
                }
                modelOut.replaceChildren?.(note('正在请求 /models…'));
                const id = ++request;
                const config = fingerprint();
                const controller = new AbortController();
                lifecycle.cancel?.();
                lifecycle.cancel = () => controller.abort();
                let res;
                try {
                    res = await LlmClient.fetchModels({ apiUrl: url, apiKey: s.llm.custom?.key, signal: controller.signal });
                } catch (e) {
                    if (!isCurrent(id, config, modelOut) || controller.signal.aborted || e?.name === 'AbortError') return;
                    res = { ok: false, error: String(e?.message ?? e) };
                }
                if (!isCurrent(id, config, modelOut) || controller.signal.aborted || res?.aborted || res?.cancelled || res?.canceled) return;
                if (!res?.ok) {
                    modelOut.replaceChildren?.(
                        note(
                            [
                                `拉取失败：${res.error}`,
                                `端点：${res.endpoint ?? ''}`,
                                '',
                                '拉不到也没关系 —— 直接在上面的下拉框里手打模型名也能用：',
                                '点开下拉框 → 输入框里敲名字 → 回车（有些浏览器要在下拉里选「自定义」）。',
                                '更稳妥的办法：在酒馆「连接配置」里建一个带模型的配置，改用「连接配置」通道。',
                            ].join('\n'),
                            'error',
                        ),
                    );
                    return;
                }

                // 存进设置，跨重画保留
                s.llm.custom.modelList = res.models;
                fillModelOptions(res.models);

                // 选中「当前已是这个模型」；没有当前值就选第一个并落盘
                const current = String(s.llm.custom?.model ?? '').trim();
                const chosen = current || res.models[0] || '';
                modelSelect.value = chosen;
                s.llm.custom.model = chosen;

                modelOut.replaceChildren?.(
                    note(`✅ 拉到 ${res.models.length} 个模型，已选中「${chosen}」，也可以在下拉框里换别的。`, 'ok'),
                );
                commit(`拉取模型 → 选中 ${chosen}`);
            },
            { variant: 'primary' },
        );

        body.push(
            field({
                label: '模型',
                hint: modelCache.length
                    ? `已拉到 ${modelCache.length} 个模型，点开下拉框选择。`
                    : '点右边的「拉取模型」把列表拉下来，然后在这里选。',
                wide: true,
                control: el('div', { class: `${CSS_PREFIX}row-inline` }, [modelSelect, pullBtn]),
            }),
            customField,
            modelOut,
        );
    }

    if (s.llm.mode === 'main') {
        body.push(note('复用当前主连接 —— 最省事，但你的预设、越狱、上下文都会影响她说话的风格。'));
    }

    body.push(
        field({
            label: '温度',
            hint: '高一点更有性格。贝翠丝要毒舌，别调太低。',
            control: numberInput({
                value: s.llm.temperature,
                min: 0,
                max: 2,
                step: 0.1,
                onChange: (v) => {
                    s.llm.temperature = v;
                    commit('温度');
                },
            }),
        }),
        // token 上限太低会把 JSON 截断 —— 用户实测踩到过（现象是气泡里只有半句话、
        // 正文末尾也没有引导）。所以在设置里直接把警告摆出来，而不是等他撞上再排查。
        Number(s.llm.maxTokens) < 600
            ? note(
                  `现在只给了 ${s.llm.maxTokens} token。这个额度**可能不够**输出完整的 JSON ——` +
                      '被截断时的表现就是「气泡里只有半句话、正文末尾也没有引导」。建议 800~1500。',
                  'warn',
              )
            : note(''),
        field({
            label: '最多输出 token',
            hint: '要装下引导 + 吐槽两个字段的 JSON，建议 800~1500。太小会被截断。',
            control: numberInput({
                value: s.llm.maxTokens,
                min: 32,
                max: 8192,
                step: 32,
                onChange: (v) => {
                    s.llm.maxTokens = v;
                    commit('最大 token');
                },
            }),
        }),
        field({
            label: '超时（毫秒）',
            control: numberInput({
                value: s.llm.timeoutMs,
                min: 3000,
                max: 300000,
                step: 1000,
                width: 110,
                onChange: (v) => {
                    s.llm.timeoutMs = v;
                    commit('超时');
                },
            }),
        }),
    );

    // 现场测试：连接 + 出话格式，一次验完
    const testOut = el('div', { class: `${CSS_PREFIX}preview` });
    body.push(
        el('div', { class: `${CSS_PREFIX}btn-row` }, [
            button(
                '🔌 测试连接',
                async () => {
                    const status = app.channelStatus();
                    if (!status.ready) {
                        testOut.replaceChildren?.(note(status.reason, 'warn'));
                        return;
                    }
                    testOut.replaceChildren?.(note('正在连接辅助 API…'));
                    const id = ++request;
                    const config = fingerprint();
                    try {
                        const client = new LlmClient(app.ctx, JSON.parse(config), '辅助 API 连接测试');
                        const response = await client.complete({
                            system: '这是独立连接测试。不要观察剧情或调用工具，只用一句中文回复：连接成功。',
                            user: '请确认你能正常返回最终回答。',
                            maxTokens: 1024,
                            temperature: 0,
                        });
                        const outcome = response.ok ? { ...response, result: { guidance: '', commentary: response.text, emotion: 'calm', hooks_used: [] } } : response;
                        if (!isCurrent(id, config, testOut) || outcome?.aborted || outcome?.cancelled || outcome?.canceled || outcome?.stale) return;
                        if (!outcome?.ok) {
                            testOut.replaceChildren?.(
                                note(
                                    [
                                        `❌ 连接失败：${outcome?.error ?? '未知原因'}`,
                                        `通道：${outcome?.meta?.mode ?? '?'}`,
                                        ...(outcome?.notes ?? []).map((n) => `提示：${n}`),
                                        '',
                                        '常见原因：Key 不对 / 模型名写错 / 地址填错 / 该端点不支持 JSON 输出。',
                                    ].join('\n'),
                                    'error',
                                ),
                            );
                            return;
                        }
                        testOut.replaceChildren?.(
                            note(
                                [
                                    '✅ 连接正常，模型返回了最终回答：',
                                    `　回答：${outcome.result.commentary || '（空）'}`,
                                    `　通道：${outcome.meta?.mode ?? s.llm.mode}`,
                                    '本测试不读取剧情，不推进阴谋，不写入正文或日记。',
                                    ...(outcome.notes ?? []).map((n) => `　提示：${n}`),
                                ].join('\n'),
                                'ok',
                            ),
                        );
                        // Connection tests deliberately have no story or floating-bubble side effects.
                    } catch (e) {
                        if (!isCurrent(id, config, testOut) || e?.name === 'AbortError') return;
                        testOut.replaceChildren?.(note(`异常：${e?.message ?? e}`, 'error'));
                    }
                },
                { variant: 'primary' },
            ),
        ]),
        testOut,
    );

    return body;
}

// ---------------------------------------------------------------------------
// 区块 2：引导与吐槽
// ---------------------------------------------------------------------------

function sectionGuide(/** @type {any} */ app, /** @type {any} */ s, /** @type {Function} */ commit) {
    const cadenceLabels = {
        'every-n': '每 N 轮引导一次',
        probability: '每轮按概率决定',
        always: '每轮都引导',
    };

    const body = [
        field({
            label: '引导',
            hint: '「今天该往哪走」的暗示。',
            control: checkbox({
                checked: s.guidance.enabled,
                onChange: (v) => {
                    s.guidance.enabled = v;
                    commit('引导开关');
                },
            }),
        }),
        field({
            label: '吐槽',
            hint: '针对你的行为发表刻薄评论。',
            control: checkbox({
                checked: s.commentary.enabled,
                onChange: (v) => {
                    s.commentary.enabled = v;
                    commit('吐槽开关');
                },
            }),
        }),
        field({
            label: '引导字数上限',
            hint: '一句话最好控制在 60 字内，长了就不像随口一提。',
            control: numberInput({
                value: s.guidance.maxChars,
                min: 10,
                max: 400,
                onChange: (v) => {
                    s.guidance.maxChars = v;
                    commit('引导字数');
                },
            }),
        }),
        field({
            label: '吐槽字数上限',
            control: numberInput({
                value: s.commentary.maxChars,
                min: 5,
                max: 400,
                onChange: (v) => {
                    s.commentary.maxChars = v;
                    commit('吐槽字数');
                },
            }),
        }),
        field({
            label: '只给暗示、不点名目的地',
            hint: '建议保持开启。关掉后她会直接说「去某地」，推进快但很出戏。',
            control: checkbox({
                checked: s.guidance.hintOnly,
                onChange: (v) => {
                    s.guidance.hintOnly = v;
                    commit('hintOnly');
                },
            }),
        }),
        el('hr', { class: `${CSS_PREFIX}sep` }),
        field({
            label: '出声节奏',
            control: select({
                value: s.cadence.mode,
                options: CADENCE_MODES.map((m) => ({ value: m, label: cadenceLabels[m] ?? m })),
                width: 200,
                onChange: (v) => {
                    s.cadence.mode = v;
                    commit('节奏模式');
                },
            }),
        }),
    ];

    if (s.cadence.mode === 'every-n') {
        body.push(
            field({
                label: 'N = 每几轮',
                hint: '默认 2。设 1 等于每轮都说话，容易烦。',
                control: slider({
                    value: s.cadence.everyN,
                    min: 1,
                    max: 10,
                    onChange: (v) => {
                        s.cadence.everyN = v;
                        commit('everyN');
                    },
                }),
            }),
        );
    }
    if (s.cadence.mode === 'probability') {
        body.push(
            field({
                label: '每轮出声概率',
                control: slider({
                    value: s.cadence.probability,
                    min: 0,
                    max: 1,
                    step: 0.05,
                    format: (v) => `${Math.round(v * 100)}%`,
                    onChange: (v) => {
                        s.cadence.probability = v;
                        commit('probability');
                    },
                }),
            }),
        );
    }

    body.push(
        field({
            label: '最短间隔（毫秒）',
            hint: '防止你连点发送时她疯狂插嘴。',
            control: numberInput({
                value: s.cadence.cooldownMs,
                min: 0,
                max: 600000,
                step: 1000,
                width: 110,
                onChange: (v) => {
                    s.cadence.cooldownMs = v;
                    commit('冷却');
                },
            }),
        }),
        el('hr', { class: `${CSS_PREFIX}sep` }),
        field({
            label: '引导怎么呈现',
            hint: '默认接在正文末尾，像她突然插话。正文本身一个字节都不会被改动。',
            control: select({
                value: s.injection.mode === 'appended' ? 'message' : s.injection.mode,
                options: [
                    { value: 'append', label: '接在正文末尾（推荐）' },
                    { value: 'message', label: '作为一条独立小字消息' },
                    { value: 'off', label: '不写进聊天，只走气泡' },
                ],
                width: 210,
                onChange: (v) => {
                    s.injection.mode = v;
                    commit(`呈现方式 → ${v}`);
                },
            }),
        }),
        field({
            label: '名字前缀',
            hint: '接在正文里时显示成「贝翠丝：…」。',
            control: textInput({
                value: s.injection.speakerName,
                width: 160,
                onChange: (v) => {
                    s.injection.speakerName = v;
                    commit('名字前缀');
                },
            }),
        }),
        el('hr', { class: `${CSS_PREFIX}sep` }),
        note('每次先定位剧情进度，再查事件人物池：从线索池选择相关的未来事件和出场人物，取回原文用于引导。定位会多一次辅助 API 请求。'),
    );

    {
        body.push(
            field({
                label: '最多挑几条',
                hint: '默认 4。挑太多会让提示词变胖，而且她容易抓不住重点。',
                control: numberInput({
                    value: s.guidance.locateMaxPick,
                    min: 1,
                    max: 30,
                    width: 110,
                    onChange: (v) => {
                        s.guidance.locateMaxPick = v;
                        commit('定位挑几条');
                    },
                }),
            }),
        );
    }

    return body;
}

/** 历史记录只渲染安全摘要；原始来源与证据必须由当前窗口明确揭示。 */
function sectionMemories(app, view) {
    const host = el('div', { class: `${CSS_PREFIX}memories` });
    if (!host) return [];
    const feedback = el('div', { role: 'status', 'aria-live': 'polite' });
    const list = el('div');
    const epoch = view.epoch;
    const alive = () => view.epoch === epoch && host.isConnected !== false;
    const plain = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
    const run = async task => {
        try { await task(); if (alive()) draw(); }
        catch (error) { if (alive()) feedback.replaceChildren(note(`操作失败：${error?.message ?? error}`, 'error')); }
    };
    const confirmDelete = async (key, label, task) => {
        // Always two explicit clicks, also in hosts without a native confirm dialog.
        if (view.memoryDelete !== key) {
            view.memoryDelete = key;
            feedback.replaceChildren(note(`此操作不能撤销。再次点击「${label}」确认；可点击取消或关闭窗口。`, 'warn'),
                button('取消删除', () => { view.memoryDelete = null; feedback.replaceChildren(); }));
            return;
        }
        view.memoryDelete = null;
        await run(async () => {
            const ok = await task();
            if (ok === false) throw new Error('记录未删除，请刷新后重试。');
            if (alive()) feedback.replaceChildren(note('已删除所选记录。', 'ok'));
        });
    };
    const draw = () => {
        const state = app.memoryState?.();
        const entries = Array.isArray(state?.reminders) ? state.reminders : [];
        const diary = Array.isArray(state?.diary) ? state.diary : [];
        const content = [el('h4', { text: '历史提醒 · 碧翠丝 / 人神' }),
            note('这里只显示已说出的提醒和已确认的行动结果，不自动揭示未来线索、隐藏阴谋或原始证据。书签不会改变角色人设。')];
        if (!state) content.push(note('当前宿主尚未提供记忆接口。', 'warn'));
        content.push(field({ label: '只看已加书签的提醒', control: checkbox({ checked: view.bookmarkedOnly === true,
            onChange: v => { view.bookmarkedOnly = v; draw(); } }) }));
        content.push(field({ label: '显示提醒原始来源（可能剧透，仅本窗口）', control: checkbox({ checked: view.memorySources === true,
            onChange: v => { view.memorySources = v; draw(); } }) }));
        const visible = entries.filter(entry => !view.bookmarkedOnly || entry.bookmarked === true);
        if (!visible.length) content.push(note('暂无符合筛选条件的历史提醒。'));
        for (const entry of visible) {
            const row = el('div', { class: `${CSS_PREFIX}preview` }, [
                note(`${entry.realm === 'void' || entry.mode === 'void' ? '人神' : '碧翠丝'} · 第 ${entry.index ?? '?'} 轮`),
                pre([entry.guidance, entry.commentary].filter(Boolean).join('\n') || '（空提醒）'),
                button(entry.bookmarked ? '★ 取消书签' : '☆ 加为重要书签', () => run(async () => {
                    if (typeof app.toggleBookmark !== 'function') throw new Error('当前宿主没有提供书签接口。');
                    await app.toggleBookmark(entry.id); // false means successfully unbookmarked, not failure.
                })),
            ]);
            if (view.memorySources) {
                const sourceHost = el('div');
                let expanded = false;
                row.appendChild(button('展开 / 收起此条原始来源', () => {
                    expanded = !expanded;
                    sourceHost.replaceChildren(...(expanded ? [pre(plain(entry.sources)), ...(entry.located ? [pre(plain(entry.located))] : [])] : []));
                }));
                row.appendChild(sourceHost);
            }
            content.push(row);
        }
        content.push(el('h4', { text: '共同日记 · 已确认的行动与结果' }));
        if (!diary.length) content.push(note('暂无已确认的共同日记。'));
        for (const entry of diary) {
            const evidenceHost = el('div');
            let expanded = false;
            const label = '移除 / 忘记这条日记';
            content.push(el('div', { class: `${CSS_PREFIX}preview` }, [
                pre([entry.actor ? `行动者：${entry.actor}` : '', entry.action ? `行动：${entry.action}` : '',
                    entry.result ? `结果：${entry.result}` : '', entry.text ?? ''].filter(Boolean).join('\n')),
                button('展开 / 收起原始证据', () => {
                    expanded = !expanded;
                    evidenceHost.replaceChildren(...(expanded ? [pre(plain(entry.evidence) || '（无原始证据）')] : []));
                }), evidenceHost,
                button(label, () => confirmDelete(`diary:${entry.id}`, label, () => {
                    if (typeof app.forgetDiary !== 'function') throw new Error('当前宿主没有提供忘记接口。');
                    return app.forgetDiary(entry.id);
                })),
            ]));
        }
        for (const [kind, label] of [['bookmarks', '清空重要书签'], ['diary', '清空共同日记'], ['all', '清空全部提醒与日记']]) {
            content.push(button(label, () => confirmDelete(`clear:${kind}`, label, () => {
                if (typeof app.clearMemories !== 'function') throw new Error('当前宿主没有提供清空接口。');
                return app.clearMemories(kind);
            })));
        }
        list.replaceChildren(...content);
    };
    host.appendChild(list);
    host.appendChild(feedback);
    draw();
    return [host];
}

/** 对抗设置不改人设或 API；复盘内容只在用户明确选择剧透后进入 DOM。 */
function sectionAdversary(app, s, rerender, recap) {
    const settings = s.adversary ?? { enabled: false, allowDeath: false, maxPlots: 3 };
    const host = el('div', { class: `${CSS_PREFIX}adversary` });
    if (!host) return [];
    const feedback = el('div');
    const update = async (key, value) => {
        s.adversary = { ...(s.adversary ?? settings), [key]: value };
        await app.persistSettings();
        await app.syncAdversaryDirector?.();
        app.log?.(`设置已更新：人神对抗 ${key}`);
        rerender();
    };
    const drawRecap = () => {
        const content = [note('隐藏阴谋与审计默认不展示；开启剧透仅限当前设置窗口，不会保存。')];
        if (recap.spoilers) {
            const state = app.adversaryState?.();
            content.push(state
                ? pre(JSON.stringify({ plots: state.plots ?? [], audit: state.audit ?? [] }, null, 2))
                : note('当前宿主没有提供对抗复盘。', 'warn'));
        } else {
            content.push(note('隐藏阴谋未揭示。'));
        }
        recapHost.replaceChildren(...content);
    };
    const status = app.adversaryDirectorStatus?.();
    const recapHost = el('div', { class: `${CSS_PREFIX}adversary-recap` });
    host.appendChild(el('h4', { text: '可选的人神对抗模式' }));
    host.appendChild(note('仅在无之空间生效。默认关闭，不改变碧翠丝。人神公开引导接入正文、吐槽进入气泡、计划私有保存。真话建立信任，误导诱入剧情圈套；被识破可以辩解，但不得篡改既定事实或替用户行动。'));
    const stage = app.state?.().adversaryStage;
    host.appendChild(note(stage ? `最近处理阶段：${stage.stage} · 正文 #${stage.targetIndex}` : '尚未记录对抗请求阶段；生成正文后查看诊断日志，或长按头像重新观测。'));
    host.appendChild(note('开启前必须先导入「人神对抗规则」世界书，并挂载到当前角色卡或聊天；条目保持启用与常驻。只在插件里勾选世界书供辅助 API 读取，不等于挂载给正文模型。插件不自动挂载，也不自动验证是否挂载成功。退出对抗后建议取消挂载。', 'warn'));
    host.appendChild(field({
        label: '启用人神对抗模式',
        control: checkbox({ checked: settings.enabled === true, onChange: v => update('enabled', v) }),
    }));
    host.appendChild(field({
        label: '允许虚构剧情中的致死结局（角色死亡）',
        hint: '默认不允许。仅指故事内的虚构致死结果，开启也不允许无预兆、不可反制的判死。',
        control: checkbox({ checked: settings.allowDeath === true, onChange: v => update('allowDeath', v) }),
    }));
    host.appendChild(field({
        label: '最多保留的阴谋',
        hint: '1～3 条；每次最多一次实质推进。',
        control: numberInput({ value: settings.maxPlots, min: 1, max: 3, onChange: v => update('maxPlots', Math.min(3, Math.max(1, Math.round(Number(v)) || 3))) }),
    }));
    host.appendChild(note('对抗规则：每轮最多推进一步。线索自然融入当前剧情，不硬转场、不刻意预警；事后可回溯，前期留真实反制机会。最终引爆按既定证据严格结算，禁止临时补设定和口头翻案；有依据的防御仍有效。允许死亡且条件成立后，死了就是死了。不能凭隐藏计划直接判死。'));
    host.appendChild(status?.supported
        ? note('当前宿主支持导演提示注入；关闭对抗或返回碧翠丝时会立即清除对抗提示。', 'ok')
        : note(`当前宿主导演注入不可用：${status?.reason || '未提供导演注入接口'}。不能保证正文模型执行对抗安排。`, 'warn'));
    const endedHost = el('div', { class: `${CSS_PREFIX}ended-recap` });
    const drawEnded = () => {
        if (!recap.endedSpoilers) {
            endedHost.replaceChildren(note('已结束阴谋的因果复盘未揭示；进行中的阴谋始终不会进入此复盘。'));
            return;
        }
        const report = app.causalRecap?.({ spoilers: true });
        if (!report || report.locked) {
            endedHost.replaceChildren(note('当前宿主没有提供可查看的已结束因果复盘。', 'warn'));
            return;
        }
        const plots = (Array.isArray(report.plots) ? report.plots : []).filter(plot => ['failed', 'resolved', 'dead'].includes(plot.stage));
        const rows = [note(`已结束阴谋：${plots.length} 条。进行中的秘密不在此展示。`)];
        // Render the terminal-only contract as readable text, never active secret JSON.
        for (const plot of plots) {
            const labels = { objective: '原始目的（计划，不等于已发生）', trace: '伏笔 / 证据', opportunity: '用户回应机会（不代表反制成功）', result: '最终结果', missing: '缺失的记录（不补造因果）' };
            rows.push(el('h4', { text: `阴谋 ${plot.id ?? ''} · ${plot.stage}` }));
            for (const step of (Array.isArray(plot.history) ? plot.history : [])) {
                rows.push(note(`第 ${step.index} 楼：${step.from} → ${step.to}`));
                for (const cause of (step.causes ?? [])) rows.push(note(`前置事实 ${cause.factId}：${cause.actor} · ${cause.action}；${cause.result}`));
                for (const result of (step.results ?? [])) rows.push(note(`已确认结果 ${result.factId}：${result.actor} · ${result.action}；${result.result}\n因果关联：${(result.causeFactIds ?? []).join('、') || '无记录'}`));
                rows.push(note(`原文证据：${JSON.stringify(step.evidence ?? [])}`));
            }
            for (const [key, label] of Object.entries(labels)) {
                const value = plot[key];
                if (value !== undefined && value !== null && value !== '') rows.push(note(`${label}：${typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}`));
            }
        }
        if (!plots.length) rows.push(note('暂无已结束阴谋可复盘。'));
        endedHost.replaceChildren(...rows);
    };
    host.appendChild(field({
        label: '查看已结束阴谋的因果复盘（剧透）',
        control: checkbox({ checked: recap.endedSpoilers === true, onChange: v => { recap.endedSpoilers = v; drawEnded(); } }),
    }));
    host.appendChild(endedHost);
    drawEnded();
    host.appendChild(field({
        label: '显示隐藏阴谋与审计（剧透）',
        control: checkbox({ checked: recap.spoilers, onChange: v => { recap.spoilers = v; drawRecap(); } }),
    }));
    host.appendChild(button('刷新复盘', () => drawRecap()));
    host.appendChild(recapHost);
    host.appendChild(button('清空当前聊天的对抗记录', async () => {
        const confirmClear = globalThis.confirm;
        if (typeof confirmClear === 'function') {
            if (!confirmClear('确认清空当前聊天的隐藏阴谋与审计？此操作不能撤销。')) return;
        } else if (!recap.clearArmed) {
            recap.clearArmed = true;
            feedback.replaceChildren(note('再次点击「清空当前聊天的对抗记录」确认删除；关闭窗口可取消。', 'warn'));
            return;
        }
        recap.clearArmed = false;
        if (typeof app.clearAdversary !== 'function') {
            feedback.replaceChildren(note('当前宿主没有提供清空接口。', 'warn'));
            return;
        }
        await app.clearAdversary();
        await app.syncAdversaryDirector?.();
        feedback.replaceChildren(note('当前聊天的对抗记录已清空。', 'ok'));
        drawRecap();
    }));
    host.appendChild(feedback);
    drawRecap();
    return [host];
}

// ---------------------------------------------------------------------------
// 区块 3：世界书线索
// ---------------------------------------------------------------------------

const loreWorkByApp = new WeakMap();

function sectionLore(/** @type {any} */ app, /** @type {any} */ s, /** @type {Function} */ commit) {
    let work = loreWorkByApp.get(app);
    if (!work) {
        work = { busy: false, progress: null, review: null, selected: null, result: null, refresh: null };
        loreWorkByApp.set(app, work);
    }
    const preview = el('div', { class: `${CSS_PREFIX}preview` });

    // ── 世界书勾选列表 ─────────────────────────────────────────────────
    //
    // 列出酒馆里**所有**世界书让用户自己勾。
    // 自动发现（角色卡 / 本聊天 / 全局勾选）任一处为空就一本都找不到，
    // 而用户可能只是没把书挂到卡上 —— 给完整列表比让他猜「为什么没探测到」好。
    const bookList = el('div', { class: `${CSS_PREFIX}booklist` });
    const bookOut = el('div', { class: `${CSS_PREFIX}preview` });

    /** 重新拉一次全部世界书并重画勾选列表。 */
    const refreshBooks = async () => {
        bookList.replaceChildren?.(el('div', { class: `${CSS_PREFIX}muted`, text: '正在读取世界书列表…' }));
        try {
            const all = await listAllBooks(app.ctx);
            bookList.replaceChildren?.();

            if (!all.length) {
                bookList.appendChild(
                    note(
                        '一本世界书都没读到。请确认酒馆里确实有世界书（世界书面板里能看到的那些）。\n如果列表确实为空，也可以在下面的输入框里手打书名。',
                        'warn',
                    ),
                );
            }

            const selected = new Set(Array.isArray(s.worldbook.bookNames) ? s.worldbook.bookNames : []);
            for (const name of all) {
                const box = checkbox({
                    checked: selected.has(name),
                    onChange: (v) => {
                        if (v) selected.add(name);
                        else selected.delete(name);
                        s.worldbook.bookNames = [...selected];
                        commit(`世界书 → ${v ? '勾选' : '取消'}「${name}」`);
                    },
                });
                bookList.appendChild(
                    el('label', { class: `${CSS_PREFIX}bookitem` }, [box, el('span', { text: name })]),
                );
            }

            bookOut.replaceChildren?.(
                note(
                    all.length
                        ? `读到 ${all.length} 本世界书。勾选你希望${isVoid(s) ? '人神' : '贝翠丝'}读取的那些（当前已勾选 ${selected.size} 本）。`
                        : '（没有可勾选的世界书）',
                    all.length ? 'ok' : 'warn',
                ),
            );
        } catch (err) {
            bookList.replaceChildren?.();
            bookList.appendChild(note(`读取世界书列表失败：${err?.message ?? err}`, 'error'));
        }
    };
    // 首次进入时自动拉一次。用 setTimeout 让面板先把骨架画出来，
    // 否则读世界书列表（可能很慢）会把整个面板卡住。
    setTimeout(() => {
        refreshBooks();
    }, 0);

    // ── AI 通读世界书，判断哪些是剧情条目 ──────────────────────────────
    const scanOut = el('div', { class: `${CSS_PREFIX}preview` });

    const extractOut = el('div', { class: `${CSS_PREFIX}preview` });
    const controls = [];
    const alive = () => scanOut.isConnected !== false;
    const lock = () => {
        for (const control of controls) control.disabled = work.busy;
        for (const host of [manualOut, bookList]) {
            for (const control of host.querySelectorAll?.('button, input') ?? []) control.disabled = work.busy;
        }
    };
    const progressView = (p = {}, initial = false) => {
        if (!initial && !alive()) return;
        const total = Math.max(0, Number(p.totalCalls) || 0);
        const done = Math.min(total, Math.max(0, Number(p.completedCalls) || 0));
        const status = { waiting: '等待开始（尚未发送）', calling: '请求中（等待 API 返回）', completed: '已完成（已收到响应）', failed: '失败' };
        const extracting = p.stage === 'extracting';
        const text = `${extracting ? '提取' : '通读'}进度：已完成 ${done}/${total} 次 API 调用；当前调用 ${p.currentCall ?? 0}/${total}（第 ${p.currentCall ?? 0} 次调用） · ${status[p.status] ?? '准备中'}`;
        (extracting ? extractOut : scanOut).replaceChildren?.(
            el('div', { class: `${CSS_PREFIX}scan-status`, role: 'status', 'aria-live': 'polite', text }),
            el('progress', { class: `${CSS_PREFIX}scan-progress`, max: Math.max(1, total), value: done, 'aria-label': extracting ? '线索提取进度' : '世界书通读进度', 'aria-valuetext': text }),
        );
    };
    const run = async (stage, task, finish) => {
        if (work.busy) return;
        work.busy = true;
        work.result = null;
        work.progress = { stage, status: 'waiting', currentCall: 0, totalCalls: 0, completedCalls: 0 };
        work.refresh?.();
        try {
            const result = await task(p => { work.progress = { ...p, stage: p.stage ?? stage }; work.refresh?.(); });
            if (!result?.ok) throw new Error(result?.error ?? '未知错误');
            finish(result);
        } catch (error) {
            work.result = { ok: false, error: String(error?.message ?? error) };
        } finally {
            work.busy = false;
            work.refresh?.();
        }
    };
    const acceptReview = result => {
        work.review = result;
        work.selected = new Set((result.selectedIndices ?? []).filter(i => Number.isInteger(i) && i >= 0 && i < result.candidates.length));
    };
    const renderReview = () => {
        const review = work.review;
        scanOut.replaceChildren?.(note(`共 ${review.candidates.length} 条候选，已按 AI 建议勾选。请核对全文并调整；确认之前不会提取，也不会发布新线索池。`));
        const picked = work.selected;
        const count = el('div', { class: `${CSS_PREFIX}muted`, role: 'status' });
        const updateCount = () => { count.textContent = `已勾选 ${picked.size}/${review.candidates.length} 条`; };
        const list = el('div', { class: `${CSS_PREFIX}booklist ${CSS_PREFIX}candidate-list` });
        const boxes = [];
        review.candidates.forEach((candidate, index) => {
            const box = checkbox({ checked: picked.has(index), onChange: value => {
                if (work.busy) return;
                if (value) picked.add(index); else picked.delete(index);
                updateCount();
            } });
            boxes.push(box); controls.push(box);
            list.appendChild(el('div', { class: `${CSS_PREFIX}candidate ${CSS_PREFIX}pickrow` }, [
                el('label', { class: `${CSS_PREFIX}bookitem` }, [box,
                    el('span', { class: `${CSS_PREFIX}pickno`, text: `#${index + 1}` }),
                    el('span', { class: `${CSS_PREFIX}picktitle`, text: String(candidate.comment ?? candidate.label ?? '') || `（无标题 #${candidate.uid ?? index + 1}）` })]),
                el('div', { class: `${CSS_PREFIX}muted`, text: `来源：${candidate.book ?? candidate.bookName ?? '（未标注）'} · ${picked.has(index) ? 'AI 建议选择' : 'AI 未选择（可自行勾选）'}` }),
                el('div', { class: `${CSS_PREFIX}muted`, text: String(review.reasons?.[index] ?? candidate.reason ?? '') }),
                el('details', { class: `${CSS_PREFIX}candidate-details` }, [
                    el('summary', { class: `${CSS_PREFIX}pickwhy`, text: '展开查看完整正文' }),
                    el('div', { class: `${CSS_PREFIX}candidate-content`, text: String(candidate.content ?? '') }),
                ]),
            ]));
        });
        const all = button('☑ 全选', () => {
            if (work.busy) return;
            boxes.forEach((box, i) => { box.checked = true; picked.add(i); }); updateCount();
        });
        const none = button('☐ 全不选', () => {
            if (work.busy) return;
            boxes.forEach(box => { box.checked = false; }); picked.clear(); updateCount();
        });
        const confirm = button('确认选择并开始提取', async () => {
            if (work.busy) return;
            const indices = [...picked].sort((a, b) => a - b);
            if (!indices.length) { count.textContent = '请至少勾选一条再确认。'; return; }
            await run('extracting', onProgress => app.confirmHookPoolSelection(indices, { reviewId: review.reviewId, onProgress }), result => {
                work.result = result; work.review = null; work.selected = null;
            });
        }, { variant: 'primary' });
        controls.push(all, none, confirm);
        scanOut.appendChild(list); updateCount(); scanOut.appendChild(count);
        scanOut.appendChild(el('div', { class: `${CSS_PREFIX}btn-row` }, [all, none, confirm]));
        if (review.coverage) {
            const c = review.coverage;
            scanOut.appendChild(note(`通读覆盖：${c.entries ?? 0} 条正文，${c.readChars ?? 0} 字符，${c.batches ?? 0} 批；${c.complete ? '全部完成' : '尚未完整完成'}。`, c.complete ? 'ok' : 'warn'));
        }
        for (const message of review.notes ?? []) scanOut.appendChild(note(String(message), 'warn'));
    };
    work.refresh = (initial = false) => {
        lock();
        if (!initial && !alive()) return;
        if (work.busy) {
            if (initial && work.review && work.progress?.stage === 'extracting') renderReview();
            progressView(work.progress, initial);
        }
        else if (work.result?.ok) {
            scanOut.replaceChildren?.(note(`已完成提取并建立线索池：${work.result.hooks?.length ?? 0} 条。`, 'ok'));
            scanOut.appendChild(note('去「🗂 线索池」查看、修改或点击「保存并绑定当前角色卡」。'));
            scanOut.appendChild(button('🗂 查看线索池', () => {
                const overlay = scanOut.closest?.(`.${CSS_PREFIX}win-overlay`);
                const tab = [...(overlay?.querySelectorAll?.(`.${CSS_PREFIX}win-tab`) ?? [])].find(node => node.textContent.includes('线索池'));
                tab?.click?.();
            }));
        } else {
            if (work.review) renderReview();
            if (work.result) extractOut.replaceChildren?.(note(`操作失败：${work.result.error}。可重新确认或通读。`, 'error'));
        }
        lock();
    };
    const pending = app.getHookPoolReview?.();
    if (pending?.needsConfirmation && pending.reviewId !== work.review?.reviewId) {
        acceptReview(pending); work.result = null;
    } else if (typeof app.getHookPoolReview === 'function' && !pending && !work.busy) {
        work.review = null; work.selected = null;
    }

    const scanBtn = button(
        '🔎 让 AI 通读世界书',
        async () => {
            if (work.busy) return;
            const books = Array.isArray(s.worldbook.bookNames) ? s.worldbook.bookNames.filter(Boolean) : [];
            if (!books.length) {
                scanOut.replaceChildren?.(note('先在上面勾选至少一本世界书。', 'warn'));
                return;
            }
            const status = app.channelStatus();
            if (!status.ready) {
                scanOut.replaceChildren?.(note(`辅助 API 还没配好：${status.reason}`, 'warn'));
                return;
            }

            scanOut.replaceChildren?.(
                note(
                    `正在把 ${books.length} 本书的条目交给 AI 通读…\n` +
                        '（调用次数取决于书的长度；读完先审核勾选，确认后才开始提取）',
                ),
            );
            if (work.busy) return;
            await run('reading', onProgress => app.buildHookPool({ force: true, onProgress }), result => {
                if (!result.needsConfirmation || !Array.isArray(result.candidates)) throw new Error('通读结果缺少待确认条目，请更新插件后重试');
                acceptReview(result);
            });

        },
        { variant: 'primary' },
    );

    const clearBtn = button('🗑 清空线索池并重读', async () => {
        if (work.busy) return;
        await run('reading', async () => { await app.clearHookPool(); return { ok: true }; }, () => {
            work.review = null; work.selected = null;
            if (alive()) scanOut.replaceChildren?.(note('已清空。下次生成正文将准备通读草稿，确认选择后才提取。'));
        });
    });

    // ── 手动挑条目（保底路径）──────────────────────────────────────────
    //
    // 用户要求：「最后你还要加一个自主勾选条目的选项，全交给 ai 可能会有遗漏，这是个保底。」
    //
    // 所以这条路必须**完全独立于 AI** 可用：读候选 → 自己勾 → 建线索池。
    // 建出来的池子和 AI 那条路产出同样的结构，下游引导完全不区分来源。
    const manualOut = el('div', { class: `${CSS_PREFIX}preview` });

    /** 画出可勾选的条目清单。 */
    const renderManualPicker = (/** @type {any[]} */ candidates) => {
        manualOut.replaceChildren?.();
        /** @type {Set<number>} */
        const picked = new Set();
        const list = el('div', { class: `${CSS_PREFIX}booklist` });

        candidates.forEach((c, i) => {
            const n = i + 1;
            const box = checkbox({
                checked: false,
                onChange: (v) => {
                    if (work.busy) return;
                    if (v) picked.add(n);
                    else picked.delete(n);
                    countOut.textContent = `已勾选 ${picked.size} 条`;
                },
            });
            const title = String(c.comment ?? '').trim() || `（无标题 #${c.uid}）`;
            list.appendChild(
                el('label', { class: `${CSS_PREFIX}bookitem` }, [
                    box,
                    el('span', { class: `${CSS_PREFIX}pickno`, text: `#${n}` }),
                    el('span', { class: `${CSS_PREFIX}picktitle`, text: title }),
                    el('details', { class: `${CSS_PREFIX}candidate-details` }, [
                        el('summary', { class: `${CSS_PREFIX}pickwhy`, text: '展开查看完整正文' }),
                        el('div', { class: `${CSS_PREFIX}candidate-content`, text: String(c.content ?? '') }),
                    ]),
                ]),
            );
        });

        const countOut = el('div', { class: `${CSS_PREFIX}muted`, text: '已勾选 0 条' });

        manualOut.appendChild(
            note(
                `共 ${candidates.length} 条可挑。勾选你希望${isVoid(s) ? '人神' : '贝翠丝'}用来铺垫的那些 —— ` +
                    '勾完点下面的按钮直接建线索池，不需要 AI。',
            ),
        );
        manualOut.appendChild(list);
        manualOut.appendChild(countOut);
        manualOut.appendChild(
            el('div', { class: `${CSS_PREFIX}btn-row` }, [
                button(
                    '✅ 用勾选的条目建立线索池',
                    async () => {
                        if (work.busy) return;
                        await run('extracting', onProgress => app.buildHookPoolFromPicks(candidates, [...picked].sort((a, b) => a - b), { onProgress }), result => { work.result = result; });

                    },
                    { variant: 'primary' },
                ),
                button('☑ 全选', () => {
                    if (work.busy) return;
                    candidates.forEach((_, i) => {
                        picked.add(i + 1);
                        const box = list.childNodes?.[i]?.querySelector?.('input');
                        if (box) box.checked = true;
                    });
                    countOut.textContent = `已勾选 ${picked.size} 条`;
                }),
                button('☐ 全不选', () => {
                    if (work.busy) return;
                    picked.clear();
                    for (const node of list.childNodes ?? []) {
                        const box = node.querySelector?.('input');
                        if (box) box.checked = false;
                    }
                    countOut.textContent = '已勾选 0 条';
                }),
            ]),
        );
    };

    const manualBtn = button('📋 列出条目让我自己挑', async () => {
        if (work.busy) return;
        await run('reading', async () => ({ ...await app.prepareScanCandidates(), ok: true }), collected => {
            if (!alive()) return;
            if (!collected.candidates.length) manualOut.replaceChildren?.(note(`没有条目可挑（扫了 ${collected.scanned} 条，跳过了 ${collected.skipped} 条）。`, 'warn'));
            else renderManualPicker(collected.candidates);
        });
    });
    controls.push(scanBtn, manualBtn, clearBtn);
    work.refresh(true);

    return [
        note(
            `${isVoid(s) ? '人神' : '贝翠丝'}会读完你勾选的世界书的全部条目正文，由 AI 分批通读，建议包含未来事件和出场人物的条目。你核对并确认选择后才提取并建立线索池。` +
                '引导时先定位当前剧情进度，再选择相关线索。你不需要为这个插件改任何世界书。',
        ),
        note(
            '通读结果会保存在当前角色卡的线索池中，同一角色卡的新聊天也可复用；换卡不会混用。\n' +
                '作者改了世界书、或者你换了书单，可以重新通读更新线索池。',
        ),

        el('h5', { class: `${CSS_PREFIX}sub-h`, text: '① 读哪几本世界书' }),
        el('div', { class: `${CSS_PREFIX}btn-row` }, [
            button('🔄 重新读取列表', () => refreshBooks()),
            button('🗑 清空勾选', () => {
                s.worldbook.bookNames = [];
                commit('清空世界书勾选');
                refreshBooks();
            }),
        ]),
        bookList,
        bookOut,

        field({
            label: '或手打书名',
            hint: '逗号分隔。留空 = 只用上面勾选的。',
            wide: true,
            control: textInput({
                value: formatListInput(s.worldbook.bookNames),
                placeholder: '留空即可',
                width: '100%',
                onChange: (v) => {
                    s.worldbook.bookNames = parseListInput(v);
                    commit('指定世界书');
                    refreshBooks();
                },
            }),
        }),

        el('h5', { class: `${CSS_PREFIX}sub-h`, text: '② 让 AI 通读并建立线索池' }),
        el('div', { class: `${CSS_PREFIX}btn-row` }, [scanBtn, manualBtn, clearBtn]),
        scanOut,
        extractOut,

        manualOut,

        el('h5', { class: `${CSS_PREFIX}sub-h`, text: '③ 高级（一般不用动）' }),
        field({
            label: '未显式保存池的自动刷新时间（小时）',
            hint: '未显式保存的线索池超过这个时间可自动刷新；点过「保存并绑定当前角色卡」的池子不会仅因时间过期被覆盖。',
            control: numberInput({
                value: Math.round((Number(s.worldbook.poolTtlMs) || 21600000) / 3600000),
                min: 1,
                max: 720,
                onChange: (v) => {
                    s.worldbook.poolTtlMs = Math.max(1, Number(v) || 6) * 3600000;
                    commit('线索池有效期');
                },
            }),
        }),
        el('div', { class: `${CSS_PREFIX}btn-row` }, [
            button('🔍 看看会读到什么（不调 AI）', async () => {
                preview.replaceChildren?.();
                preview.appendChild(el('div', { class: `${CSS_PREFIX}muted`, text: '正在读取世界书…' }));
                try {
                    const collected = await app.previewCandidates();
                    preview.replaceChildren?.();
                    preview.appendChild(
                        el('div', { class: `${CSS_PREFIX}muted` }, [
                            el('div', {
                                text: `扫描 ${collected.books.length} 本书、${collected.scanned} 条条目 → ${collected.candidates.length} 条进入候选（跳过 ${collected.skipped} 条）`,
                            }),
                            el('div', { text: `来源：${collected.books.join('、') || '（无）'}` }),
                        ]),
                    );
                    for (const err of collected.errors) preview.appendChild(note(`读取失败：${err}`, 'warn'));
                    if (!collected.books.length) {
                        preview.appendChild(note('还没选任何世界书 —— 在上面勾选，或手打书名。', 'warn'));
                    } else if (!collected.candidates.length) {
                        preview.appendChild(
                            note('没有条目进入候选。请检查所选世界书是否有正文内容。', 'warn'),
                        );
                    } else {
                        preview.appendChild(
                            pre(
                                collected.candidates
                                    .slice(0, 40)
                                    .map((/** @type {any} */ c, /** @type {number} */ i) => `${i + 1}. ${c.comment || '（无标题）'}`)
                                    .join('\n') +
                                    (collected.candidates.length > 40
                                        ? `\n…（还有 ${collected.candidates.length - 40} 条）`
                                        : ''),
                                300,
                            ),
                        );
                    }
                } catch (e) {
                    preview.replaceChildren?.();
                    preview.appendChild(note(`读取失败：${e?.message ?? e}`, 'error'));
                }
            }),
        ]),
        preview,
    ];
}

// ---------------------------------------------------------------------------
// 区块 3.5：线索池（可见 + 可编辑）
// ---------------------------------------------------------------------------

/**
 * 「线索池」栏。
 *
 * ── 为什么单独开一栏，而不是塞在世界书那栏里
 *
 * 用户的要求：
 *   「线索池应该可见且新开一栏在设置里」＋「最后建立的线索也应该可以查看修改，防止出错」
 *
 * 理由成立：线索池是**实际被用来引导**的东西，世界书只是它的原料。
 * 把它压在世界书栏的下半部分，用户根本不知道自己现在到底在用什么线索，
 * 出了问题也无从下手。
 *
 * 这一栏要回答三个问题：
 *   1. 现在有没有池子？是谁的（哪张卡）？多少条？还能用吗？
 *   2. 里面具体是哪几条？（AI 判断错了要能看见）
 *   3. 怎么改？（改标题/正文/分类、删掉、补一条、整份重来）
 *
 * @param {any} app
 * @param {any} s
 * @param {Function} commit
 * @param {Function} rerender
 */
function sectionPool(/** @type {any} */ app, /** @type {any} */ s, /** @type {Function} */ commit, /** @type {Function} */ rerender) {
    const out = el('div', { class: `${CSS_PREFIX}preview` });

    /** 重画整个池子界面。 */
    const render = async () => {
        out.replaceChildren?.();

        out.appendChild(note(isVoid(s)
            ? '索引只负责查资料，不证明事件发生。当前事实有正文证据；人神计划单独存放，不写入事实账本。'
            : '碧翠丝绝对善良：只真诚帮助与保护选择，不使用人神阴谋。索引只查资料，建议须核对正文事实与原文条件。', 'ok'));
        const facts = app.factState?.();
        if (facts) {
            const box = el('div', { class: `${CSS_PREFIX}preview` });
            box.appendChild(el('h4', { text: '当前剧情事实（证据不等于模型判断绝对正确）' }));
            for (const fact of facts.facts ?? []) {
                box.appendChild(note(`[${fact.status}] ${fact.actor} · ${fact.action} → ${fact.result}\n` +
                    (fact.evidence ?? []).map(e => `正文 #${e.index}：“${e.quote}”`).join('\n') + '\n' +
                    (fact.knowledge ?? []).map(k => `${k.actor}知情依据：${k.basis}`).join('\n')));
            }
            if (!facts.facts?.length) box.appendChild(note('尚无已观测事实；未知条件不会自动补齐。'));
            const assessed = app.lastOutcome?.sourceAssessment ?? [];
            for (const item of assessed) box.appendChild(note('本次原文适用判断：' + JSON.stringify(item)));
            out.appendChild(box);
        }

        // ⚠️ 防御：`readHookPool` 是 app 上的方法。万一控制器版本对不上
        //（例如插件被半更新、或者别处传了个假 app），这里直接抛异常会把
        // **整栏**搞崩，用户看到的是一片空白 + 控制台报错，很难自查。
        // 所以缺方法时给一句可读的提示，而不是让它炸。
        if (typeof app.readHookPool !== 'function') {
            out.appendChild(note('当前控制器不支持读取线索池（可能是插件文件不完整，建议重新安装一次）。', 'error'));
            return;
        }

        // 索引模式的池子不存正文，这里把正文从世界书现取出来显示
        //（`hydratePool` 在老格式 / 没有这个方法时退回 `readHookPool`）。
        const info =
            typeof app.hydratePool === 'function' ? await app.hydratePool() : app.readHookPool();
        const isIndex = Boolean(info.indexed);

        // ── 概览 ──────────────────────────────────────────────────────
        if (!info.ok) {
            out.appendChild(
                note(
                    `这张卡（${info.character || '当前卡'}）还没有线索池。\n` +
                        `到「📖 世界书线索」勾好书，点「🔎 让 AI 通读世界书」；\n` +
                        `或者直接在这一栏下面点「＋ 手工加一条」自己写。\n\n` +
                        `第一次生成正文时也会自动通读一次。`,
                    'warn',
                ),
            );
        } else {
            const when = info.at ? new Date(info.at).toLocaleString() : '未知时间';
            const srcLabel =
                info.source === 'ai'
                    ? 'AI 通读'
                    : info.source === 'manual'
                      ? '手动挑选'
                      : info.source === 'edited'
                        ? '手工修改过'
                        : '未知';
            out.appendChild(
                note(
                    `绑定在「${info.character || '当前卡'}」上　共 ${info.hooks.length} 条　来源：${srcLabel}\n` +
                        `建立于 ${when}${info.edited ? '（之后被手工改过）' : ''}\n` +
                        `状态：${info.fresh ? '✅ ' : '⚠️ '}${info.note}`,
                    info.fresh ? 'ok' : 'warn',
                ),
            );
            if (isIndex) {
                out.appendChild(
                    note(
                        '这是「索引」：它记着这本书里有哪些条目、分别讲什么、什么阶段才有意义。\n' +
                            '每次正文写完，会先判断剧情演到哪，再从这里挑出对得上的几条、取回原文给她用。\n\n' +
                            '所以「摘要」和「阶段」写得准不准，直接决定她能不能找到该用的东西 ——\n' +
                            '发现哪条描述得不对，改这两个框就行。正文是从世界书实时读的，改世界书即可生效。',
                    ),
                );

                // 上一次「定位」的判断 —— 她认为演到哪、挑了哪几条。
                //
                // 用户提这个功能时的原话就是「让读表 ai 判断目前是第几章」，
                // 所以判断结论必须摆在眼前：她要是读错了位置（比如明明已经
                // 到了王都篇，却还按开局挑），引导就会一本正经地扯到不相干的
                // 地方，而用户只会觉得「这插件在胡说」，根本想不到是判断错了。
                const st = typeof app.state === 'function' ? app.state() : null;
                const loc = st?.located;
                if (loc) {
                    out.appendChild(
                        note(
                            `上一次她判断剧情演到：『${loc.phase}』\n` +
                                `从这个索引的 ${loc.total} 条里挑了 ${loc.picks.length} 条：` +
                                (loc.labels.length ? loc.labels.join('、') : `编号 ${loc.picks.join('、')}`) +
                                (loc.why ? `\n她的理由：${loc.why}` : '') +
                                (loc.ok ? '' : '\n⚠️ 这一步没成功，这次用的是整份索引'),
                        ),
                    );
                }
            }
        }

        // ── 条目表格 ─────────────────────────────────────────────────────
        if (info.ok && info.hooks.length) {
            const table = el('div', { class: `${CSS_PREFIX}pooltable` });

            info.hooks.forEach((hook, i) => {
                /** 改一个字段并落盘。 */
                const patch = async (/** @type {any} */ p) => {
                    const res = await app.updateHook(i, p);
                    if (!res.ok) toast(`修改失败：${res.error}`, 'error');
                };

                const row = el('div', { class: `${CSS_PREFIX}poolrow` });

                // 第一行：序号 + 分类 + 标题 + 删除
                row.appendChild(
                    el('div', { class: `${CSS_PREFIX}poolhead` }, [
                        el('span', { class: `${CSS_PREFIX}pickno`, text: `#${i + 1}` }),
                        select({
                            ariaLabel: `线索 #${i + 1} 分类`,
                            value: String(hook.kind ?? '线索'),
                            width: 92,
                            options: ['线索', '地点', '事件', '人物', '征兆', '设定'].map((k) => ({ value: k, label: k })),
                            onChange: (v) => patch({ kind: v }),
                        }),
                        textInput({
                            value: String(hook.label ?? ''),
                            placeholder: '线索标题（她会用这个当线索名）',
                            width: '100%',
                            onChange: (v) => patch({ label: v }),
                        }),
                        button(
                            '🗑',
                            async () => {
                                const res = await app.removeHook(i);
                                if (res.ok) {
                                    toast('已删除这一条', 'success', 4000);
                                    render();
                                    rerender();
                                } else {
                                    toast(`删除失败：${res.error}`, 'error');
                                }
                            },
                            { variant: 'danger' },
                        ),
                    ]),
                );

                // 第 1.5 行（仅索引模式）：摘要 + 阶段 —— 检索就靠这两栏
                if (isIndex || hook.brief || hook.phase) {
                    row.appendChild(
                        el('div', { class: `${CSS_PREFIX}poolhead` }, [
                            textInput({
                                value: String(hook.brief ?? ''),
                                placeholder: '这条讲什么（检索时她看的就是这句）',
                                width: '100%',
                                onChange: (v) => patch({ brief: v }),
                            }),
                            textInput({
                                value: String(hook.phase ?? ''),
                                placeholder: '什么阶段才有用，例如「王都篇」',
                                width: 200,
                                onChange: (v) => patch({ phase: v }),
                            }),
                        ]),
                    );
                }

                // 第二行：正文（这才是真正喂给模型的素材）
                if (isIndex) {
                    // 索引模式下正文是**实时**从世界书读的 —— 做成可编辑的话，
                    // 用户改完下一次取回就被覆盖了，那比不让改更让人困惑。
                    const body = textarea({
                        value: String(hook.content ?? ''),
                        rows: 2,
                        placeholder: '（世界书里这一条没有正文）',
                        onChange: () => {},
                    });
                    body.readOnly = true;
                    body.disabled = true;
                    row.appendChild(el('div', { class: `${CSS_PREFIX}poolbody` }, [body]));
                } else {
                    row.appendChild(
                        el('div', { class: `${CSS_PREFIX}poolbody` }, [
                            textarea({
                                value: String(hook.content ?? ''),
                                rows: 2,
                                placeholder: '正文 —— 这一段才是真正交给模型的素材',
                                onChange: (v) => patch({ content: v }),
                            }),
                        ]),
                    );
                }

                // 第三行：来源与理由（只读，方便判断 AI 挑得对不对）
                const meta = [
                    hook.book ? `来自《${hook.book}》${isIndex && hook.uid !== undefined ? ` 第 ${hook.uid} 号` : ''}` : '',
                    hook.why ? `AI 理由：${hook.why}` : '',
                    isIndex && hook.uid !== undefined ? '正文实时取自世界书' : '',
                ]
                    .filter(Boolean)
                    .join('　');
                if (meta) row.appendChild(el('div', { class: `${CSS_PREFIX}poolmeta`, text: meta }));

                table.appendChild(row);
            });

            out.appendChild(table);
        }

        // ── 操作按钮 ─────────────────────────────────────────────────────
        out.appendChild(
            el('div', { class: `${CSS_PREFIX}btn-row` }, [
                button('保存并绑定当前角色卡', async () => {
                    if (typeof app.saveHookPool !== 'function') {
                        toast('当前控制器不支持保存线索池，请完整更新插件。', 'error');
                        return;
                    }
                    try {
                        // 控制器在点击时验证当前角色卡，不使用渲染时的卡名或池子。
                        const res = await app.saveHookPool();
                        if (!res?.ok) {
                            toast(`保存失败：${res?.error ?? '未知错误'}`, 'error', 8000);
                            return;
                        }
                        toast(`已保存并绑定「${res.character || res.pool?.character || '当前角色卡'}」`, 'success', 6000);
                        await render();
                        rerender();
                    } catch (e) {
                        toast(`保存失败：${e?.message ?? e}`, 'error', 8000);
                    }
                }, { variant: 'primary' }),
                button(`＋ 手工加一条`, () => {
                    const editOut = el('div', { class: `${CSS_PREFIX}preview` });
                    const labelIn = textInput({
                        placeholder: '线索标题，例如「旧城区的传言」',
                        width: '100%',
                    });
                    const bodyIn = textarea({ placeholder: '正文素材（这一段才是给模型看的）', rows: 2 });
                    const wrap = el('div', { class: `${CSS_PREFIX}poolrow` }, [
                        el('div', { class: `${CSS_PREFIX}poolhead` }, [labelIn]),
                        el('div', { class: `${CSS_PREFIX}poolbody` }, [bodyIn]),
                    ]);
                    out.replaceChildren?.(note(`填好后点「保存这一条」。标题和正文至少填一个。`));
                    out.appendChild(wrap);
                    out.appendChild(editOut);
                    out.appendChild(
                        el('div', { class: `${CSS_PREFIX}btn-row` }, [
                            button(
                                `保存这一条`,
                                async () => {
                                    const res = await app.addHook({
                                        label: String(labelIn.value ?? ''),
                                        content: String(bodyIn.value ?? ''),
                                    });
                                    if (res.ok) {
                                        toast('已加入线索池', 'success', 4000);
                                        render();
                                        rerender();
                                    } else {
                                        editOut.replaceChildren?.(note(`添加失败：${res.error}`, 'error'));
                                    }
                                },
                                { variant: 'primary' },
                            ),
                            button(`← 返回线索池`, () => render()),
                        ]),
                    );
                }),
                button(`↻ 重新读一遍世界书（覆盖当前池子）`, async () => {
                    const status = app.channelStatus();
                    if (!status.ready) {
                        toast(`辅助 API 还没配好：${status.reason}`, 'error');
                        return;
                    }
                    out.replaceChildren?.(note(`正在让 AI 通读世界书…（几十秒）`));
                    const res = await app.buildHookPool({ force: true });
                    if (res.ok) {
                        toast(`已重读：${res.hooks.length} 条`, 'success', 6000);
                    } else {
                        toast(`重读失败：${res.error}`, 'error', 8000);
                    }
                    render();
                    rerender();
                }),
                button(`🗑 清空这张卡的线索池`, async () => {
                    await app.clearHookPool();
                    toast('已清空，下次生成会重新通读', 'success');
                    render();
                    rerender();
                }),
            ]),
        );
    };

    render();

    return [
        // ⚠️ note() 不做 markdown 渲染 —— 这里不要用 ** 加粗，会把星号原样显示出来
        note(
            `线索池 = 实际被用来引导的那几条线索。它跟着「角色卡」走：\n` +
                `在哪张卡建立的，就只在那张卡里生效 —— 换卡不会串味。`,
        ),
        note(
            `⚠️ AI 判断会出错（挑错条目、把名字改坏）。所以这里是「可编辑」的：` +
                `直接改标题、改正文、换分类、删掉，或者自己补一条。改完之后有效期会从修改时间重新算，` +
                `不会被自动重读冲掉。`,
            'warn',
        ),
        el('div', { class: `${CSS_PREFIX}btn-row` }, [
            button(`🔄 刷新显示`, () => render(), { variant: 'primary' }),
        ]),
        out,
    ];
}

// ---------------------------------------------------------------------------
// 区块 4：外观
// ---------------------------------------------------------------------------

function sectionUi(/** @type {any} */ app, /** @type {any} */ s, /** @type {Function} */ commit) {
    return [
        field({
            label: '显示悬浮窗',
            control: checkbox({
                checked: s.ui.showAvatar,
                onChange: (v) => {
                    s.ui.showAvatar = v;
                    app.ui?.setVisible?.(v);
                    commit('悬浮窗开关');
                },
            }),
        }),
        field({
            label: '头像大小',
            control: slider({
                value: s.ui.avatarSize,
                min: 48,
                max: 256,
                step: 4,
                format: (v) => `${v}px`,
                onChange: (v) => {
                    s.ui.avatarSize = v;
                    app.ui?.refresh?.();
                    commit('头像大小');
                },
            }),
        }),
        field({
            label: '气泡停留时长',
            hint: '0 = 不自动消失，需要手动关。',
            control: numberInput({
                value: s.ui.bubbleDurationMs,
                min: 0,
                max: 600000,
                step: 1000,
                width: 110,
                onChange: (v) => {
                    s.ui.bubbleDurationMs = v;
                    commit('气泡时长');
                },
            }),
        }),
        field({
            label: '气泡位置',
            control: select({
                value: s.ui.bubbleSide,
                options: [
                    { value: 'auto', label: '自动（跟着头像走）' },
                    { value: 'left', label: '固定在左侧' },
                    { value: 'right', label: '固定在右侧' },
                ],
                width: 180,
                onChange: (v) => {
                    s.ui.bubbleSide = v;
                    commit('气泡位置');
                },
            }),
        }),
        field({
            label: '待机浮动动画',
            control: checkbox({
                checked: s.ui.idleAnimation,
                onChange: (v) => {
                    s.ui.idleAnimation = v;
                    app.ui?.refresh?.();
                    commit('待机动画');
                },
            }),
        }),
        field({
            label: '自定义立绘',
            hint: '相对本插件目录的路径，例如 assets/my-beatrice.png。留空用随包的贝翠丝立绘。',
            wide: true,
            control: textInput({
                value: s.ui.customImage,
                placeholder: 'assets/my-beatrice.png',
                width: '100%',
                onChange: (v) => {
                    s.ui.customImage = v;
                    commit('自定义立绘');
                },
            }),
        }),
        el('div', { class: `${CSS_PREFIX}btn-row` }, [
            button('↺ 重置悬浮窗位置', () => {
                s.ui.avatarPos = { x: 24, y: 220 };
                app.ui?.refresh?.();
                commit('重置位置');
                toast('悬浮窗位置已重置', 'success');
            }),
        ]),
    ];
}

// ---------------------------------------------------------------------------
// 区块 5：人设
// ---------------------------------------------------------------------------

/**
 * 区块 5：人设 —— 提示词编辑器。
 *
 * ── 为什么做成「分段列表」而不是一个整段大文本框
 *
 * 用户明确要求「人设方面应该做成提示词模式」，并给了一张酒馆
 * 「提示词管理器」的截图：每条提示词有自己的角色（SYSTEM / ASSISTANT）、
 * 一段正文、一个删除按钮。
 *
 * 这个形式确实比一整段大字符串好：
 *  - 想让她少吐槽一点 → 关掉「吐槽规则」那一条，不用在几千字里找
 *  - 想换身份设定 → 只改「身份」那一条
 *  - 顺序可以调，因为角色与规则的相对位置会影响模型的理解
 *
 * @param {any} app
 * @param {any} s
 * @param {Function} commit
 * @param {() => void} rerender
 */
function sectionPersona(/** @type {any} */ app, /** @type {any} */ s, /** @type {Function} */ commit, /** @type {() => void} */ rerender) {
    // 当前生效的分段：用户配过就用他的，否则用内置默认。
    // ⚠️ 关键：一旦用户动过任何一处，就把**整份**（含内置默认）落盘成他的分段。
    // 否则「改一条」和「其余用默认」两件事会打架。
    //
    // 同时必须写上 `promptsVersion` —— 这是「这份内容是从第几版内置来的」的标记。
    // 不写的话下次加载会被 migrateBuiltinPrompts 判成「旧版内置」而**覆盖用户的编辑**。
    // Separate stores: editing/resetting the void must never overwrite Beatrice's copy.
    const personaKey = isVoid(s) ? 'voidPersona' : 'persona';
    const persona = s[personaKey] ?? (s[personaKey] = {});
    const defaults = () => isVoid(s) ? defaultVoidPersonaPrompts(s) : defaultPersonaPrompts(s);
    const ensureEditable = () => {
        if (!Array.isArray(persona.prompts) || !persona.prompts.length) {
            persona.prompts = defaults().map((p) => ({ ...p }));
        }
        persona.promptsVersion = BUILTIN_PROMPTS_VERSION;
        return persona.prompts;
    };

    const isUsingDefaults = !Array.isArray(persona.prompts) || !persona.prompts.length;
    const prompts = isUsingDefaults ? defaults().map((p) => ({ ...p })) : persona.prompts;

    const listHost = el('div', { class: `${CSS_PREFIX}promptlist` });

    /** 提交改动：落盘 + 重画。 */
    const apply = (/** @type {string} */ what) => {
        commit(what);
        rerender();
    };

    /** 画一条提示词。 */
    const renderItem = (/** @type {any} */ p, /** @type {number} */ idx) => {
        const roleSelect = select({
            ariaLabel: `提示词 #${idx + 1} 角色`,
            value: p.role,
            options: [
                { value: 'system', label: 'SYSTEM' },
                { value: 'user', label: 'USER' },
                { value: 'assistant', label: 'ASSISTANT' },
            ],
            width: 130,
            onChange: (v) => {
                ensureEditable()[idx].role = v;
                apply(`提示词 #${idx + 1} 角色 → ${v.toUpperCase()}`);
            },
        });

        const enableBox = checkbox({
            checked: p.enabled !== false,
            title: '启用 / 停用这一条',
            onChange: (v) => {
                ensureEditable()[idx].enabled = v;
                apply(`提示词 #${idx + 1} ${v ? '启用' : '停用'}`);
            },
        });

        const area = textarea({
            ariaLabel: `提示词 #${idx + 1} 内容`,
            value: p.content,
            rows: 6,
            onChange: (v) => {
                ensureEditable()[idx].content = v;
                apply(`提示词 #${idx + 1} 内容`);
            },
        });
        // 停用的条目视觉上要明显变淡，否则用户会以为它还生效
        if (p.enabled === false) area.style.opacity = '0.45';

        /** 上移 / 下移 / 删除 —— 三个小图标按钮。 */
        const moveUp = button('↑', () => {
            const arr = ensureEditable();
            if (idx <= 0) return;
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            apply(`提示词 #${idx + 1} 上移`);
        }, { title: '上移' });
        const moveDown = button('↓', () => {
            const arr = ensureEditable();
            if (idx >= arr.length - 1) return;
            [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
            apply(`提示词 #${idx + 1} 下移`);
        }, { title: '下移' });
        const del = button('🗑', () => {
            ensureEditable().splice(idx, 1);
            apply(`删除提示词 #${idx + 1}`);
        }, { variant: 'danger', title: '删除这一条' });
        for (const b of [moveUp, moveDown]) b.classList?.add?.(`${CSS_PREFIX}btn-icon`);
        del.classList?.add?.(`${CSS_PREFIX}btn-icon`);

        return el('div', { class: `${CSS_PREFIX}prompt-item`, dataset: { off: p.enabled === false ? '1' : '0' } }, [
            el('div', { class: `${CSS_PREFIX}prompt-head` }, [
                el('span', { class: `${CSS_PREFIX}prompt-no`, text: `#${idx + 1}` }),
                roleSelect,
                enableBox,
                el('span', { class: `${CSS_PREFIX}prompt-spacer` }),
                moveUp,
                moveDown,
                del,
            ]),
            area,
        ]);
    };

    prompts.forEach((p, i) => listHost.appendChild(renderItem(p, i)));

    const addBtn = button(
        '＋ 添加一条提示词',
        () => {
            const arr = ensureEditable();
            arr.push({
                id: `p${Date.now().toString(36)}`,
                role: 'system',
                content: '在这里写一条新的设定或规则。',
                enabled: true,
            });
            apply('新增提示词');
        },
        { variant: 'primary' },
    );

    const resetBtn = button('↺ 恢复内置人设', () => {
        persona.prompts = [];
        persona.overridePrompt = '';
        // 清空 = 用内置，版本号也要对齐到当前版 ——
        // 否则下次加载会被判成「旧版内置」而重复迁移。
        persona.promptsVersion = BUILTIN_PROMPTS_VERSION;
        apply('恢复内置人设');
        toast('已恢复内置人设', 'success');
    });

    /** 把当前人设复制出来 —— 用户想手动贴进世界书条目时用。 */
    const copyBtn = button('📋 复制人设文本', async () => {
        const text = redactDiagnostics([
            `【${guideName(s)} · 角色设定】`,
            '',
            ...resolvePersonaPrompts(s).map((p) => `〔${String(p.role).toUpperCase()}〕\n${p.content}`),
        ].join('\n\n'), s);
        try {
            await /** @type {any} */ (globalThis)?.navigator?.clipboard?.writeText?.(text);
            toast('人设文本已复制 —— 可以直接粘进世界书条目里', 'success', 6000);
        } catch {
            // 剪贴板不可用（权限/非安全上下文）就把内容摊出来让用户自己选
            helper.replaceChildren?.(note(text, 'ok'));
            toast('剪贴板不可用，已显示在下方，请手动复制', 'warning', 6000);
        }
    });

    const helper = el('div', { class: `${CSS_PREFIX}preview` });

    return [
        field({
            label: '角色名',
            hint: '出现在气泡标题与正文插入里。',
            control: textInput({
                value: persona.name ?? guideName(s),
                width: 160,
                onChange: (v) => {
                    persona.name = v;
                    app.ui?.refresh?.();
                    apply('角色名');
                },
            }),
        }),

        note(
            isUsingDefaults
                ? '下面是**内置人设**（按提示词分段）。动任何一处就会转成你自己的副本，之后可以随意改。'
                : '这是你自己的人设分段。想回到出厂设定点最下面的「恢复内置人设」。',
        ),

        listHost,

        el('div', { class: `${CSS_PREFIX}btn-row` }, [addBtn, resetBtn, copyBtn]),

        field({
            label: '整段覆盖（高级）',
            hint: '填了就**完全忽略**上面的分段，只用这一段。一般不需要用。',
            wide: true,
            control: textarea({
                value: persona.overridePrompt ?? '',
                rows: 4,
                placeholder: '留空即可',
                onChange: (v) => {
                    persona.overridePrompt = v;
                    apply('整段覆盖人设');
                },
            }),
        }),

        note(
            [
                '【关于角色】',
                'system = 设定与规则（她是谁、该怎么说话）',
                'assistant = 她认领人设的回应（会让后面的输出更贴那个口吻）',
                'user   = 由插件在末尾自动追加的「当前局势」，不需要你写',
                '',
                '提示 1：想让她这次少吐槽，把「吐槽规则」那条停用即可，不用改文字。',
                '提示 2：想让她在世界书里也有身份记录（让正文模型也认识她），',
                '　　　　点「复制人设文本」，然后在世界书里新建一条粘进去。',
            ].join('\n'),
        ),
        helper,
    ];
}

// ---------------------------------------------------------------------------
// 区块 6：诊断
// ---------------------------------------------------------------------------

function sectionDiag(/** @type {any} */ app) {
    const out = el('div', { class: `${CSS_PREFIX}preview` });
    let includeStory = false;
    const preview = () => show(pre(buildDiagnostics(app, { includeStory }), 400));

    /** 把结果贴到输出区。 */
    const show = (/** @type {any} */ node) => {
        out.replaceChildren?.();
        if (typeof node === 'string') out.appendChild(note(node));
        else if (node) out.appendChild(node);
    };

    return [
        el('div', { class: `${CSS_PREFIX}btn-row` }, [
            button(
                '📋 复制诊断信息',
                async () => {
                    const text = buildDiagnostics(app, { includeStory });
                    show(pre(text, 400));
                    try {
                        await /** @type {any} */ (globalThis)?.navigator?.clipboard?.writeText?.(text);
                        toast('诊断信息已复制到剪贴板', 'success');
                    } catch {
                        show(pre(text, 400));
                        toast('复制失败，已显示在下方手动复制', 'warning');
                    }
                },
                { variant: 'primary' },
            ),
            button('🧹 清空本聊天记忆', async () => {
                await app.clearMemory();
                toast('已清空本聊天的引导记忆', 'success');
            }),
            button('预览公开报告', preview),
            button('查看当前状态', () => show(pre(JSON.stringify(redactDiagnostics(app.state(), app.settings), null, 2), 420))),
        ]),
        field({ label: '包含剧情与详细设置（可能剧透）', hint: '默认公开报告不含剧情、卡名、书名、状态及日志；勾选后请先检查预览。', control: checkbox({ checked: false, onChange: (v) => { includeStory = v; preview(); } }) }),
        note('先预览再分享；脱敏不是对未知私密内容的保证。'),
        out,
    ];
}

/** 拼一份可以直接贴进 Issue 的诊断文本。 */
export function buildDiagnostics(/** @type {any} */ app, { includeStory = false } = {}) {
    const probe = LlmClient.probe(app.ctx);
    return redactDiagnostics([
        `# ${EXT_NAME} 诊断信息`,
        `版本：${app.version}`,
        // 单独列一行「代码修订」：只有它能区分两个构建。
        // 'version' 是语义版本，发布时才动 —— 排查「更新生效了吗」不能靠它。
        `代码修订：${CODE_REVISION}`,
        `人设提示词：第 ${Number(app.settings?.persona?.promptsVersion) || 0} 版` +
            (Number(app.settings?.persona?.promptsVersion) >= BUILTIN_PROMPTS_VERSION
                ? '（已是最新）'
                : `（⚠️ 落后于内置的第 ${BUILTIN_PROMPTS_VERSION} 版 —— 重启酒馆会自动升级）`),
        `时间：${new Date().toISOString()}`,
        '公开报告：默认不包含剧情或用户文本',
        '',
        `## 环境`,
        `酒馆助手：${probe.tavernHelper ? '有' : '无'}`,
        `连接配置服务：${probe.profileService ? '有' : '无'}（${probe.profiles.length} 个配置）`,
        `通道就绪：${Boolean(app.channelStatus()?.ready)}`,
        `通道模式：${LLM_MODES.includes(app.settings?.llm?.mode) ? app.settings.llm.mode : 'unknown'}`,
        ...(includeStory ? ['', '## 状态（主动包含）', JSON.stringify(redactDiagnostics(app.state(), app.settings), null, 2), '', '## 设置（主动包含）', JSON.stringify(redactDiagnostics(app.settings), null, 2)] : []),
    ].join('\n'), app.settings);
}

// ===========================================================================
// 二、外壳 A：插件自己的设置窗（点悬浮窗打开的那个）
// ===========================================================================

/**
 * 创建插件的独立设置窗。
 *
 * ── 为什么需要它（用户实测反馈）
 *
 * 第一版「点头像」只是把酒馆的扩展设置侧栏滚出来。用户的反应是
 * 「你添加的设置就在右边是什么意思？不可以写一个插件单独的 api 设置界面让我进去填写吗？」
 * —— 完全合理：点一个小精灵，结果右边的侧栏自己动了，这不是任何人期待的行为。
 *
 * 所以这个窗是**主要入口**：标签页 + 完整设置，全部在插件自己的界面里完成，
 * 不需要用户知道酒馆的扩展设置在哪。
 *
 * ── 交互
 *
 * - 点头像 / `/bg-config` 打开；遮罩、Esc、右上角 × 都能关
 * - 标签页在左侧竖排（像设置中心），窄屏自动变成横排滚动
 * - 每改一项即时落盘，没有「保存」按钮
 *
 * @param {{app: any, onOpen?: () => void, onClose?: () => void}} opts
 * @returns {{node: any, open: (tab?: string) => void, close: () => void, isOpen: boolean, setTab: (id: string) => void}}
 */
export function createSettingsWindow({ app, onOpen, onClose }) {
    let open = false;
    /** @type {string} */
    let activeTab = 'llm';
    const recap = { spoilers: false, clearArmed: false, epoch: 0 };
    let returnFocus;

    const overlay = el('div', { class: `${CSS_PREFIX}win-overlay` });
    const card = el('div', { class: `${CSS_PREFIX}win-card`, role: 'dialog', 'aria-modal': 'true', 'aria-label': '碧翠丝设置', tabindex: '-1' });
    const tabBar = el('div', { class: `${CSS_PREFIX}win-tabs`, 'aria-label': '设置分类' });
    const panelHost = el('div', { class: `${CSS_PREFIX}win-panel`, role: 'region' });
    const footNote = el('div', { class: `${CSS_PREFIX}win-foot` });

    // ── 头部 ────────────────────────────────────────────────────────────
    const closeBtn = el('button', { class: `${CSS_PREFIX}win-close`, type: 'button', title: '关闭（Esc）' }, '×');
    on(closeBtn, 'click', () => close());

    const avatarSrc = modeImageUrl(app.settings, 'portrait');
    const portrait = el('img', { class: `${CSS_PREFIX}win-portrait`, src: avatarSrc, alt: guideName(app.settings) });
    const title = el('div', { class: `${CSS_PREFIX}win-title` });
    const subtitle = el('div', { class: `${CSS_PREFIX}win-sub` });
    if (portrait) {
        // 立绘加载不出来时**把自己移除**，而不是留一个碎裂的图标占着位置。
        // 触发条件：用户把 assets/ 删了、自定义路径写错、或者插件目录名推导失败。
        // 少一张头像不影响任何功能，但裂图会让用户以为插件坏了。
        on(portrait, 'error', () => {
            console.warn('[碧翠丝] 设置窗里的立绘加载失败，已隐藏');
            portrait.hidden = true;
        });
    }

    card.appendChild(
        el('div', { class: `${CSS_PREFIX}win-head` }, [
            portrait,
            el('div', { class: `${CSS_PREFIX}win-headtext` }, [
                title,
                subtitle,
            ]),
            closeBtn,
        ]),
    );

    card.appendChild(el('div', { class: `${CSS_PREFIX}win-body` }, [tabBar, panelHost]));
    card.appendChild(footNote);
    overlay.appendChild(card);

    /** 重画当前标签页的内容。 */
    const render = () => {
        recap.cancel?.();
        recap.epoch++;
        const settings = app.settings;
        overlay.dataset.bgRealm = isVoid(settings) ? 'void' : 'beatrice';
        title.textContent = isVoid(settings) ? `无之空间 · ${guideName(settings)}` : `🦋 ${EXT_NAME}`;
        subtitle.textContent = `${guideName(settings)}读取你勾选的世界书，用独立辅助 API 给出剧情引导，不占正文模型。`;
        const src = modeImageUrl(settings, 'portrait');
        if (portrait.getAttribute?.('src') !== src) {
            portrait.setAttribute?.('src', src);
            portrait.hidden = !src;
        }
        portrait.setAttribute?.('alt', guideName(settings));
        const sections = buildConfigSections(app, render, recap);

        // 标签栏
        tabBar.replaceChildren?.();
        for (const sec of sections) {
            const tab = el('button', {
                class: `${CSS_PREFIX}win-tab`,
                type: 'button',
                'aria-pressed': sec.id === activeTab ? 'true' : 'false',
                dataset: { active: sec.id === activeTab ? '1' : '0' },
            }, [el('span', { class: `${CSS_PREFIX}win-tabicon`, text: sec.icon }), el('span', { text: sec.title })]);
            on(tab, 'click', () => {
                activeTab = sec.id;
                render();
            });
            tabBar.appendChild(tab);
        }

        // 内容
        const current = sections.find((sec) => sec.id === activeTab) ?? sections[0];
        panelHost.setAttribute?.('aria-label', current.title);
        panelHost.replaceChildren?.();
        panelHost.appendChild(el('h4', { class: `${CSS_PREFIX}win-h`, text: `${current.icon} ${current.title}` }));
        for (const node of current.body) if (node) panelHost.appendChild(node);

        // 底部状态：一眼看出「现在能不能说话」
        const status = app.channelStatus();
        const bookGuard = app.realmWorldbookGuard?.status?.();
        footNote.replaceChildren?.(
            note(bookGuard?.supported
                ? (isVoid(settings) ? '人神对抗规则：允许已挂载世界书参与生成（保留原禁用设置）。' : '人神对抗规则：生成前自动关闭，不影响其他世界书。')
                : '⚠️ 宿主未确认支持自动开关人神规则；碧翠丝模式请手动取消挂载该书。', bookGuard?.supported ? 'ok' : 'warn'),
            note(
                status.ready
                    ? `✅ 通道已就绪 —— ${guideName(settings)}可以开始观测。`
                    : `⚠️ ${status.reason}`,
                status.ready ? 'ok' : 'warn',
            ),
            button(isVoid(settings) ? '返回碧翠丝的禁书库' : '进入无之空间', async () => {
                // Do not switch a live request's persona, including manual API tests.
                const busy = typeof app.isBusy === 'function'
                    ? app.isBusy()
                    : Boolean(app.inflight || app.abort || app._poolBuilding || app.state?.()?.inflight);
                if (busy) {
                    toast('正在观测或读取世界书，请等待当前请求结束后再切换空间。', 'warning');
                    return;
                }
                settings.realm = isVoid(settings) ? 'beatrice' : 'void';
                app.ui?.hide?.();
                app.ui?.setTyping?.(false);
                await app.persistSettings();
                await app.syncAdversaryDirector?.();
                recap.spoilers = false;
                recap.endedSpoilers = false;
                recap.memorySources = false;
                recap.memoryDelete = null;
                recap.clearArmed = false;
                app.ui?.refresh?.();
                app.log?.(`已切换空间：${isVoid(settings) ? '无之空间' : '碧翠丝'}`);
                render();
            }, { variant: 'primary', title: '切换空间（两个角色的人设分别保存）' }),
        );
    };

    /** 打开设置窗。 */
    function openWin(/** @type {string} */ tab) {
        if (open) {
            if (tab) {
                activeTab = tab;
                render();
            }
            return;
        }
        returnFocus = globalThis.document?.activeElement;
        open = true;
        overlay.dataset.open = '1';
        if (tab) activeTab = tab;
        render();
        // 焦点给到第一个可交互控件：键盘用户能立刻操作
        try {
            panelHost.querySelector?.('select, input, textarea, button')?.focus?.();
        } catch {
            /* ignore */
        }
        onOpen?.();
    }

    function close() {
        if (!open) return;
        open = false;
        recap.spoilers = false;
        recap.endedSpoilers = false;
        recap.memorySources = false;
        recap.memoryDelete = null;
        recap.clearArmed = false;
        recap.cancel?.();
        recap.epoch++;
        panelHost.replaceChildren?.(); // Remove revealed secrets without scheduling a hidden tab's work.
        overlay.dataset.open = '0';
        if (returnFocus?.isConnected !== false) returnFocus?.focus?.();
        returnFocus = null;
        onClose?.();
    }

    /** 直接切到某个标签页（可供外部调用）。 */
    function setTab(/** @type {string} */ id) {
        activeTab = id;
        if (open) render();
    }

    on(overlay, 'click', (/** @type {any} */ e) => {
        if (e.target === overlay) close();
    });
    on(/** @type {any} */ (globalThis)?.window ?? overlay, 'keydown', (/** @type {any} */ e) => {
        if (!open) return;
        if (e.key === 'Escape') { e.preventDefault?.(); close(); }
        if (e.key === 'Tab') {
            const controls = [...(card.querySelectorAll?.('button, input, select, textarea, [tabindex]') ?? [])]
                .filter(n => !n.disabled && !n.hidden && n.getAttribute?.('tabindex') !== '-1' && !(n.closest?.('[hidden]')) && (n.getClientRects ? n.getClientRects().length > 0 : n.style?.display !== 'none'));
            const first = controls[0] ?? card;
            const last = controls.at(-1) ?? card;
            const active = globalThis.document?.activeElement;
            if (!controls.includes(active) || (e.shiftKey ? active === first : active === last)) {
                e.preventDefault?.();
                (e.shiftKey ? last : first).focus?.();
            }
        }
    });

    render();

    return {
        node: overlay,
        open: openWin,
        close,
        setTab,
        get isOpen() {
            return open;
        },
    };
}
