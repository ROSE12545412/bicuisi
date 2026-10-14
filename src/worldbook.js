/**
 * 碧翠丝的禁书库 / src/worldbook.js
 * ---------------------------------------------------------------------------
 * 世界书读取与线索筛选。
 *
 * ── 这一层的设计改过一次，原因值得写下来
 *
 * 原设计：只读**标了标签**的条目（`[引导] xxx`），并让用户/卡作者去标标签。
 * 用户的反馈一句话点破了前提：
 *
 *   「这句话不对，没有写卡作者会为了我们的插件来特地制定剧情条目。
 *     如果 ai 帮选你应该把提示词做好，让 ai 仔细阅读世界书里的内容
 *     确定哪些是剧情条目。」
 *
 * 完全成立。指望卡作者为某个第三方插件改自己的世界书是不现实的 ——
 * 这个前提从一开始就是错的，而且它把「插件能不能用」的责任推给了别人。
 *
 * 现在：**默认读全部条目，由 AI 读懂内容来判断哪些是剧情条目**。
 *   - `tags` 降级成可选的手动硬过滤（作者确实标了标签时更省 token）
 *   - `excludeTags` 保留为硬排除 —— 那不是「筛选」，是作者/用户主动声明的
 *     「这块别碰」（剧透保护），AI 再聪明也不该覆盖
 *
 * ── 为什么要有「线索池」
 *
 * 让 AI 通读世界书是有成本的（一本几十万字的书），不能每 2 轮做一次。
 * 而「哪些条目是剧情条目」这件事变化很慢（只有作者改书才会变）。
 * 所以筛一次、缓存进该聊天的 `chatMetadata`，过期或世界书变动时再筛。
 * 之后每轮的引导只需要读这一小把线索。
 *
 * 实测过的坑（不要重蹈）：
 *  1. `ctx.loadWorldInfo(name)` 返回的是 **Promise**，必须 await。
 *     本机有个流行扩展把 Promise 当同步对象用，导致永远拿到 undefined。
 *  2. 条目字段有两套命名，必须双兼容：
 *       原始 v2 格式： `keys`(复数) / `enabled` / `insertion_order` / position 是字符串
 *       扁平化格式：   `key`(单数) / `disable` / `order` / position 是数字
 *  3. 「当前绑定了哪几本世界书」有三个互相独立的地方，全都要读：
 *       全局  → ctx.powerUserSettings.world_info.globalSelect  (string[])
 *       角色卡 → ctx.characters[chid].data.extensions.world      (string)
 *       本聊天 → ctx.chatMetadata.world_info                      (string)
 *  4. **不要**去 fetch `data/<user>/worlds/*.json` —— TauriTavern 是纯 Rust 客户端，
 *     没有 Node 后端，那些 HTTP 端点不一定存在。`loadWorldInfo` 是唯一可靠路径。
 *  5. 标签的**括号是区域的边界**。写 `[引导] 名字` 时，名字取到下一个括号为止，
 *     所以说明性文字里不能再出现括号，否则名字会被切坏。
 */

import { describeError } from './llm/client.js';
import { isRuleBook } from './realm-worldbook.js';

/** 估算 token 数：中文约 1.6 字符/token（沿用本机生态的既定系数）。 */
const CHARS_PER_TOKEN = 1.6;

/** 注释里的标签分隔符：`引导 - 旧城区`、`引导：旧城区`、`引导|旧城区` 都算。 */
const TAG_SEPARATORS = /[\s\-—–—_:：·|/\\>＞]+/;

/**
 * 估算一段文本的 token 数。
 * 有 `ctx.getTokenCountAsync` 时优先用它（更准），没有就按字符数估算。
 * @param {string} text
 * @param {any} [ctx]
 * @returns {Promise<number>}
 */
