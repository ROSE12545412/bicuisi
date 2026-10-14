/**
 * 碧翠丝的禁书库 / src/core/store.js
 * ---------------------------------------------------------------------------
 * 持久化层。两类数据分开存：
 *
 * | 数据 | 存哪 | 为什么 |
 * |---|---|---|
 * | 设置（开关、节奏、通道、UI） | `ctx.extensionSettings[SETTINGS_KEY]` | 跨聊天共享，跟人走 |
 * | 每个聊天的记忆（说过什么、第几轮） | `ctx.chatMetadata[CHAT_KEY]` | **跟聊天走**：换一张卡/新开聊天就是全新记忆，天然满足「不要在另一条剧情线上复用同一句引导」 |
 *
 * 关键陷阱（本机实测）：
 *  - 两者都**不会自动落盘**，必须显式 save。
 *  - 群聊里 `ctx.saveChat()` 会抛异常，`saveMetadata()` 才是安全的。
 *  - `saveChat()` 会**静默吞掉错误**，所以重要写入要自己 try/catch 并回报。
 */

import {
    CHAT_KEY,
    EXT_ID,
    SETTINGS_KEY,
    deepDefaults,
    defaultSettings,
    normalizeSettings,
} from '../config.js';
import { describeError } from '../llm/client.js';

/** 聊天私有数据的结构版本。结构变化时递增，用于迁移。 */
export const DATA_VERSION = 1;

/** 去重记忆最多保留多少条（一条引导通常 20~60 字，200 条足够覆盖一个长聊天）。 */
const MAX_SPOKEN = 200;

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function isRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** Imported JSON may contain dangerous own keys at any depth. Never assign them. */
function safeImportValue(value, seen = new Set()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) throw new Error('配置对象不能包含循环引用');
    if (!Array.isArray(value) && !isRecord(value)) throw new Error('配置必须是普通 JSON 对象');
    seen.add(value);
    const copy = Array.isArray(value) ? value.map(item => safeImportValue(item, seen)) : {};
    if (!Array.isArray(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (!UNSAFE_KEYS.has(key)) copy[key] = safeImportValue(item, seen);
        }
    }
    seen.delete(value);
    return copy;
}

/**
 * 取设置对象（带深度默认值补全 + 归一化）。
 *
 * 补全结果**就地写回** ctx.extensionSettings —— 否则界面渲染的默认值
 * 与实际生效值会不一致（面板显示「每 2 轮」，实际因为字段缺失而按 0 处理）。
 *
 * @param {any} ctx
 * @returns {any} 永远是同一个对象引用（多次调用返回同一个），改完记得 saveSettings
 */
export function getSettings(ctx) {
    const container = ensureExtensionSettingsContainer(ctx);
    if (!container) {
        // 连 extensionSettings 都拿不到（极端情况）→ 返回内存里的临时对象，
        // 让功能至少能在本次会话里跑起来，而不是直接崩。
        return normalizeSettings(deepDefaults({}, defaultSettings()));
    }

    const merged = deepDefaults(container[SETTINGS_KEY], defaultSettings());
    container[SETTINGS_KEY] = merged;
    return normalizeSettings(merged);
}

/** 安全地取 `ctx.extensionSettings`，不存在就尝试创建。 */
function ensureExtensionSettingsContainer(ctx) {
    try {
        if (!ctx) return null;
        if (!ctx.extensionSettings) ctx.extensionSettings = {};
        return ctx.extensionSettings;
    } catch {
        return null;
    }
}

