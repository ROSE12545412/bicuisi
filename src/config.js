/**
 * 碧翠丝的禁书库 / src/config.js
 * ---------------------------------------------------------------------------
 * 扩展身份、默认设置、设置深补全。
 *
 * 关键约定（沿用本机实测结论）：
 *  - `extensionSettings` 的键名与 manifest 的 display_name 无关，用我们自己的 ID。
 *  - 设置**必须手动落盘**（saveSettingsDebounced），不会自动保存。
 *  - 老用户升级后新增设置项要有默认值，所以读取时必须逐字段深补全，
 *    而且补全要**就地写回**，否则界面渲染的默认值和实际生效值会对不上。
 */

import { normalizeApiPresets } from './api-presets.js';

/** 扩展 ID，用作 extensionSettings / chatMetadata 的键。 */
export const EXT_ID = 'beatrice-guide';

/** 扩展显示名。 */
/**
 * **代码修订号** —— 每次改动行为就改它。
 *
 * ⚠️ 为什么不能只靠 `manifest.json` 的 `version`：
 *
 * 那个号是给酒馆的扩展管理器做版本比较用的，只在"发布新版"时才动。
 * 而实际排查中（用户反馈"更新了但没变化"）需要的是**区分两个构建**。
 * 因为它从第一天起一直是 1.0.0，导致：
 *   · 用户贴出诊断，我看不出他跑的是哪一版
 *   · 用户自己也看不出"我的更新到底生效了没有"
 * 白绕了一轮才靠「有没有 hasPending 字段」这种间接证据判断出来。
 *
 * 所以单独加这个号：`诊断页`、`/bg-status`、`/bg-test` 都会显示它。
 * 判断"更新生效了吗"只需要对比这一个字符串。
 */
export const CODE_REVISION = 'r2026-10-12.37';

export const EXT_NAME = '碧翠丝的禁书库';

/** 日志前缀。 */
export const TAG = `[${EXT_NAME}]`;

/** 设置存 `ctx.extensionSettings[SETTINGS_KEY]`。 */
export const SETTINGS_KEY = 'beatriceGuide';

/** 每个聊天的私有数据存 `ctx.chatMetadata[CHAT_KEY]`。 */
export const CHAT_KEY = 'beatrice-guide';

/** 所有 CSS class 前缀，避免污染酒馆自身样式。 */
export const CSS_PREFIX = 'bg-';

/**
 * 从 `import.meta.url` 推导扩展所在目录名。
 *
 * 不写死目录名：用户可能把文件夹改名（装成 `beatrice-guide-main`），
 * 也可能放在 `third-party/` 下。这个值用于拼内置图片资源的相对路径。
 *
 * @param {string} moduleUrl `import.meta.url`
 * @returns {string}
 */