export async function estimateTokens(text, ctx) {
    const s = String(text ?? '');
    try {
        if (typeof ctx?.getTokenCountAsync === 'function') {
            const n = await ctx.getTokenCountAsync(s);
            if (Number.isFinite(Number(n))) return Number(n);
        }
    } catch {
        /* 回落估算 */
    }
    return Math.ceil(s.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// 标签解析（只用于可选的硬过滤与保护性排除）
// ---------------------------------------------------------------------------

/**
 * 从条目标题里解析标签与标签值。
 *
 * 返回 `{ tags, label, excluded }`：
 *  - `tags`     所有识别出的标签名（去掉值），如 `['引导','地点']`
 *  - `label`    第一个带值的标签的值（这是给模型看的「线索名」），如 `'旧城区'`
 *  - `excluded` 是否命中排除标签
 *
 * @param {string} comment
 * @param {{tags: string[], excludeTags: string[]}} rules
 * @returns {{tags: string[], label: string, excluded: boolean, raw: string}}
 */
export function parseEntryTags(comment, rules) {
    const raw = String(comment ?? '').trim();
    /** @type {{tags: string[], label: string, excluded: boolean, raw: string}} */
    const out = { tags: [], label: '', excluded: false, raw };
    if (!raw) return out;

    const include = Array.isArray(rules?.tags) ? rules.tags : [];
    const exclude = Array.isArray(rules?.excludeTags) ? rules.excludeTags : [];

    // 第一步：把所有 [xxx] / 【xxx】 / （xxx） 括号段抠出来，连同它在原文里的位置。
    //
    // 为什么要记位置：`[引导] 旧城区的传言` 和 `[引导：旧城区的传言]` 是两种**不同**的写法，
    // 标签值一个在括号外、一个在括号内。只收集括号内容的话，前者的标签名就丢了
    //（这正是早期版本的 bug：所有「标签在括号里、名字在外面」的条目全都拿不到 label）。
    /** @type {Array<{content: string, start: number, end: number}>} */
    const brackets = [];
    const bracketRe = /[[【（(]\s*([^\]】）)]{1,40})\s*[\]】）)]/g;
    let m;
    while ((m = bracketRe.exec(raw)) !== null) {
        brackets.push({ content: m[1].trim(), start: m.index, end: m.index + m[0].length });
    }

    /**
     * 处理一段可能带值的标签碎片（`引导·旧城区` 这种形式）。
     * @returns {boolean} 这一段是否被标签**独占**（独占时标签值要到括号外去找）
     */
    const absorb = (fragment) => {
        const pieces = fragment.split(TAG_SEPARATORS).filter(Boolean);
        let onlyTags = pieces.length > 0;
        for (let i = 0; i < pieces.length; i++) {
            const piece = pieces[i];
            if (exclude.includes(piece)) {
                out.excluded = true;
                out.tags.push(piece);
                continue;
            }
            if (include.includes(piece)) {
                out.tags.push(piece);
                const value = pieces[i + 1];
                if (value) {
                    if (!out.label) out.label = value;
                    i++; // 值已被消费
                    onlyTags = false;
                }
            } else {
                onlyTags = false;
            }
        }
        return onlyTags;
    };

    /** 每个「独占括号」的结束位置，用来取它后面的文字当标签名。 */
    const standaloneEnds = [];

    for (const b of brackets) {
        const wasStandalone = absorb(b.content);
        if (wasStandalone && (out.tags.length || out.excluded)) standaloneEnds.push(b.end);
    }

    // 第二步：括号里只写了标签、名字写在括号外时，把括号后面的文字当标签名。
    if (!out.label && standaloneEnds.length) {
        const lastEnd = Math.max(...standaloneEnds);
        const trailing = raw.slice(lastEnd);
        const cleaned = trailing.replace(/^[\s\-—–_:：·|/\\>＞]+/, '').replace(/[[【（(][^\]】）)]*[\]】）)]/g, '').trim();
        const label = normalizeLabel(cleaned, include, exclude);
        if (label) out.label = label;
    }

    // 第三步：完全没有括号的写法，如 `引导 - 旧城区`（整行前缀式）
    if (!out.tags.length && !out.excluded) {
        const head = raw.split(TAG_SEPARATORS).filter(Boolean);
        if (head.length && (include.includes(head[0]) || exclude.includes(head[0]))) {
            absorb(raw.split(/[\s\-—–_:：·|/\\]+/).slice(0, 4).join(' '));
        }
    }

    out.tags = [...new Set(out.tags)];
    return out;
}