/**
 * 落盘设置。
 *
 * ⚠️ 这个函数是 async 但**不要 await 它**：`saveSettingsDebounced` 本身就是
 * 防抖的，拖拽悬浮窗时每帧都会调它，await 会把调用点串行化造成卡顿。
 *
 * @param {any} ctx
 * @param {{ silent?: boolean }} [opts]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function saveSettings(ctx, opts = {}) {
    try {
        const fn = ctx?.saveSettingsDebounced;
        if (typeof fn === 'function') {
            await fn();
            return { ok: true };
        }
        // 有些宿主只给了 saveSettings
        const fallback = ctx?.saveSettings;
        if (typeof fallback === 'function') {
            await fallback();
            return { ok: true };
        }
        return { ok: false, error: '当前酒馆没有 saveSettingsDebounced / saveSettings' };
    } catch (e) {
        const error = describeError(e);
        if (!opts.silent) console.warn(`[碧翠丝] 保存设置失败：${error}`);
        return { ok: false, error };
    }
}

/** 一份空白的聊天数据。 */
export function blankChatData() {
    return {
        dataVersion: DATA_VERSION,
        /** 这个聊天里已经说过的引导/吐槽（用于去重，避免复读同一句暗示）。 */
        spoken: /** @type {string[]} */ ([]),
        /** 已经引导过的 AI 消息下标（幂等：同一条消息只引导一次）。 */
        guidedTurns: /** @type {number[]} */ ([]),
        /** 引导计数器，配合 cadence.mode === 'every-n' 使用。 */
        turnCounter: 0,
        /** 上一次成功引导的墙钟时间（用于 cooldownMs）。 */
        lastAt: 0,

        /**
         * **线索池**：由 AI 通读世界书筛出来的「剧情条目」，缓存起来复用。
         *
         * ── 为什么需要缓存这一层
         *
         * AI 判断「哪些条目是剧情条目」要通读整本书（可能几十万字），
         * 每 2 轮做一次既慢又贵。而这件事变化很慢 —— 只有作者改书才会变。
         * 所以筛一次存这里，之后每轮引导只读这一小把线索。
         *
         * 结构：`{ at: number, books: string[], hooks: Array<{book,uid,label,content,kind}> }`
         * @type {{at: number, books: string[], hooks: any[]}|null}
         */
        hookPool: null,

        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

/**
 * 读取当前聊天的私有数据。
 * @param {any} ctx
 * @returns {any} 永远是补全过的对象（不会返回 null）
 */
export function getChatData(ctx) {
    try {
        const meta = ctx?.chatMetadata;
        if (!meta || typeof meta !== 'object') return blankChatData();

        const raw = meta[CHAT_KEY];
        const data = raw && typeof raw === 'object' ? raw : {};
        return {
            ...blankChatData(),
            ...data,
            spoken: Array.isArray(data.spoken) ? data.spoken.filter((s) => typeof s === 'string') : [],
            guidedTurns: Array.isArray(data.guidedTurns)
                ? data.guidedTurns.filter((n) => Number.isFinite(Number(n))).map(Number)
                : [],
            turnCounter: Number(data.turnCounter) || 0,
            lastAt: Number(data.lastAt) || 0,
            // 线索池：结构不对就当没有（宁可重筛一次，也不要拿半截数据去引导）
            hookPool: isUsablePool(data.hookPool) ? data.hookPool : null,
        };
    } catch {
        return blankChatData();
    }
}

/** 判断线索池的结构是否可用。 */
function isUsablePool(/** @type {any} */ pool) {
    return Boolean(
        pool &&
            typeof pool === 'object' &&
            Number.isFinite(Number(pool.at)) &&
            Array.isArray(pool.hooks) &&
            pool.hooks.length > 0,
    );
}

/**
 * 存线索池。
 *
 * @param {any} data getChatData 的返回值
 * @param {any[]} hooks AI 筛出来的线索
 * @param {string[]} books 这批线索来自哪几本书（用于判断是否过期）
 */
export function setHookPool(data, hooks, books) {
    data.hookPool = {
        at: Date.now(),
        books: Array.isArray(books) ? books.map(String) : [],
        hooks: Array.isArray(hooks) ? hooks : [],
    };
    return data.hookPool;
}

/**
 * 线索池是否还能用。
 *
 * 三个失效条件：
 *  1. 没有池子
 *  2. 过期（`worldbook.poolTtlMs`）
 *  3. **书单变了**（用户换了书 / 换了聊天挂的书）—— 这时旧池子里的线索
 *     可能来自完全不同的世界观，必须重筛
 *
 * @param {any} data
 * @param {any} settings
 * @param {string[]} currentBooks 当前关联的书
 * @returns {boolean}
 */
export function isHookPoolFresh(data, settings, currentBooks) {
    const pool = data?.hookPool;
    if (!isUsablePool(pool)) return false;

    const ttl = Number(settings?.worldbook?.poolTtlMs) || 6 * 3600 * 1000;
    if (Date.now() - Number(pool.at) > ttl) return false;

    const want = [...(Array.isArray(currentBooks) ? currentBooks : [])].map(String).sort();
    const have = [...(pool.books ?? [])].map(String).sort();
    if (want.length !== have.length) return false;
    for (let i = 0; i < want.length; i++) if (want[i] !== have[i]) return false;

    return true;
}

/**
 * 取当前角色卡的稳定标识。
 *
 * ── 为什么需要它（这是一个真实的设计缺陷）
 *
 * 线索池原来只存在 `chatMetadata` 里 —— 也就是**跟聊天走**。带来两个问题：
 *
 *   ① 换一张角色卡开新聊天，如果两本书单碰巧一样、池子又没过期，
 *      旧池子会被当成新的用 —— 世界观完全不同，引导就串味了。
 *   ② 池子的归属不明确：用户没法回答「这个池子是哪来的」。
 *
 * 用户的要求是：「在哪个卡建立的线索就绑定哪个卡，不能混乱」。
 * 所以池子改成**跟着角色卡存**。
 *
 * 标识优先用 `avatar`（酒馆里就是文件名，最稳定），拿不到再退回
 * 「卡名 + 下标」—— 后者在卡的顺序变化时会失配，所以只是兜底。
 *
 * @param {any} ctx
 * @returns {string} 形如 `avatar:xxx.png`；拿不到返回空串
 */
export function characterKey(ctx) {
    return characterKeyInfo(ctx).key;
}

/**
 * 同上，但把「这个 key 是从哪来的、为什么没拿到」一并报出来。
 *
 * ── 为什么要这么啰嗦
 *
 * 用户实测报过：`建立失败：拿不到角色卡标识（可能还没选卡）`。
 * 他明明选着卡 —— 那句话里的「可能还没选卡」是**我猜的**，
 * 猜错了就等于把用户往错方向引，他只会去反复确认自己有没有选卡。
 *
 * 真实原因是 `getContext()` 的形状在不同酒馆实现里并不一致：
 * TauriTavern 与上游 SillyTavern 就不保证都给出 `characters[characterId]`。
 * 所以这里依次试几个来源，并且把**试过什么、拿到什么**记下来 ——
 * 下次再失败，报错本身就能定位，不用再靠猜。
 *
 * @param {any} ctx
 * @returns {{key: string, source: string, diag: string}}
 */
/**
 * 酒馆内部用的占位角色名。
 *
 * 装好酒馆、还没进过任何聊天时 `name2` 就是这个串。要是拿它当卡名，
 * **所有角色卡会共用同一个线索池** —— 世界观完全不同，引导就会串味，
 * 而这正是用户明确要求避免的（「在哪个卡建立的线索就绑定哪个卡」）。
 */
const PLACEHOLDER_CHARACTER_NAMES = new Set(['SillyTavern System', 'SillyTavern', 'System', '系统']);

/**
 * 从聊天记录里认当前角色名。
 *
 * AI 楼层自己带着 `name`（酒馆渲染时写进去的），比 `name2` 可靠 ——
 * TauriTavern 实测里 `ctx.characters` 不存在、`name2` 又是那个占位串，
 * 只有聊天记录还老老实实写着是谁在说话。
 *
 * 取**最后一条**非用户 / 非系统 / 非自家注入的消息：往前翻会遇到别的角色
 *（群聊、或用户中途换过卡），最近的这条才代表「现在是谁」。
 *
 * @param {any} ctx
 * @returns {string} 拿不到返回空串
 */
function characterNameFromChat(ctx) {
    try {
        const chat = ctx?.chat;
        if (!Array.isArray(chat)) return '';
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (!m || typeof m !== 'object') continue;
            if (m.is_user || m.is_system) continue;
            if (m.extra?.beatriceGuide?.injected) continue; // 我们自己塞的小字条
            const name = String(m.name ?? '').trim();
            if (name && !PLACEHOLDER_CHARACTER_NAMES.has(name)) return name;
        }
        return '';
    } catch {
        return '';
    }
}

/**
 * @param {any} ctx
 * @returns {{key: string, source: string, diag: string}}
 */
export function characterKeyInfo(ctx) {
    const tried = [];
    /** 从一个 characters 数组 + 下标里取标识。 */
    const fromList = (chars, chid) => {
        if (!Array.isArray(chars)) {
            tried.push(`characters 不是数组(${typeof chars})`);
            return '';
        }
        if (!Number.isFinite(chid) || chid < 0) {
            tried.push(`下标无效(${JSON.stringify(chid)})`);
            return '';
        }
        const card = chars[chid];
        if (!card) {
            tried.push(`characters[${chid}] 不存在(共 ${chars.length} 张)`);
            return '';
        }
        const avatar = String(card.avatar ?? '').trim();
        if (avatar) return `avatar:${avatar}`;
        const name = String(card.name ?? '').trim();
        if (name) return `name:${name}#${chid}`;
        return `index:#${chid}`;
    };

    try {
        // ① 首选：上下文自带的下标。avatar 是文件名，最稳定
        const k1 = fromList(ctx?.characters, Number(ctx?.characterId));
        if (k1) return { key: k1, source: 'ctx.characters[characterId]', diag: tried.join('；') };

        // ② 退路：酒馆把 arrays 挂成全局而没有透进 ctx（TauriTavern 实测有这种）
        try {
            const g = /** @type {any} */ (globalThis);
            const k2 = fromList(g?.characters, Number(g?.this_chid));
            if (k2) return { key: k2, source: 'globalThis.characters[this_chid]', diag: tried.join('；') };
        } catch {
            tried.push('读全局 characters 抛异常');
        }

        // ③ 再退：当前聊天的角色名。开着一个聊天就一定有值，
        //    缺点是同名卡会共用池子 —— 但比整条功能不可用强得多。
        //
        //    ⚠️ 酒馆的 `name2` **可能还是那个占位串**（装好酒馆、还没进过
        //    任何聊天时它就叫 `SillyTavern System`）。拿它当卡名意味着
        //    **所有卡共用同一个池子** —— 用户明确要求过「在哪个卡建立的
        //    线索就绑定哪个卡，不能混乱」，所以这个占位串要跳过。
        const name2 = String(ctx?.name2 ?? '').trim();
        if (name2 && !PLACEHOLDER_CHARACTER_NAMES.has(name2)) {
            return { key: `name:${name2}`, source: 'ctx.name2', diag: tried.join('；') };
        }

        // ④ 从聊天记录里认卡名：AI 楼层自己带着角色名，比 name2 可靠
        //   （TauriTavern 实测：ctx 里既没有 characters，name2 也是占位串）
        const fromChat = characterNameFromChat(ctx);
        if (fromChat) {
            return { key: `name:${fromChat}`, source: 'chat里的角色名', diag: tried.join('；') };
        }

        // ⑤ 群聊：没有单一角色卡，按群绑定
        const gid = ctx?.groupId ?? ctx?.selected_group;
        if (gid !== undefined && gid !== null && String(gid).trim() !== '') {
            return { key: `group:${String(gid).trim()}`, source: 'ctx.groupId', diag: tried.join('；') };
        }

        tried.push(name2 ? `name2 是占位串(${name2})` : 'name2 为空');
        tried.push('聊天里也没认到角色名');
        tried.push('没有 groupId');
    } catch (e) {
        tried.push(`抛异常：${e && e.message ? e.message : String(e)}`);
    }

    return { key: '', source: '', diag: tried.join('；') || '未知' };
}

/** 当前卡的名字（只用于界面显示）。 */
export function characterName(ctx) {
    try {
        const chid = Number(ctx?.characterId);
        const chars = ctx?.characters;
        if (Array.isArray(chars) && Number.isFinite(chid) && chid >= 0) {
            const name = String(chars[chid]?.name ?? '').trim();
            if (name) return name;
        }
        // 和 `characterKeyInfo` 保持同一套退路：下标查不到就用聊天里的角色名，
        // 否则会出现「池子建起来了，但界面显示的归属是空的」这种半截状态。
        // 占位串要跳过 —— 界面上写「归属：SillyTavern System」比空着更让人困惑。
        const name2 = String(ctx?.name2 ?? '').trim();
        if (name2 && !PLACEHOLDER_CHARACTER_NAMES.has(name2)) return name2;
        return characterNameFromChat(ctx);
    } catch {
        return '';
    }
}

/**
 * 线索池在 `extensionSettings` 里的存放位置。
 *
 * 为什么不放 `chatMetadata`：那是**跟聊天走**的，换卡开新聊天时
 * 一旦书单碰巧一致就会串味（见 `characterKey` 的说明）。
 * `extensionSettings` 是全局设置对象，按卡标识做键就能做到「一卡一池」。
 */
const POOL_STORE_KEY = 'characterHookPools';

/**
 * 取某张卡的线索池。
 *
 * ⚠️ 兼容老数据：早期版本把池子存在 `chatMetadata` 里。这里会先看新位置，
 * 找不到再回落到当前聊天里的旧池子（并顺手迁移过去），
 * 这样用户升级后不用重新通读一遍。
 *
 * @param {any} ctx
 * @returns {any|null}
 */
export function getCharacterPool(ctx) {
    const key = characterKey(ctx);
    if (!key) return null;

    // ① 新位置
    try {
        const store = ctx?.extensionSettings?.[POOL_STORE_KEY];
        const pool = store && typeof store === 'object' ? store[key] : null;
        if (isUsablePool(pool)) return pool;
    } catch {
        /* 继续看老位置 */
    }

    // ② 老位置（迁移）
    try {
        const legacy = ctx?.chatMetadata?.[CHAT_KEY]?.hookPool;
        if (isUsablePool(legacy)) {
            const migrated = { ...legacy, character: key, migratedFrom: 'chatMetadata' };
            setCharacterPool(ctx, migrated.hooks, migrated.books, {
                ...legacy,
                migratedFrom: 'chatMetadata',
                at: migrated.at,
            });
            return getCharacterPoolRaw(ctx, key) ?? migrated;
        }
    } catch {
        /* ignore */
    }

    return null;
}

/** 直接读新位置（迁移时用，避免递归）。 */
function getCharacterPoolRaw(/** @type {any} */ ctx, /** @type {string} */ key) {
    try {
        const pool = ctx?.extensionSettings?.[POOL_STORE_KEY]?.[key];
        return isUsablePool(pool) ? pool : null;
    } catch {
        return null;
    }
}

/**
 * 存某张卡的线索池。
 *
 * @param {any} ctx
 * @param {any[]} hooks
 * @param {string[]} books
 * @param {{ editedAt?: number, at?: number, source?: string }} [extra]
 * @returns {{ ok: boolean, error?: string, pool?: any }}
 */
export function setCharacterPool(ctx, hooks, books, extra = {}) {
    const info = characterKeyInfo(ctx);
    const key = info.key;
    if (!key) {
        // 把探测过程一起报出去。原来只写「可能还没选卡」是**猜测**，
        // 猜错会把用户支到错的方向（去反复确认自己选没选卡）。
        return { ok: false, error: `拿不到角色卡标识 —— 试过：${info.diag}` };
    }

    try {
        const settings = ctx?.extensionSettings;
        if (!settings || typeof settings !== 'object') {
            return { ok: false, error: '当前酒馆没有 extensionSettings，无法保存线索池' };
        }
        if (!isRecord(settings[POOL_STORE_KEY])) {
            settings[POOL_STORE_KEY] = {};
        }
        const prev = Object.hasOwn(settings[POOL_STORE_KEY], key) ? settings[POOL_STORE_KEY][key] : null;
        const pool = {
            at: Number(extra.at) || Date.now(),
            books: Array.isArray(books) ? books.map(String) : [],
            hooks: Array.isArray(hooks) ? hooks : [],
            character: key,
            source: String(extra.source ?? prev?.source ?? ''),
            ...safeImportValue(extra),
            // 绑定由当前角色标识决定，调用者附带的旧 metadata 不可覆盖它。
            character: key,
        };
        settings[POOL_STORE_KEY][key] = pool;

        // 老位置清掉，避免两处不一致（读的时候会优先新位置，但留着容易误导）
        try {
            const meta = ctx?.chatMetadata;
            if (meta && typeof meta === 'object' && meta[CHAT_KEY]) meta[CHAT_KEY].hookPool = null;
        } catch {
            /* ignore */
        }
        return { ok: true, pool };
    } catch (e) {
        return { ok: false, error: describeError(e) };
    }
}

/** 清掉某张卡的线索池。 */
export function clearCharacterPool(ctx) {
    const key = characterKey(ctx);
    if (!key) return false;
    try {
        const store = ctx?.extensionSettings?.[POOL_STORE_KEY];
        if (store && typeof store === 'object') delete store[key];
        return true;
    } catch {
        return false;
    }
}

/** 列出所有已建立过池子的卡（诊断 / 界面用）。 */
export function listCharacterPools(ctx) {
    try {
        const store = ctx?.extensionSettings?.[POOL_STORE_KEY];
        if (!store || typeof store !== 'object') return [];
        return Object.entries(store)
            .filter(([, p]) => isUsablePool(p))
            .map(([key, p]) => ({
                key,
                count: p.hooks.length,
                books: p.books ?? [],
                at: p.at,
                current: key === characterKey(ctx),
            }));
    } catch {
        return [];
    }
}

/**
 * 当前**聊天**的稳定标识（用于判断「异步结果回来时还在不在同一个聊天里」）。
 *
 * ── 为什么需要它（真实竞态，审计发现）
 *
 * 通读世界书、请求辅助 API 都要几秒到几十秒。用户在这期间完全可以：
 *   · 切到另一张卡 / 另一个聊天
 *   · 收到别的消息
 *
 * 请求发出时抓的是「当时的聊天」，结果回来时 `ctx` 已经指向**另一个聊天**了。
 * 如果不核对，就会出现两类静默错误：
 *   · 引导被接到**新聊天**的正文末尾 —— 用户看到一句和当前剧情毫无关系的话
 *   · 通读结果被写进**新卡**的线索池 —— 世界观完全不同的书
 *
 * 所以异步流程开始前先抓一次，写入前再抓一次，对不上就放弃这次写入。
 *
 * 标识优先用 `chatId`（酒馆里就是聊天文件名，最稳定）；拿不到就退回
 * 第一条消息的时间戳 + 条数，再拿不到返回空串（**空串一律视为「无法判定」，
 * 调用方应当放行**，否则在不提供这些字段的宿主里会彻底不工作）。
 *
 * @param {any} ctx
 * @returns {string}
 */
export function chatKey(ctx) {
    try {
        const id = String(ctx?.chatId ?? '').trim();
        if (id) return `id:${id}`;

        // 退回用「第一条消息」认聊天。
        //
        // ⚠️ 刻意**不把消息条数算进去**：条数会在正常对话中不断变化，
        // 那样每轮生成都会被误判成「换了聊天」，插件直接不工作。
        // 认聊天只需要「这是不是同一段对话的开头」。
        const chat = ctx?.chat;
        if (!Array.isArray(chat) || !chat.length) return '';
        const first = chat[0];
        const head = String(first?.send_date ?? first?.create_date ?? first?.mes ?? '').slice(0, 64);
        return head ? `head:${head}` : '';
    } catch {
        return '';
    }
}

/**
 * 当前这张卡的线索池的**写入时间戳**（用来发现「扫描期间池子被改过」）。
 *
 * 场景：自动重读在跑 → 用户等不及，去「线索池」栏手工改了几条 → 重读结果回来，
 * 一把覆盖掉用户的修改。用户看到的是「我改的东西自己变回去了」。
 *
 * @param {any} ctx
 * @returns {number} 没有池子时返回 0
 */
export function poolStamp(ctx) {
    try {
        const pool = getCharacterPool(ctx);
        if (!pool) return 0;
        return Number(pool.editedAt) || Number(pool.at) || 0;
    } catch {
        return 0;
    }
}

/**
 * 抓一份「现在的世界」指纹，供异步流程前后比对。
 *
 * @param {any} ctx
 * @returns {{card: string, chat: string, stamp: number}}
 */
export function identitySnapshot(ctx) {
    return { card: characterKey(ctx), chat: chatKey(ctx), stamp: poolStamp(ctx) };
}

/**
 * 比对指纹，判断这次异步写入还算不算数。
 *
 * ⚠️ 两个字段的适用场景**不一样**，不能无脑全比：
 *
 * | 字段 | 管什么 | 谁需要它 |
 * |---|---|---|
 * | `card` | 换了角色卡 | 两边都要 |
 * | `chat` | 换了聊天 | 两边都要 |
 * | `stamp` | 池子被改过 | **只有「写库前」需要** |
 *
 * `stamp` 绝不能用在「正文末尾注入」那条路上 —— 那条路自己就会触发
 * `ensureHookPool()` 建池子，池子时间戳必然变化，一比对就把自己判成 drift，
 * 结果引导**永远发不出来**。所以由调用方通过 `opts` 明确要查哪些。
 *
 * @param {{card: string, chat: string, stamp: number}} before
 * @param {{card: string, chat: string, stamp: number}} after
 * @param {{stamp?: boolean}} [opts] 是否把「池子被改过」也算作失效，默认算
 * @returns {{ok: boolean, reason: string}} `ok: false` 时 `reason` 是给用户看的说明
 */
export function identityStillValid(before, after, opts = {}) {
    // 卡换了 —— 结果属于上一张卡，绝不能写进现在这张
    if (before?.card && after?.card && before.card !== after.card) {
        return { ok: false, reason: '期间换了角色卡' };
    }
    // 聊天换了 —— 同上
    if (before?.chat && after?.chat && before.chat !== after.chat) {
        return { ok: false, reason: '期间切换了聊天' };
    }
    // 池子在这期间被动过（手工编辑 / 手动重建 / 另一次通读抢先写完）
    //
    // 用 `!==` 而不是「变大」：只要和我们出发时看到的那一份不是同一份，
    // 我们手上这份就已经过期了，写进去就是覆盖别人的改动。
    if (opts.stamp !== false && Number(before?.stamp ?? 0) !== Number(after?.stamp ?? 0)) {
        return { ok: false, reason: '期间线索池被改动过' };
    }
    return { ok: true, reason: '' };
}

/**
 * 线索池是否还能用。
 *
 * 四个失效条件：
 *  1. 没有池子
 *  2. **卡对不上**（正常不会发生，但池子是按卡存的，这里再核一道）
 *  3. 过期（`worldbook.poolTtlMs`）
 *  4. **书单变了** —— 换了书或换了卡挂的书，旧线索可能来自完全不同的世界观
 *
 * @param {any} ctx
 * @param {any} settings
 * @param {string[]} currentBooks
 * @returns {boolean}
 */
export function isCharacterPoolFresh(ctx, settings, currentBooks) {
    const pool = getCharacterPool(ctx);
    if (!pool) return false;

    const key = characterKey(ctx);
    if (!key) return false;
    if (pool.character && pool.character !== key) return false;

    // 用户手工编辑过的池子，有效期从**编辑时间**算起 ——
    // 否则他刚改完就被自动重读冲掉了。
    const stamp = Number(pool.editedAt) || Number(pool.at);
    const ttl = Number(settings?.worldbook?.poolTtlMs) || 6 * 3600 * 1000;
    // 显式绑定保存的池子不因墙钟时间过期而被自动通读覆盖。
    if (!pool.savedAt && Date.now() - stamp > ttl) return false;

    const want = [...(Array.isArray(currentBooks) ? currentBooks : [])].map(String).sort();
    const have = [...(pool.books ?? [])].map(String).sort();
    if (want.length !== have.length) return false;
    for (let i = 0; i < want.length; i++) if (want[i] !== have[i]) return false;

    return true;
}

/**
 * 写回聊天私有数据。
 *
 * 优先 `saveMetadata()`（群聊里也安全），失败才回落 `saveChat()`。
 * 两个都失败就只留在内存里 —— 功能仍可用，只是刷新页面后去重记忆会丢。
 *
 * @param {any} ctx
 * @param {any} data
 * @param {{ silent?: boolean }} [opts]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function saveChatData(ctx, data, opts = {}) {
    try {
        const meta = ctx?.chatMetadata;
        if (meta && typeof meta === 'object') {
            data.updatedAt = Date.now();
            meta[CHAT_KEY] = data;
        }
    } catch (e) {
        return { ok: false, error: describeError(e) };
    }

    // ① saveMetadata：群聊安全
    try {
        if (typeof ctx?.saveMetadata === 'function') {
            await ctx.saveMetadata();
            return { ok: true };
        }
    } catch (e) {
        if (!opts.silent) console.warn(`[碧翠丝] saveMetadata 失败，回落 saveChat：${describeError(e)}`);
    }

    // ② saveChat：会静默吞错，所以自己 catch
    try {
        if (typeof ctx?.saveChat === 'function') {
            await ctx.saveChat();
            return { ok: true };
        }
    } catch (e) {
        if (!opts.silent) console.warn(`[碧翠丝] saveChat 失败：${describeError(e)}`);
        return { ok: false, error: describeError(e) };
    }

    return { ok: false, error: '当前酒馆没有 saveMetadata / saveChat' };
}

/**
 * 把一句话记进去重记忆。
 *
 * 去重的意义：世界书的钩子池是有限的，如果不去重，模型会在每一轮都把
 * 「旧城区的地下交易」翻出来讲一遍，几十轮下来非常出戏。
 *
 * @param {any} data getChatData 的返回值
 * @param {string[]} lines 新说的话
 */
export function rememberSpoken(data, lines) {
    if (!Array.isArray(data.spoken)) data.spoken = [];
    for (const line of lines) {
        const s = String(line ?? '').trim();
        if (!s) continue;
        data.spoken.push(s);
    }
    // 只留最近 MAX_SPOKEN 条，防止长聊天把 chatMetadata 撑爆
    if (data.spoken.length > MAX_SPOKEN) {
        data.spoken = data.spoken.slice(-MAX_SPOKEN);
    }
}

/** 清空去重记忆（换聊天、用户手动重置时用）。 */
export function resetChatData(data) {
    const fresh = blankChatData();
    Object.assign(data, fresh);
    return data;
}

/** 导出全部数据（设置 + 本聊天数据），给「导出配置」用。 */
export function exportAll(ctx) {
    return {
        ext: EXT_ID,
        exportedAt: new Date().toISOString(),
        settings: JSON.parse(JSON.stringify(getSettings(ctx))),
        chatData: JSON.parse(JSON.stringify(getChatData(ctx))),
    };
}

/**
 * 导入配置。只覆盖认识的白名单键，且过一遍补全与归一化，
 * 避免用户导入一个手改坏的 JSON 把扩展搞崩。
 * @param {any} ctx
 * @param {any} payload
 * @returns {{ok: boolean, error?: string}}
 */
export function importAll(ctx, payload) {
    try {
        if (!isRecord(payload)) return { ok: false, error: '不是合法的配置对象' };
        payload = safeImportValue(payload);
        for (const key of ['settings', 'chatData']) {
            if (payload[key] !== undefined && !isRecord(payload[key])) {
                return { ok: false, error: `${key} 必须是配置对象` };
            }
        }
        const container = ensureExtensionSettingsContainer(ctx);
        if (!container) return { ok: false, error: '当前酒馆没有 extensionSettings' };

        if (payload.settings && typeof payload.settings === 'object') {
            container[SETTINGS_KEY] = normalizeSettings(deepDefaults(payload.settings, defaultSettings()));
        }
        if (payload.chatData && typeof payload.chatData === 'object' && ctx?.chatMetadata) {
            const data = getChatData(ctx);
            Object.assign(data, blankChatData(), payload.chatData);
            ctx.chatMetadata[CHAT_KEY] = data;
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: describeError(e) };
    }
}