export function deriveExtensionFolder(moduleUrl) {
    const url = String(moduleUrl ?? '');
    const segments = url.split('/').filter(Boolean);
    const extIndex = segments.indexOf('extensions');
    if (extIndex >= 0) {
        for (let i = extIndex + 1; i < segments.length; i++) {
            const seg = segments[i].split(/[?#]/)[0];
            if (seg === 'third-party') continue;
            if (!seg || seg.includes('.')) break;
            return seg;
        }
    }
    const match = url.match(/\/extensions\/(?:third-party\/)?([^/?#]+)\//);
    if (match && !match[1].includes('.')) return match[1];
    return EXT_ID;
}

/** 情绪枚举。与 CONTRACTS.md §4 一致，UI 用它切换表情/浮窗配色。 */
export const EMOTIONS = Object.freeze(['calm', 'smug', 'annoyed', 'worried', 'smile', 'thinking']);

/** LLM 通道模式。 */
export const LLM_MODES = Object.freeze(['profile', 'tavern-helper', 'custom', 'main']);

/** 引导节奏模式。 */
export const CADENCE_MODES = Object.freeze(['every-n', 'probability', 'always']);

/** 两段式的第一段（先定位再取材）什么时候跑。 */
export const LOCATE_MODES = Object.freeze(['auto', 'on', 'off']);

/**
 * 默认设置。**每次调用返回全新对象**，避免多处共享同一份引用被改坏。
 * @returns {object}
 */
export function defaultSettings() {
    return {
        schemaVersion: 1,
        enabled: true,
        realm: 'beatrice',
        // 自愿启用，且仅在人神模式生效；不影响原有普通引导。
        adversary: { enabled: false, allowDeath: false, maxPlots: 3 },
        // 独立保存人神人设；切换模式不覆盖贝翠丝的任何配置。
        voidPersona: {
            prompts: [],
            overridePrompt: '',
        },

        cadence: {
            mode: 'every-n',
            everyN: 2,
            probability: 0.5,
            cooldownMs: 20000,
        },

        worldbook: {
            /** 空数组 = 自动发现（角色卡绑定 / 本聊天 / 全局勾选） */
            bookNames: [],

            /**
             * 手动标签白名单。**默认空 = 不用标签，让 AI 读懂内容来判断**。
             *
             * ── 这里改过一次设计，原因是用户一句话点破了前提
             *
             * 原设计：「只读标了 [引导] 标签的条目」，并让用户/作者去标标签。
             * 用户的原话：
             *   「这句话不对，没有写卡作者会为了我们的插件来特地制定剧情条目。
             *     如果 ai 帮选你应该把提示词做好，让 ai 仔细阅读世界书里的内容
             *     确定哪些是剧情条目。」
             *
             * 完全成立 —— 指望卡作者为某个第三方插件改自己的世界书是不现实的，
             * 这个前提从一开始就是错的。所以默认改成：**读全部条目，由 AI 判断
             * 哪些是剧情条目**。
             *
             * 这个白名单保留下来，但降级成**可选的手动硬过滤**：
             * 填了内容就只读命中这些标签的条目（作者确实标了标签时更省 token），
             * 留空则由 AI 全权判断。
             */
            tags: [],

            /**
             * 硬排除标签。命中这些的条目**无论 AI 怎么判断都不读**。
             *
             * 保留这个是因为它和「筛选」不是一回事：这是作者/用户主动声明的
             * 「这块别碰」，比如 `[禁止引导]`、`[剧透]`。AI 再聪明也不该覆盖它。
             */
            excludeTags: ['禁止引导', '剧透', '勿引导'],

            /** 一次最多取多少条线索进提示词 */
            maxHooks: 24,
            /** 单条线索正文截断长度 */
            maxHookChars: 300,

            /**
             * AI 筛选时一次最多读多少条条目、总字符上限。
             *
             * 太小的世界书不够挑，太大的一次塞不下 —— 所以有上限，
             * 超出的部分在提示词里明确告诉模型「还有 N 条没列出来」，
             * 避免它以为清单就是全部。
             */
            scanMaxEntries: 600,

            /**
             * 每条条目送给 AI 的正文长度（字符）。
             *
             * ⚠️ **判据是正文，不是标题**。标题常常毫无信息（「设定补充」），
             * 而真正能用的钩子藏在正文里 —— 所以这个值太小会让 AI 判断不准。
             * 默认 400：够看到一段完整描述，又不至于几条就吃满预算。
             */
            scanCharsPerEntry: 400,
            scanMaxChars: 120000,
            /** 分批预算而非整本书截断上限；所有批次覆盖全部正文。 */
            scanBatchChars: 24000,
            scanBatchEntries: 24,

            /** 常量条目（蓝灯）也纳入候选 —— 世界观设定有助于判断当前局势 */
            includeConstantEntries: true,

            /**
             * 线索池的有效期（毫秒）。超过就重新让 AI 筛一遍。
             *
             * 为什么不每次调用都重筛：筛一遍要把整本世界书发给模型，
             * 每 2 轮做一次既慢又贵。而剧情条目本身变化很慢（作者改书才会变），
             * 所以筛一次缓存着用，过期或世界书变动时再筛。
             */
            poolTtlMs: 6 * 60 * 60 * 1000,

            /**
             * 通读那一步产出的是**索引**还是**筛选结果**。
             *
             * ── 这里又改过一次设计，理由同样值得写下来
             *
             * 原设计：通读时直接挑出「能用来推进剧情」的条目（上限约 15%）。
             * 用户一句话指出了它的漏洞：
             *   「那你就不能让读表 ai 读一下正文判断目前是第几章
             *     然后寻找对应章节的对应剧情给出提示吗」
             *
             * 成立，而且戳的正是原设计的要害 —— 通读是在**完全不知道剧情演到哪**
             * 的情况下判断「这条有没有用」的。这是个没有上下文的问题：
             * 有没有用取决于你在第几章。当时没被挑中的条目，
             * 之后每一轮都不会再看到，**哪怕它恰好就是这轮最该用的**。
             * 这个损失不可逆，是这套设计里唯一的硬伤。
             *
             * 现在：通读只负责**编索引** —— 给每条一句话摘要 + 标注它在剧情
             * 哪个阶段才有意义。基本不淘汰（只丢纯数值表和空条目）。
             * 引导时先拿正文判断「现在演到哪」，再从索引里取对应条目的**原文**。
             *
             * 代价是多一次 API 往返（见 `locate`），换来的是没有再丢掉任何条目。
             */
            buildIndex: true,

            /**
             * 一次索引最多收多少条。
             *
             * 比 `maxHooks` 大得多 —— 索引的价值就在于**广**，
             * 窄了就又变回「筛选」，白改了这一版。
             */
            maxIndexEntries: 400,
        },

        guidance: {
            enabled: true,
            maxChars: 60,
            /** 硬约束：只给铺垫与暗示，不许直接点名目的地 */
            hintOnly: true,

            /**
             * 两段式里的第一段：先读正文判断「现在演到哪」，再决定要看哪几条原文。
             *
             * `auto` = 索引条数多于 `locateMinHooks` 时才做。
             * 为什么要有 auto：索引只有几条时，把全部原文直接发过去
             * 比多一次往返又便宜又准 —— 定位这一步没有意义。
             */
            locate: 'auto',
            /** auto 模式下，索引超过这个条数才值得多跑一次定位 */
            locateMinHooks: 12,
            /** 定位那一步最多让它挑几条（多给几条原文，写的时候更有余地） */
            locateMaxPick: 4,
        },

        commentary: {
            enabled: true,
            maxChars: 70,
            /** 是否允许补第二句 */
            allowFollowUp: false,
        },

        llm: {
            mode: 'profile',
            profileId: '',
            custom: {
                url: '',
                key: '',
                model: '',
                /**
                 * 「拉取模型」拿到的列表，缓存下来。
                 *
                 * 为什么存进设置而不是只放在内存里：设置面板每次改动都会整个重画
                 *（见 panel.js 的 render），列表只存在内存里的话，用户改一下温度
                 * 下拉框就空了，得重新拉一次。存下来也让下次开面板不用再拉。
                 */
                modelList: /** @type {string[]} */ ([]),
            },
            temperature: 1.0,
            maxTokens: 800,
            structuredMaxTokens: 8192,
            timeoutMs: 45000,
        },

        apiPresets: [],
        apiRoutes: { facts: '', locate: '', assess: '', compose: '' },

        injection: {
            /**
             * 引导怎么呈现：
             *  - 'append'  接在**正文末尾**，作为她突然插话的一段（默认。
             *              正文本身一个字节都不改，只在渲染层把她的台词接上去）
             *  - 'message' 作为一条独立的隐藏小字系统消息（旧行为，保留给喜欢分行的人）
             *  - 'off'     只走悬浮窗气泡，不进聊天记录
             */
            mode: 'append',
            isSmallSys: true,
            speakerName: '贝翠丝',
            maxChars: 600,
        },

        ui: {
            showAvatar: true,
            avatarPos: { x: 24, y: 220 },
            avatarSize: 96,
            /** 'auto' | 'left' | 'right' */
            bubbleSide: 'auto',
            /** 气泡自动收起时间（毫秒），0 = 常驻不自动消失 */
            bubbleDurationMs: 15000,
            idleAnimation: true,
            /** 自定义立绘：相对扩展目录的路径，空则用内置 PNG */
            customImage: '',
        },

        persona: {
            name: '贝翠丝',
            /**
             * 人设提示词，**按分段组织**（像酒馆的「提示词管理器」）。
             *
             * 为什么不是一个整段大字符串：整段文本里用户想改一句话就得在几千字里找，
             * 也没法单独关掉某一条规则。分段之后每条可以独立开关、编辑、上下移动 ——
             * 想让她这次少吐槽一点，关掉「吐槽规则」那一条就行。
             *
             * 结构：{ id, role, content, enabled }
             *  - role: 'system' | 'user' | 'assistant'
             *  - 空数组 = 用内置默认（见 prompts.js 的 defaultPersonaPrompts）
             *
             * ⚠️ 这里踩过一个很隐蔽的坑，值得完整记下来。
             *
             * 编辑器为了让用户能改，会在打开时把**内置默认写进 settings** ——
             * 一旦写进去，它就成了「用户配置」，`resolvePersonaPrompts` 从此只认它、
             * 不再看内置默认。
             *
             * 后果：后来每一次提示词改进（加「接当前处境」「不照搬条目」
             * 「读正文再判断」…）对**已经打开过设置窗的用户全部无效**。
             * 用户看到的还是几个月前那版文案，而且完全不知道为什么「更新了却没变化」。
             *
             * 修法：给内置默认打版本号（`promptsVersion`），加载时对比 ——
             *   · 存的内容 == 某个旧版内置的原文（说明没被手改）→ 换成新版内置
             *   · 用户改过任何一条 → 一条都不动（那是他的东西）
             *   · 版本相同 → 什么都不做
             */
            prompts: /** @type {Array<{id: string, role: string, content: string, enabled: boolean}>} */ ([]),
            /** 当前 `prompts` 来自哪一版内置默认（0 = 用户自己写的 / 未知）。 */
            promptsVersion: 0,
            /** 非空则整段替换内置人设（老字段，保留兼容） */
            overridePrompt: '',
        },
    };
}

/** 判断是不是「普通对象」（不是数组、不是 null）。 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 按模板类型把值转成正确的类型，转不动就退回模板值。 */
function coerce(value, template) {
    if (typeof template === 'number') {
        const n = Number(value);
        return Number.isFinite(n) ? n : template;
    }
    if (typeof template === 'boolean') return typeof value === 'boolean' ? value : template;
    if (typeof template === 'string') return typeof value === 'string' ? value : template;
    if (Array.isArray(template)) {
        if (!Array.isArray(value)) return template.slice();

        // ⚠️ 空数组模板必须**原样保留**，不能按类型过滤。
        //
        // 这里踩过一个把用户输入整个吃掉的 bug。原来的写法是：
        //     if (!template.length) return value.filter((v) => typeof v === 'string');
        // 也就是「空模板数组 = 只留字符串项」。当时脑子里想的是 tags 那种字符串数组，
        // 但 `persona.prompts` 是一个**对象数组**、默认值又恰好是 `[]` ——
        // 于是用户在人设提示词编辑器里写的每一条，都会在 `getSettings()` 补全时
        // 被静默滤掉，表现成「设置保存不了，改完就没了」。
        //
        // 空数组只说明「默认没有内容」，**不说明元素类型是字符串**。
        // 元素级校验交给各自的 normalize（例如 normalizePersonaPrompts），
        // 那一层才知道该怎么清洗坏元素。
        if (!template.length) return value.slice();

        // 模板里有样例元素 → 按首元素类型逐个转换（转不动的丢掉）
        return value.map((v) => coerce(v, template[0])).filter((v) => v !== undefined && v !== null);
    }
    return value === undefined ? template : value;
}

/**
 * 把用户设置深补全到 `template` 的形状。
 *
 * 规则：
 *  - 缺失字段 → 补默认值
 *  - 类型不符 → 用默认值覆盖（例如用户手改配置写了个字符串 `"2"` 给数字字段）
 *  - 多余字段 → **保留**（前向兼容：新版本写的字段被老版本读到时不被抹掉）
 *  - 就地写入 `target`，调用方拿到的是补全后的同一个对象引用
 *
 * @template T
 * @param {any} target
 * @param {T} template
 * @returns {T}
 */
export function deepDefaults(target, template) {
    if (!isPlainObject(template)) return /** @type {any} */ (target ?? template);
    if (!isPlainObject(target)) return JSON.parse(JSON.stringify(template));

    for (const [key, tplValue] of Object.entries(template)) {
        const current = target[key];
        if (isPlainObject(tplValue)) {
            target[key] = deepDefaults(current, tplValue);
        } else if (current === undefined || current === null) {
            target[key] = Array.isArray(tplValue) ? tplValue.slice() : coerce(undefined, tplValue);
        } else {
            target[key] = coerce(current, tplValue);
        }
    }
    return target;
}

/**
 * 归一化：把越界的数值夹回合法区间，把非法枚举退回默认。
 * 设置面板允许自由输入，所以这里必须兜一道。
 * @param {any} settings 已经过 deepDefaults 的对象
 * @returns {any} 同一个对象
 */
export function normalizeSettings(settings) {
    const s = settings;

    if (!['beatrice', 'void'].includes(s.realm)) s.realm = 'beatrice';
    s.voidPersona = deepDefaults(s.voidPersona, { prompts: [], overridePrompt: '' });
    s.voidPersona.prompts = normalizePersonaPrompts(s.voidPersona.prompts);
    s.adversary = deepDefaults(s.adversary, { enabled: false, allowDeath: false, maxPlots: 3 });
    s.adversary.enabled = s.adversary.enabled === true;
    s.adversary.allowDeath = s.adversary.allowDeath === true;
    s.adversary.maxPlots = clampInt(s.adversary.maxPlots, 1, 3, 3);

    s.cadence.everyN = clampInt(s.cadence.everyN, 1, 20, 2);
    s.cadence.probability = clampNum(s.cadence.probability, 0, 1, 0.5);
    s.cadence.cooldownMs = clampInt(s.cadence.cooldownMs, 0, 600000, 20000);
    if (!CADENCE_MODES.includes(s.cadence.mode)) s.cadence.mode = 'every-n';

    s.worldbook.maxHooks = clampInt(s.worldbook.maxHooks, 1, 200, 24);
    s.worldbook.maxHookChars = clampInt(s.worldbook.maxHookChars, 40, 4000, 300);
    s.worldbook.scanMaxEntries = clampInt(s.worldbook.scanMaxEntries, 50, 5000, 600);
    s.worldbook.scanMaxChars = clampInt(s.worldbook.scanMaxChars, 5000, 2000000, 120000);
    s.worldbook.scanBatchChars = clampInt(s.worldbook.scanBatchChars, 512, 24000, 24000);
    s.worldbook.scanBatchEntries = clampInt(s.worldbook.scanBatchEntries, 1, 24, 24);
    s.worldbook.scanCharsPerEntry = clampInt(s.worldbook.scanCharsPerEntry, 40, 4000, 400);
    s.worldbook.poolTtlMs = clampInt(s.worldbook.poolTtlMs, 60000, 30 * 24 * 3600 * 1000, 6 * 3600 * 1000);
    s.worldbook.tags = cleanStringList(s.worldbook.tags, 32);
    s.worldbook.excludeTags = cleanStringList(s.worldbook.excludeTags, 32);
    s.worldbook.bookNames = cleanStringList(s.worldbook.bookNames, 64);
    s.worldbook.buildIndex = s.worldbook.buildIndex !== false;
    s.worldbook.maxIndexEntries = clampInt(s.worldbook.maxIndexEntries, 20, 5000, 400);

    s.guidance.maxChars = clampInt(s.guidance.maxChars, 10, 400, 60);
    s.guidance.locateMinHooks = clampInt(s.guidance.locateMinHooks, 1, 500, 12);
    s.guidance.locateMaxPick = clampInt(s.guidance.locateMaxPick, 1, 30, 4);
    if (!LOCATE_MODES.includes(s.guidance.locate)) s.guidance.locate = 'auto';
    s.commentary.maxChars = clampInt(s.commentary.maxChars, 5, 400, 40);

    if (!LLM_MODES.includes(s.llm.mode)) s.llm.mode = 'profile';
    s.llm.temperature = clampNum(s.llm.temperature, 0, 2, 1.0);
    s.llm.maxTokens = clampInt(s.llm.maxTokens, 32, 32768, 800);
    s.llm.structuredMaxTokens = clampInt(s.llm.structuredMaxTokens, 0, 32768, 8192);
    s.llm.timeoutMs = clampInt(s.llm.timeoutMs, 3000, 300000, 45000);
    // 缓存的模型列表：去重、去空、限长（防止有人手改设置塞进来几万条）
    s.llm.custom.modelList = cleanStringList(s.llm.custom.modelList, 500);

    if (!['appended', 'append', 'message', 'off'].includes(s.injection.mode)) s.injection.mode = 'append';
    // 老配置迁移：'appended' 是旧名字，语义等于「独立小字消息」
    if (s.injection.mode === 'appended') s.injection.mode = 'message';
    s.injection.maxChars = clampInt(s.injection.maxChars, 60, 8000, 600);

    s.ui.avatarSize = clampInt(s.ui.avatarSize, 48, 256, 96);
    s.ui.bubbleDurationMs = clampInt(s.ui.bubbleDurationMs, 0, 600000, 15000);
    if (!['auto', 'left', 'right'].includes(s.ui.bubbleSide)) s.ui.bubbleSide = 'auto';
    const pos = isPlainObject(s.ui.avatarPos) ? s.ui.avatarPos : {};
    s.ui.avatarPos = {
        x: clampInt(pos.x, -2000, 12000, 24),
        y: clampInt(pos.y, -2000, 12000, 220),
    };

    // 人设分段：逐条清洗。坏数据（不是数组 / 缺字段 / 角色非法）一律丢掉，
    // 而不是让一条畸形数据把整个提示词组装搞崩。
    s.persona.prompts = normalizePersonaPrompts(s.persona.prompts);
    s.persona.promptsVersion = clampInt(s.persona.promptsVersion, 0, 999, 0);

    normalizeApiPresets(s);
    return s;
}

/** 合法的提示词角色。 */
export const PROMPT_ROLES = Object.freeze(['system', 'user', 'assistant']);

/**
 * 清洗人设分段数组。
 *
 * 设计取舍：**空数组是合法的**，表示「用内置默认人设」。
 * 所以这里不能自作主张塞默认值进去 —— 那会让「用户清空了所有分段」
 * 和「用户从没配过」两种状态混在一起，界面上就分不清了。
 *
 * @param {any} value
 * @returns {Array<{id: string, role: string, content: string, enabled: boolean}>}
 */
export function normalizePersonaPrompts(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const raw of value) {
        if (!isPlainObject(raw)) continue;
        const content = String(raw.content ?? '');
        if (!content.trim()) continue; // 空内容的分段留着没意义，界面上也点不动
        const role = PROMPT_ROLES.includes(String(raw.role)) ? String(raw.role) : 'system';
        out.push({
            id: String(raw.id ?? `p${out.length + 1}`),
            role,
            content,
            // 缺 enabled 视为启用（用户手写配置时不该被迫写这个字段）
            enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
        });
    }
    return out;
}

/** 夹取整数。 */
export function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** 夹取浮点数。 */
export function clampNum(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** 清洗字符串数组：去空白、去重、去空项、限长。 */
export function cleanStringList(value, maxItems = 64) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
        const s = String(item ?? '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= maxItems) break;
    }
    return out;
}

/**
 * 解析「用逗号/空格分隔的一行文本」为字符串数组。
 * 设置面板里 tags 这类字段就是一个输入框，用这个函数还原成数组。
 * 半角/全角逗号、顿号、换行都当分隔符。
 * @param {string} text
 * @returns {string[]}
 */
export function parseListInput(text) {
    return cleanStringList(
        String(text ?? '')
            .split(/[,，、\n\r\t]+/)
            .map((s) => s.trim()),
        64,
    );
}

/** 把字符串数组还原成输入框里的一行文本。 */
export function formatListInput(list) {
    return Array.isArray(list) ? list.join('，') : '';
}