/**
 * 判断一段文字是不是「纯粹由标签组成、不含任何名字」。
 * 用于避免把 `[引导][剧透]` 这种后面没内容的情况误当成有标签名。
 */
function cleanNeutral(text, include, exclude) {
    const pieces = String(text ?? '')
        .split(TAG_SEPARATORS)
        .filter(Boolean);
    if (!pieces.length) return true;
    return pieces.every((p) => include.includes(p) || exclude.includes(p));
}

/**
 * 把「标签后面的那一段文字」清洗成一个干净的线索名。
 *
 * 需要这一步是因为标题里常有**给作者自己看的说明性后缀**：
 *
 *     [地点] 王都下水道 · 东段暗渠 ← 中文方头括号也可以
 *
 * 原样当名字的话，这串东西会进提示词、进水泡、进调试面板。
 * 这里只剥离**明确的说明分隔符**：`←` `→` `⇒` `#` `|` 以及成对的书名号/引号。
 * 刻意**不剥 `-` 和 `—`**：它们是合法的名字成分，而且 `引导 - 旧城区` 里
 * `-` 是标签分隔符，剥了会把名字吃空。
 */
function normalizeLabel(text, include, exclude) {
    let s = String(text ?? '').trim();
    if (!s) return '';

    const cut = s.search(/[←→⇒#|｜]/);
    if (cut > 0) s = s.slice(0, cut).trim();

    s = s.replace(/^[《「『“"']+/, '').replace(/[》」』”"']+$/, '').trim();
    s = s.replace(/[·、,，。.；;：:\-—–\s]+$/, '').trim();

    if (!s) return '';
    if (cleanNeutral(s, include, exclude)) return '';
    return s;
}

/** 判断一条条目是否被硬排除（命中排除标签）。 */
export function isExcluded(entry, settings) {
    const rules = settings?.worldbook ?? {};
    const parsed = parseEntryTags(String(entry?.comment ?? ''), {
        tags: rules.tags ?? [],
        excludeTags: rules.excludeTags ?? [],
    });
    return parsed.excluded;
}

/**
 * 判断一条条目是否通过**可选的手动标签过滤**。
 *
 * 白名单为空时一律通过（默认：交给 AI 判断）。
 * @returns {boolean}
 */
export function passesManualFilter(entry, settings) {
    const rules = settings?.worldbook ?? {};
    const include = Array.isArray(rules.tags) ? rules.tags : [];
    if (!include.length) return true; // 没配白名单 = 不按标签过滤
    const parsed = parseEntryTags(String(entry?.comment ?? ''), {
        tags: include,
        excludeTags: rules.excludeTags ?? [],
    });
    return parsed.tags.length > 0;
}

// ---------------------------------------------------------------------------
// 世界书发现
// ---------------------------------------------------------------------------

/**
 * 列出当前聊天关联的所有世界书名。
 *
 * 顺序即优先级：角色卡 > 本聊天 > 全局勾选。
 * 用户显式配了 `worldbook.bookNames` 时**只**用配置的。
 *
 * @param {any} ctx
 * @param {any} settings
 * @returns {string[]}
 */
export function discoverBookNames(ctx, settings) {
    const configured = settings?.worldbook?.bookNames;
    if (Array.isArray(configured) && configured.length) {
        return [...new Set(configured.map(String).filter(Boolean))];
    }

    const names = [];
    const push = (n) => {
        const s = String(n ?? '').trim();
        if (s && !names.includes(s)) names.push(s);
    };

    try {
        const chid = Number(ctx?.characterId);
        const chars = ctx?.characters;
        if (Array.isArray(chars) && Number.isFinite(chid) && chid >= 0 && chars[chid]) {
            push(chars[chid]?.data?.extensions?.world);
        }
    } catch {
        /* ignore */
    }

    try {
        push(ctx?.chatMetadata?.world_info);
    } catch {
        /* ignore */
    }

    try {
        const globalSelect = ctx?.powerUserSettings?.world_info?.globalSelect;
        if (Array.isArray(globalSelect)) globalSelect.forEach(push);
    } catch {
        /* ignore */
    }

    return names;
}

/**
 * 列出酒馆里**所有**世界书名（不只是当前关联的）。
 *
 * 用途：设置里让用户手动挑选要用哪几本。
 * 自动发现依赖角色卡/聊天/全局勾选三处，任何一处为空就一本都找不到，
 * 而用户可能只是没把书挂到卡上。
 *
 * @param {any} ctx
 * @returns {Promise<string[]>}
 */
export async function listAllBooks(ctx) {
    /** @type {Set<string>} */
    const names = new Set();

    // ① 官方能力探测（可能同步也可能异步，两种都处理）
    try {
        if (typeof ctx?.getWorldInfoNames === 'function') {
            const got = await ctx.getWorldInfoNames();
            if (Array.isArray(got)) for (const n of got) if (n) names.add(String(n));
        }
    } catch (e) {
        console.warn(`[碧翠丝] getWorldInfoNames 失败，回落到全局勾选：${describeError(e)}`);
    }

    // ② 全局勾选
    try {
        const globalSelect = ctx?.powerUserSettings?.world_info?.globalSelect;
        if (Array.isArray(globalSelect)) for (const n of globalSelect) if (n) names.add(String(n));
    } catch {
        /* ignore */
    }

    // ③ 当前关联的三处
    for (const n of discoverBookNames(ctx, { worldbook: { bookNames: [] } })) names.add(n);

    return [...names].sort((a, b) => a.localeCompare(b, 'zh'));
}

/**
 * 读取一本书的全部条目并规范化为统一形状。
 *
 * @param {any} ctx
 * @param {string} name
 * @returns {Promise<any[]>} 读失败返回空数组（不抛）
 */
export async function readBook(ctx, name, opts = {}) {
    if (typeof ctx?.loadWorldInfo !== 'function') {
        throw new Error('当前酒馆不支持 loadWorldInfo，无法读取世界书');
    }
    const book = await ctx.loadWorldInfo(name);
    if (!book || typeof book !== 'object') {
        if (opts.strict) throw new Error('无法读取所选世界书：' + name);
        return [];
    }

    const entries = book.entries;
    if (!entries || typeof entries !== 'object') {
        if (opts.strict) throw new Error('所选世界书缺少 entries：' + name);
        return [];
    }

    /** @type {any[]} */
    const out = [];
    for (const [uid, e] of Object.entries(entries)) {
        if (!e || typeof e !== 'object') continue;
        out.push(normalizeEntry(name, uid, /** @type {any} */ (e)));
    }
    return out;
}

/** 把两套字段命名统一成一种。 */
function normalizeEntry(book, uid, e) {
    const keys = e.key ?? e.keys ?? [];
    const disabled = e.disable ?? e.enabled === false;
    const order = Number(e.order ?? e.insertion_order ?? 0) || 0;
    return {
        book,
        uid: Number(uid),
        sourceUid: String(uid), // Preserve nonnumeric source keys for revision identity.
        comment: String(e.comment ?? ''),
        content: String(e.content ?? ''),
        keys: Array.isArray(keys) ? keys.map(String) : [String(keys)].filter(Boolean),
        constant: Boolean(e.constant),
        disabled: Boolean(disabled),
        order,
        position: e.position,
    };
}

// A baseline must cover entire selected books, not only indexed/selected hooks.
// JSON tuples avoid delimiter collisions; SHA-256 avoids weak rolling-hash collisions.
function revisionBookNames(books) {
    return [...new Set((Array.isArray(books) ? books : []).map(String)
        .filter(name => name && !isRuleBook(name)))].sort();
}

function checkRevisionAbort(signal) {
    if (signal?.aborted) throw new Error('世界书来源校验已中止');
}

async function revisionFromEntries(books, byBook, signal) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
        throw new Error('当前环境没有 WebCrypto SHA-256，无法校验世界书来源');
    }
    const records = [];
    for (const name of revisionBookNames(books)) {
        checkRevisionAbort(signal);
        const entries = byBook.get(name);
        if (!Array.isArray(entries)) throw new Error('缺少完整世界书来源：' + name);
        const rows = entries.map(e => [String(e.sourceUid ?? e.uid), String(e.content ?? ''),
            String(e.comment ?? ''), Boolean(e.disabled), e.keys ?? [], Boolean(e.constant),
            Number(e.order) || 0, e.position ?? null]);
        rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        // JSON escapes lone surrogates before UTF-8 encoding; distinct strings stay distinct.
        const bytes = new TextEncoder().encode(JSON.stringify([name, rows]));
        const hash = await subtle.digest('SHA-256', bytes);
        checkRevisionAbort(signal);
        const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
        records.push({ name, digest, entries: rows.length });
    }
    return { version: 1, algorithm: 'SHA-256', books: records };
}

/** Capture full live sources. Never use this to rebaseline an already-stale index. */
export async function capturePoolSourceRevision(ctx, books, { signal } = {}) {
    try {
        checkRevisionAbort(signal);
        const names = revisionBookNames(books);
        const byBook = new Map();
        for (const name of names) {
            checkRevisionAbort(signal);
            byBook.set(name, await readBook(ctx, name, { strict: true }));
            checkRevisionAbort(signal);
        }
        return { ok: true, revision: await revisionFromEntries(names, byBook, signal) };
    } catch (e) {
        return { ok: false, error: describeError(e) };
    }
}

/** Async source freshness; deliberately does not change synchronous TTL/book checks. */
export async function validatePoolSourceRevision(ctx, pool, { signal } = {}) {
    const baseline = pool?.sourceRevision;
    // Older/custom saved pools have no evidence of their original sources. Do not
    // silently invent a baseline or wipe them: the UI can explicitly log migration.
    if (baseline === undefined || baseline === null) {
        return { ok: true, changed: false, error: '', unverified: true };
    }
    const invalid = { ok: false, changed: false, error: '世界书来源指纹格式无效，需要重新建立索引' };
    if (baseline.version !== 1 || baseline.algorithm !== 'SHA-256' || !Array.isArray(baseline.books)) return invalid;
    const names = revisionBookNames(pool?.books);
    const records = baseline.books;
    if (records.length !== names.length || records.some((r, i) => !r || r.name !== names[i]
        || !/^[a-f0-9]{64}$/.test(r.digest) || !Number.isSafeInteger(r.entries) || r.entries < 0)) return invalid;
    const captured = await capturePoolSourceRevision(ctx, names, { signal });
    if (!captured.ok) return { ok: false, changed: false, error: captured.error };
    const changed = records.some((r, i) => r.digest !== captured.revision.books[i].digest
        || r.entries !== captured.revision.books[i].entries);
    return { ok: !changed, changed, error: changed ? '世界书来源内容已变化，需要重新建立索引' : '' };
}

/** 截断长文本，保留头尾（中间省略）——头部信息密度通常最高。 */
export function truncate(text, max) {
    const s = String(text ?? '');
    const limit = Number(max);
    if (!Number.isFinite(limit) || limit <= 0 || s.length <= limit) return s;
    if (limit < 40) return s.slice(0, limit);
    const head = Math.ceil(limit * 0.7);
    const tail = limit - head - 3;
    return `${s.slice(0, head)} … ${s.slice(-Math.max(0, tail))}`;
}

// ---------------------------------------------------------------------------
// 候选条目收集（给 AI 筛选用）
// ---------------------------------------------------------------------------

/**
 * 收集所有**可送进 AI 筛选**的候选条目。
 *
 * 与旧版 `collectHooks` 的关键区别：**不再要求条目带标签**。
 * 只做两件必要的排除：
 *   1. 禁用条目（disable）
 *   2. 内容为空的条目
 *   3. 命中**排除标签**的条目（剧透保护 —— 这是用户的主动声明，不是筛选）
 * 另外，如果用户**主动填了** `tags` 白名单，才按标签过滤（省 token 的可选优化）。
 *
 * @param {any} ctx
 * @param {any} settings
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{candidates: any[], books: string[], scanned: number, skipped: number, errors: string[], manualFilter: boolean, truncated: boolean}>}
 */
export async function collectCandidates(ctx, settings, opts = {}) {
    const books = discoverBookNames(ctx, settings).filter(name => !isRuleBook(name));
    // 专用对抗规则不是剧情来源；两种模式都不把它混入检索索引。
    // AI 通读是全文来源收集；旧标签/常量/禁用开关不再限制来源。
    const manualFilter = false;

    /** @type {any[]} */
    const candidates = [];
    /** @type {string[]} */
    const errors = [];
    let scanned = 0;
    let skipped = 0;
    const fullSources = new Map();

    for (const name of books) {
        if (opts.signal?.aborted) throw new Error('世界书通读已中止');
        try {
            const entries = await readBook(ctx, name, { strict: true });
            checkRevisionAbort(opts.signal);
            fullSources.set(name, entries);
            for (const entry of entries) {
                scanned++;
                if (!entry.content.trim()) {
                    skipped++;
                    continue;
                }
                candidates.push(entry);
            }
        } catch (e) {
            errors.push(`${name}: ${describeError(e)}`);
        }
    }

    // 按插入顺序排（作者写书的顺序通常也是信息的重要度顺序）
    candidates.sort((a, b) => a.order - b.order || a.uid - b.uid);

    checkRevisionAbort(opts.signal);
    let sourceRevision;
    if (!errors.length) {
        try {
            sourceRevision = await revisionFromEntries(books, fullSources, opts.signal);
        } catch (e) {
            checkRevisionAbort(opts.signal);
            errors.push(describeError(e));
        }
    }
    return { candidates, books, scanned, skipped, errors, manualFilter, truncated: false, sourceRevision };
}

/**
 * 把候选条目压成给 AI 筛选用的清单。
 *
 * 格式：`编号. 标题\n   摘要`。让模型只回**编号** ——
 * 比让它复述标题可靠得多（标题可能重复、很长、或被它顺手改写）。
 *
 * @param {any[]} entries
 * @param {{ maxCharsPerEntry?: number, maxCharsTotal?: number, maxEntries?: number }} [opts]
 * @returns {{text: string, used: any[], omitted: number, chars: number}}
 */
export function formatCandidatesForScan(entries, opts = {}) {
    const perEntry = Number(opts.maxCharsPerEntry) || 220;
    const maxTotal = Number(opts.maxCharsTotal) || 120000;
    const maxEntries = Number(opts.maxEntries) || 600;

    /** @type {any[]} */
    const used = [];
    const lines = [];
    let chars = 0;

    const list = Array.isArray(entries) ? entries : [];
    for (const e of list) {
        if (used.length >= maxEntries) break;
        const title = String(e.comment ?? '').trim() || `（无标题 #${e.uid}）`;
        const body = truncate(String(e.content ?? '').replace(/\s+/g, ' '), perEntry);
        const line = `${used.length + 1}. ${title}\n   ${body}`;
        if (chars + line.length > maxTotal && used.length > 0) break;
        lines.push(line);
        chars += line.length;
        used.push(e);
    }

    return { text: lines.join('\n'), used, omitted: Math.max(0, list.length - used.length), chars };
}

/** Exhaustive bounded full-text batches. Limits control request size, never total coverage. */
export function buildFullContentBatches(entries, opts = {}) {
    const maxChars = Math.max(512, Math.min(24000, Math.floor(Number(opts.maxCharsTotal) || 24000)));
    const maxEntries = Math.max(1, Math.min(24, Math.floor(Number(opts.maxEntries) || 24)));
    const batches = [];
    let batch = { text: '', used: [], segments: [], chars: 0 };
    const flush = () => {
        if (batch.used.length) batches.push(batch);
        batch = { text: '', used: [], segments: [], chars: 0 };
    };
    for (const [entryIndex, entry] of (Array.isArray(entries) ? entries : []).entries()) {
        const content = String(entry.content ?? '');
        let start = 0;
        while (start < content.length) {
            if (batch.used.length >= maxEntries) flush();
            const title = truncate(String(entry.comment ?? ''), 120);
            const header = `${batch.used.length + 1}. ${title} [来源 ${entryIndex + 1}; 字符 ${start} 起; 全长 ${content.length}]\n`;
            const room = maxChars - batch.chars - header.length - 2;
            if (room < 1) { flush(); continue; }
            let end = Math.min(content.length, start + room);
            // Never split a surrogate pair (preserve exact source on concatenation).
            if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
            if (end <= start) { flush(); continue; }
            const line = `${header}${content.slice(start, end)}\n\n`;
            batch.text += line;
            batch.chars += line.length;
            batch.used.push(entry);
            batch.segments.push({ entryIndex, book: entry.book, uid: entry.uid, start, end, total: content.length });
            start = end;
            if (start < content.length) flush();
        }
    }
    flush();
    return batches;
}

// ---------------------------------------------------------------------------
// 两段式：索引清单（给「定位」那一步看，不含正文）
// ---------------------------------------------------------------------------

/**
 * 把索引排成检索清单 —— **每条一行，不含正文**。
 *
 * 这是两段式省 token 的关键：通读一次把几十万字压成几百行，
 * 之后每一轮引导只需要过一遍这几百行，而不是重发全书。
 *
 * 行格式：`12. 【地点】王都下水道（王都篇）水道错综复杂，但有人说下面藏着东西`
 *        ↑编号 ↑分类   ↑标题      ↑阶段      ↑摘要
 *
 * 阶段放在标题**后面**而不是前面，是因为模型扫清单时先认标题
 * （它记剧情靠的是人名地名），阶段是辅助判断。
 *
 * 没被 AI 索引到的条目**照样列出来**（摘要位置写「（没写摘要）」）——
 * 宁可给一行没信息的，也不要让它从清单里消失。消失 = 检索不到 = 退回「筛选」。
 *
 * @param {any[]} hooks 索引条目（每条形如 {label, kind, brief, phase, content}）
 * @param {{maxChars?: number, briefChars?: number}} [opts]
 * @returns {{text: string, used: any[], omitted: number, chars: number}}
 */
export function formatIndexForLocate(hooks, opts = {}) {
    const maxTotal = Number(opts.maxChars) || 60000;
    const briefChars = Number(opts.briefChars) || 60;

    const list = Array.isArray(hooks) ? hooks : [];
    /** @type {any[]} */
    const used = [];
    const lines = [];
    let chars = 0;

    for (const h of list) {
        const label = String(h?.label ?? '').trim() || `（无标题）`;
        const kind = String(h?.kind ?? '').trim();
        const phase = String(h?.phase ?? '').trim();
        let brief = String(h?.brief ?? '').trim();
        if (!brief) {
            // 没被 AI 描述到 —— 用正文开头兜底，别让它变成一行空壳
            brief = truncate(String(h?.content ?? '').replace(/\s+/g, ' ').trim(), briefChars) || '（没写摘要）';
        } else {
            brief = truncate(brief, briefChars);
        }

        const head = `${used.length + 1}. ${kind ? `【${kind}】` : ''}${label}${phase ? `（${phase}）` : ''}`;
        const line = `${head} ${brief}`;
        if (chars + line.length > maxTotal && used.length > 0) break;
        lines.push(line);
        chars += line.length;
        used.push(h);
    }

    return { text: lines.join('\n'), used, omitted: Math.max(0, list.length - used.length), chars };
}

// ---------------------------------------------------------------------------
// 两段式：按需取回正文
// ---------------------------------------------------------------------------

/**
 * 给线索补上**实时正文**。
 *
 * 索引模式下池子里**不存正文**（几百条正文塞进设置文件太沉，而且会过期）。
 * 池子只记「哪本书的第几号条目」，真正要用的时候到这里现取。
 *
 * 这样还有一个额外好处：作者改了世界书，下一轮就自动用上新版，
 * 不需要用户手动清池子重读。
 *
 * 取不到就退回池子里存的那份（手工添加的线索本来就没有对应的书）。
 *
 * @param {any} ctx
 * @param {any[]} hooks
 * @param {{maxChars?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<any[]>} 新的数组，不改原对象
 */
export async function resolveHookContents(ctx, hooks, opts = {}) {
    const list = Array.isArray(hooks) ? hooks : [];
    const maxChars = Number(opts.maxChars) || 300;

    /** @type {Map<string, Set<number>>} */
    const byBook = new Map();
    for (const h of list) {
        if (!h?.book) continue;
        if (!byBook.has(h.book)) byBook.set(h.book, new Set());
        byBook.get(h.book).add(Number(h.uid));
    }

    /** @type {Map<string, string>} */
    const live = new Map();
    for (const [book, uids] of byBook) {
        if (opts.signal?.aborted) break;
        try {
            const entries = await readBook(ctx, book);
            for (const e of entries) {
                if (!uids.has(Number(e.uid))) continue;
                live.set(`${book}#${e.uid}`, String(e.content ?? ''));
            }
        } catch {
            // 这本书读不到了（被删/改名）—— 不致命，下面用存量兜底
        }
    }

    return list.map((h) => {
        const fresh = live.get(`${h.book}#${h.uid}`);
        const text = fresh !== undefined && fresh !== '' ? fresh : String(h.content ?? '');
        return { ...h, content: truncate(text, maxChars) };
    });
}

// ---------------------------------------------------------------------------
// 手动标签写入（可选的整理功能，不是主路径）
// ---------------------------------------------------------------------------

/** 已带引导标签的标题。 */
const ALREADY_TAGGED = /^\s*[[【（(]\s*(引导|钩子|剧情|地点|事件|线索)/;

/**
 * 把选中的条目标题加上标签。
 *
 * ⚠️ 这**不是主路径**。主路径是 AI 每次筛选，不动用户的世界书。
 * 这个功能留给「作者确实愿意标标签、标了之后能省 token」的情况。
 * 只改标题（comment），不动正文，且已带标签的会跳过。
 *
 * @param {any} ctx
 * @param {any[]} entries 与给 AI 的清单**同序**
 * @param {Array<{index: number}>} picks
 * @returns {Promise<{ok: boolean, applied: Array<{book: string, uid: number, from: string, to: string}>, errors: string[], error?: string}>}
 */
export async function applyTagPicks(ctx, entries, picks) {
    /** @type {Array<{book: string, uid: number, from: string, to: string}>} */
    const applied = [];
    /** @type {string[]} */
    const errors = [];

    if (!Array.isArray(picks) || !picks.length) {
        return { ok: false, applied, errors, error: '没有挑出任何条目' };
    }
    if (typeof ctx?.saveWorldInfo !== 'function') {
        return {
            ok: false,
            applied,
            errors,
            error: '当前酒馆没有 saveWorldInfo，无法写回世界书',
        };
    }

    /** @type {Map<string, Set<number>>} */
    const byBook = new Map();
    for (const pick of picks) {
        const idx = Number(pick?.index) - 1;
        const entry = entries[idx];
        if (!entry) continue;
        if (!byBook.has(entry.book)) byBook.set(entry.book, new Set());
        byBook.get(entry.book).add(entry.uid);
    }

    for (const [bookName, uids] of byBook) {
        try {
            const book = await ctx.loadWorldInfo(bookName);
            if (!book?.entries) {
                errors.push(`${bookName}: 读不到这本书`);
                continue;
            }
            const changed = [];
            for (const uid of uids) {
                const e = book.entries[uid] ?? book.entries[String(uid)];
                if (!e) continue;
                const from = String(e.comment ?? '');
                if (ALREADY_TAGGED.test(from)) continue;
                const to = `[引导] ${from}`.trim();
                e.comment = to;
                changed.push({ book: bookName, uid: Number(uid), from, to });
            }
            if (!changed.length) continue;
            await ctx.saveWorldInfo(bookName, book);
            applied.push(...changed);
        } catch (e) {
            errors.push(`${bookName}: ${describeError(e)}`);
        }
    }

    return {
        ok: applied.length > 0,
        applied,
        errors,
        error: applied.length ? undefined : errors[0] ?? '没有任何条目被改动',
    };
}

/**
 * 把线索列表压成一段给引导模型看的文本。
 *
 * @param {any[]} hooks
 * @returns {string}
 */
export function formatHooksForPrompt(hooks) {
    if (!Array.isArray(hooks) || !hooks.length) {
        return '（这次没有可用的线索）';
    }
    return hooks
        .map((h) => {
            const tag = h.kind ? `[${h.kind}]` : '';
            return `- ${tag}${h.label}：${String(h.content ?? '').trim()}`;
        })
        .join('\n');
}

/** 兼容旧调用名（旧版叫 collectHooks）。 */
export const collectHooks = collectCandidates;
