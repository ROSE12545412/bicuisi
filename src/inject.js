/**
 * 碧翠丝的禁书库 / src/inject.js
 * ---------------------------------------------------------------------------
 * 把引导落成聊天里的一条消息。
 *
 * 为什么用「隐藏的系统消息」而不是改正文：
 *  - **不改正文**是不可妥协的原则。正文是用户和正文模型的产物，
 *    插件往里插字会在每次 swipe / 重新生成时对不上，编辑记录也会乱。
 *  - `is_system: true` 的消息**不会发给 LLM**，所以贝翠丝的话不会污染角色扮演，
 *    也不会被下一轮模型当成剧情事实。
 *  - 但它在聊天记录里是**可见的**，而且用户重新生成/swipe 时它作为独立楼层不受影响。
 *
 * 关于「模型能否看到引导」：正文模型看不到这条消息（它是隐藏的）。
 * 引导影响剧情的方式是**通过用户** —— 用户读到贝翠丝的话，自己决定往哪走。
 * 这是刻意的设计：插件不越权替用户操纵正文。
 */

import { CSS_PREFIX } from './config.js';
import { describeError } from './llm/client.js';
import { isVoid, modeImageUrl } from './mode.js';

/**
 * 判断一条消息是不是本插件注入的。
 *
 * 需要这个判断是因为：注入本身会触发 `MESSAGE_RECEIVED`，
 * 如果不排除，就会形成「注入 → 触发引导 → 又注入」的无限回环。
 *
 * @param {any} ctx
 * @param {number} messageId
 * @returns {boolean}
 */
export function isOwnInjectedMessage(ctx, messageId) {
    try {
        const chat = ctx?.chat;
        if (!Array.isArray(chat)) return false;
        const id = Number(messageId);
        if (!Number.isFinite(id) || id < 0 || id >= chat.length) return false;
        return Boolean(chat[id]?.extra?.beatriceGuide?.injected);
    } catch {
        return false;
    }
}

/**
 * 构造注入消息的正文。
 *
 * 格式刻意做成「引用体」而不是叙述体：一眼就能看出这是插件的旁注，
 * 不会和角色扮演正文混淆。
 *
 * ── 超长时的取舍顺序（这里踩过坑）──────────────────────────────────────
 * 分支明确、逐级降级，绝不留空壳：
 *
 *   有引导  → ① 引导 + 完整吐槽（装得下就用完整的，不做「截一半」的中间态）
 *             ② 只要引导
 *             ③ 引导硬截到预算内
 *   无引导  → ④ 只留吐槽，用「—— 名字：」落款格式
 *             ⑤ 吐槽硬截到预算内
 *   都为空  → ⑥ 只留标题（调用方 injectGuidance 会用 isHollowInjection 拒掉）
 *
 * ⚠️ 「无引导」这一支曾经是缺失的。当时的逻辑是「超长就优先保留引导、砍掉吐槽」，
 * 于是当模型**只给了吐槽、没给引导**时，会拼出 `【贝翠丝的低语】\n「」`
 * 这种带空引号的无意义楼层 —— 既浪费一次注入，又会让用户以为插件坏了。
 *
 * 为什么不做「截断吐槽」这一档：吐槽是配角，截一半读起来像被腰斩的残句，
 * 不如干脆不要 —— 引导才是这次注入的目的。只有引导为空、吐槽成了唯一内容时，
 * 才值得把它硬截下来（总比什么都不说强）。
 *
 * @param {{guidance?: string, commentary?: string}} result
 * @param {any} settings
 * @returns {string} 两个字段都为空时只返回标题
 */
export function buildInjectionText(result, settings) {
    const name = isVoid(settings) ? '人神' : (String(settings?.injection?.speakerName ?? '贝翠丝').trim() || '贝翠丝');
    const maxChars = Number(settings?.injection?.maxChars) || 600;

    const guidance = String(result?.guidance ?? '').trim();
    const commentary = String(result?.commentary ?? '').trim();

    const head = `【${name}的低语】`;
    const quote = (/** @type {string} */ text) => `${head}\n「${text}」`;
    const quip = (/** @type {string} */ text) => `—— ${name}：${text}`;
    /** 硬截到预算内（预算下限 20 字，太短就没有信息量了） */
    const hardTrimQuote = (/** @type {string} */ text) =>
        quote(`${text.slice(0, Math.max(20, maxChars - head.length - 4))}…`);
    const hardTrimQuip = (/** @type {string} */ text) =>
        quip(`${text.slice(0, Math.max(12, maxChars - head.length - 1 - `—— ${name}：`.length - 1))}…`);

    // ⑥ 两个都是空的：只留标题。
    //    不在这里直接返回空串，是为了让纯函数的行为可预测、可测；
    //    「要不要往聊天里塞」这个判断交给 injectGuidance 做（isHollowInjection）。
    if (!guidance && !commentary) return head;

    if (!guidance) {
        // ④ / ⑤：只有吐槽 —— 它是这次唯一的内容，用落款格式，
        //    绝不留空的引用块（那会变成一个什么都不说的楼层）
        const only = `${head}\n${quip(commentary)}`;
        return only.length <= maxChars ? only : hardTrimQuip(commentary);
    }

    // ① 完整版
    const full = commentary ? `${quote(guidance)}\n${quip(commentary)}` : quote(guidance);
    if (full.length <= maxChars) return full;

    // ② 只要引导
    const lean = quote(guidance);
    if (lean.length <= maxChars) return lean;

    // ③ 引导本身就超长
    return hardTrimQuote(guidance);
}

/**
 * 判断一段注入文本是不是「空壳」。
 *
 * 纯函数 `buildInjectionText` 在没有任何内容时会返回只有标题的文本
 *（让它的行为可预测、好测）。但这个标题本身不该被当成一条消息塞进聊天 ——
 * 用户会看到一个写着「【贝翠丝的低语】」却什么都没有的楼层，
 * 只会以为插件坏了。所以落库前必须过这一道。
 *
 * @param {string} text
 * @param {any} settings
 * @returns {boolean}
 */
export function isHollowInjection(text, settings) {
    const name = isVoid(settings) ? '人神' : (String(settings?.injection?.speakerName ?? '贝翠丝').trim() || '贝翠丝');
    const head = `【${name}的低语】`;
    const body = String(text ?? '').trim();
    if (!body) return true;
    // 只有标题，或标题后面跟着一个空的引用块 → 都是空壳
    return body === head || /^【[^】]*的低语】\s*(\n\s*「\s*」)?$/.test(body);
}

/**
 * 把引导**接在正文末尾**，作为她突然插话的一段。
 *
 * ── 这是默认的呈现方式（用户明确要求）
 *
 * 用户原话：「确定引导是插入正文里的且是用贝翠丝的口吻说话的」。
 *
 * ── 为什么不直接改写 `message.mes`
 *
 * `mes` 是**数据**：重新生成、swipe、导出聊天、别的插件读到的都是它。
 * 往里追加内容会污染这些路径 —— 用户一按重新生成，多出来的那段就会
 * 跟着旧正文一起被丢掉或复制，而且永远删不干净。
 *
 * 所以走**渲染层**：ST 的 `updateMessageBlock` 用的是
 * `message.extra.display_text ?? message.mes`。我们只写 `display_text`，
 * `mes` 一个字节都不动 —— 屏幕上看起来就是正文里多了一段她的话，
 * 而底层数据仍然干净、可回滚、与酒馆自身的功能不打架。
 *
 * ── ⚠️ 时序：这里踩过一次「正文末尾没接上」
 *
 * 用户反馈「正文末尾没有接入碧翠丝说话」，而且气泡里的吐槽也没有 ——
 * 说明那次兑现整个没走到，或者走到了但渲染没落地。
 *
 * 根本原因是**时机**。`GENERATION_ENDED` 触发的那一刻，消息可能：
 *   (a) 还没进 `ctx.chat` —— 根本找不到目标
 *   (b) 已进数组，但**楼层还没渲染进 DOM** —— `updateMessageBlock` 找不到节点，
 *       而且它在这种情况下**不会报错**，只当作空操作
 *   (c) 渲染完之后又被流式收尾覆盖了一遍 —— 我们写的东西被冲掉
 *
 * 所以这里做三件事，而不是只调一次 `updateMessageBlock`：
 *   1. **先把 `display_text` 写进消息对象** —— 这是数据、不依赖 DOM，
 *      之后任何一次重渲染都会自动带上她的话。(a)(b)(c) 都因此得救
 *   2. 再尽力触发一次重渲染；**并且校验它真的落地了**（不拿「没抛异常」当成功）
 *   3. 没落地就登记进待补队列，等 `CHARACTER_MESSAGE_RENDERED` /
 *      `MESSAGE_UPDATED` 再补一次（见 `flushPendingAppends`）
 *
 * @param {any} ctx
 * @param {number} messageId
 * @param {{guidance?: string}} result
 * @param {any} settings
 * @returns {{ok: boolean, error?: string, text?: string, rendered?: boolean, persisted?: boolean}}
 */
export function appendGuidanceToMessage(ctx, messageId, result, settings) {
    const guidance = String(result?.guidance ?? '').trim();
    if (!guidance) return { ok: false, error: '这次没有引导内容' };

    const name = isVoid(settings) ? '人神' : (String(settings?.injection?.speakerName ?? '贝翠丝').trim() || '贝翠丝');
    const maxChars = Number(settings?.injection?.maxChars) || 600;
    const spoken = guidance.length > maxChars ? `${guidance.slice(0, maxChars)}…` : guidance;

    try {
        const chat = ctx?.chat;
        if (!Array.isArray(chat)) return { ok: false, error: '当前没有可写入的聊天' };
        const idx = Number(messageId);
        if (!Number.isFinite(idx) || idx < 0 || idx >= chat.length) {
            return { ok: false, error: `找不到第 ${messageId} 条消息（聊天里共 ${chat.length} 条）` };
        }

        const msg = chat[idx];
        if (!msg) return { ok: false, error: '目标消息为空' };

        if (!String(msg.mes ?? '').trim()) return { ok: false, error: '目标消息没有正文可追加' };
        // Retire stale ownership before taking a new base. Never compose on an old tail.
        const previous = displayLayer(msg);
        if (previous && (!sameSource(msg, previous) || msg.extra.display_text !== previous.output)) {
            retireDisplayLayer(msg, previous, !sameSource(msg, previous));
            findDisplayTail(idx)?.remove?.();
        }
        const owned = displayLayer(msg);
        const hadDisplay = owned ? owned.hadDisplay : Object.hasOwn(msg.extra ?? {}, 'display_text');
        const originalDisplay = owned ? owned.originalDisplay : msg.extra?.display_text;
        const base = String((hadDisplay ? originalDisplay : undefined) ?? msg.mes ?? '');
        const addition = `\n\n${DIVIDER}\n${name}：${spoken}`;
        const display = base + addition;
        const layer = { version: 1, source: String(msg.mes ?? ''), swipe: msg.swipe_id ?? null,
            hadDisplay, originalDisplay, base, addition, output: display };

        // ① 先落数据（不依赖 DOM）
        msg.extra = msg.extra ?? {};
        msg.extra.display_text = display;
        msg.extra.beatriceGuide = {
            ...(msg.extra.beatriceGuide ?? {}),
            appendedTo: idx,
            displayLayer: layer,
            realm: isVoid(settings) ? 'void' : 'beatrice',
            at: Date.now(),
        };

        // ② 再尽力触发渲染
        const rendered = rerenderMessage(ctx, idx, msg);

        // ③ 没落地 → 登记待补
        if (rendered) {
            pendingAppends.delete(idx);
        } else {
            pendingAppends.set(idx, { at: Date.now(), tries: (pendingAppends.get(idx)?.tries ?? 0) + 1 });
        }

        return { ok: true, text: display, rendered, persisted: true };
    } catch (e) {
        return { ok: false, error: describeError(e) };
    }
}

/**
 * 引导与正文之间的分隔。
 *
 * 用一条细分割线而不是空行：正文是模型写的散文，她的话是插件加的，
 * 看不见边界的话读者会以为最后那句也是正文的一部分（而那会让人误以为
 * 正文模型写了这句话）。给一条线，边界就清楚了。
 */
const DIVIDER = '──────────';

// Persist full source identity, not a prefix/hash: shortening and equal-text swipes
// invalidate guidance just as edits do. Legacy records are migrated only when their
// recognizable raw appended suffix proves ownership of display_text.
function displayLayer(msg) {
    const meta = msg?.extra?.beatriceGuide;
    if (!meta || meta.appendedTo === undefined) return null;
    if (meta.displayLayer?.version === 1) return meta.displayLayer;
    const output = msg.extra.display_text;
    if (typeof output !== 'string') return null;
    const match = /\n\n──────────\n[^\n：:]+[：:][\s\S]+$/.exec(output);
    if (!match) return null;
    const source = output.slice(0, match.index);
    const layer = { version: 1, source, swipe: msg.swipe_id ?? null,
        hadDisplay: false, base: source, addition: match[0], output };
    meta.displayLayer = layer;
    return layer;
}

function sameSource(msg, layer) {
    return String(msg?.mes ?? '') === layer.source && (msg?.swipe_id ?? null) === layer.swipe;
}

function retireDisplayLayer(msg, layer, sourceChanged = false) {
    if (msg.extra.display_text === layer.output) {
        // An old translation also belongs to the old source after an edit/swipe.
        if (!sourceChanged && layer.hadDisplay) msg.extra.display_text = layer.originalDisplay;
        else delete msg.extra.display_text;
    }
    const meta = msg.extra.beatriceGuide;
    delete meta.displayLayer;
    delete meta.appendedTo;
    if (!meta.injected) { delete meta.realm; delete meta.at; }
    if (!Object.keys(meta).length) delete msg.extra.beatriceGuide;
}

function activeDisplayLayer(msg) {
    const layer = displayLayer(msg);
    return layer && sameSource(msg, layer) && msg.extra.display_text === layer.output ? layer : null;
}

/**
 * 待补渲染的消息下标 → 登记信息。
 *
 * 为什么需要这个队列：`updateMessageBlock` 在楼层还没渲染时不会报错、
 * 也不会生效。而 `display_text` 已经写进数据了，所以只要在楼层渲染出来的
 * 那一刻再触发一次重渲染，她的话就会补上。
 *
 * @type {Map<number, {at: number, tries: number}>}
 */
const pendingAppends = new Map();

/** 待补登记的有效期 —— 超过它说明楼层不会来了，别再惦记。 */
const PENDING_TTL_MS = 60000;

/**
 * 补做「还没渲染成功」的追加。
 *
 * 挂在 `CHARACTER_MESSAGE_RENDERED` / `MESSAGE_UPDATED` 上：
 * 楼层一渲染出来就立刻把 display_text 应用上去。
 *
 * @param {any} ctx
 * @param {number} [onlyIndex] 只处理这一条；不传则清理所有待补
 * @returns {number} 成功补上的条数
 */
export function flushPendingAppends(ctx, onlyIndex) {
    let done = 0;
    const now = Date.now();

    for (const [idx, info] of [...pendingAppends.entries()]) {
        if (now - info.at > PENDING_TTL_MS) {
            pendingAppends.delete(idx);
            continue;
        }
        if (Number.isFinite(onlyIndex) && onlyIndex !== idx) continue;

        const msg = ctx?.chat?.[idx];
        if (!activeDisplayLayer(msg)) {
            repairDisplayedGuidance(ctx, idx, { domOnly: true });
            pendingAppends.delete(idx);
            continue;
        }

        // ⚠️ **先验证再动手**。
        //
        // `rerenderMessage` 内部会调 `updateMessageBlock`，而那个调用会触发
        // `MESSAGE_UPDATED` 事件 —— 事件回到这里，又重渲染一次……无条件重渲染
        // 就是死循环。加一道「已经显示对了就什么都不做」，循环立刻断掉，
        // 这个函数也就可以安全地挂在每一次渲染事件上。
        if (isDisplayApplied(idx, msg)) {
            pendingAppends.delete(idx);
            continue;
        }

        if (rerenderMessage(ctx, idx, msg)) {
            pendingAppends.delete(idx);
            done++;
        } else if (info.tries > 12) {
            // 试太多次还没成，别再反复尝试（避免每次消息事件都白跑一轮）
            pendingAppends.delete(idx);
        } else {
            info.tries++;
        }
    }
    return done;
}

/** 丢掉所有待补登记。换聊天时必须调 —— 那些下标属于**上一个**聊天。 */
export function clearPendingAppends() {
    const n = pendingAppends.size;
    pendingAppends.clear();
    return n;
}

/**
 * 修好「数据里有、页面上没有」的引导。
 *
 * ── 为什么需要它（用户实测的 bug）
 *
 * 诊断里明明白白写着「已接在第 #4 条正文末尾」，页面上却一个字都没有。
 * 原因：`display_text` 只活在**消息对象**上，而酒馆在任何一次重渲染里都可能
 * 用 `mes` 重新铺页面（刷新页面、切走聊天再切回来、主题重排、宿主存盘后
 * reload）。数据一个字没丢，丢的只是「这一次渲染」。
 *
 * 旧实现把「盯着」记在内存的一张 Map 里，而且一验成功就删登记 —— 于是
 * 第一次渲染之后再也没有任何东西看着它。**登记随页面一起消失，判定就永久失效。**
 *
 * 所以判定必须**从数据反推**：凡是带 `extra.beatriceGuide` 记号的楼层，
 * 就应当显示 `extra.display_text`。这条规则不依赖任何内存状态，
 * 刷新后依然成立，而且天然幂等（显示对了就什么都不做），
 * 因此可以安全地挂在每一次渲染事件上。
 *
 * 顺带处理一个必须处理的边界：**正文被改过就不再修**。
 * 用户手动编辑 / 重新生成 / swipe 后，完整 mes 与 swipe_id 必须仍匹配生成
 * 时的快照。display_text 可能以第三方翻译为基底，不能拿 startsWith(mes)
 * 判断归属；只撤销仍等于自己写入值的显示层，不删除后来插件的新覆盖。
 *
 * @param {any} ctx
 * @param {number} [onlyIndex] 只修这一条；不传则扫全部（刷新 / 换聊天后要扫全部）
 * @returns {number} 真正修好的条数
 */
export function repairDisplayedGuidance(ctx, onlyIndex, { domOnly = false } = {}) {
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return 0;
    const only = Number(onlyIndex);
    const single = Number.isFinite(only);
    const tails = single ? [findDisplayTail(only)].filter(Boolean)
        : globalThis.document?.querySelectorAll?.('#chat .bg-inline-guidance') ?? [];
    for (const tail of tails) {
        const idx = Number(tail.getAttribute('data-bg-message-id'));
        if (!chat[idx]?.extra?.beatriceGuide || !chat[idx]?.extra?.display_text) tail.remove();
    }
    let fixed = 0;

    for (let i = single ? only : 0; i < (single ? only + 1 : chat.length); i++) {
        const msg = chat[i];
        // 记号是「这条是我们加过的」的凭据。没有它就不是我们的活，绝不碰。
        if (!msg?.extra?.beatriceGuide) continue;

        const layer = displayLayer(msg);
        if (!layer) { findDisplayTail(i)?.remove?.(); continue; }
        if (!sameSource(msg, layer) || msg.extra.display_text !== layer.output) {
            const changed = !sameSource(msg, layer);
            const owned = msg.extra.display_text === layer.output;
            retireDisplayLayer(msg, layer, changed);
            findDisplayTail(i)?.remove?.();
            pendingAppends.delete(i);
            // DOM-only observers must not reformat a third-party rendered body.
            if (!domOnly && changed && owned) rerenderMessage(ctx, i, msg);
            continue;
        }

        // Pure host-rendered text is not the themed avatar card. Reconcile only
        // our exact rendered suffix, then keep the card through host rerenders.
        if (isDisplayApplied(i, msg) && !hostTailRange(findMessageTextNode(globalThis.document, i), layer)) continue;
        if (domOnly ? restoreDisplayTail(i, msg) : rerenderMessage(ctx, i, msg)) fixed++;
    }
    return fixed;
}

/**
 * 「她的话现在到底在不在页面上」—— 诊断用。
 *
 * `/bg-status` 与诊断面板显示它。有这个字段，用户就不用开 F12 猜：
 * `inData` 是数据里有没有，`onScreen` 是页面上有没有，两者不一致就是本文
 * 那个 bug 的现场。
 *
 * @returns {{watched: number, inData: number, onScreen: number, missing: number[]}}
 */
export function displayReport(ctx) {
    const chat = ctx?.chat;
    const out = {
        watched: 0,
        inData: 0,
        onScreen: 0,
        missing: /** @type {number[]} */ ([]),
        // 下面三个是给「到底是酒馆不认，还是我们写错了」用的
        hostHonorsDisplay,
        patched: Boolean(ctx?.updateMessageBlock?.__beatricePatched),
        watchRepairs,
        watching: activeWatchTimers,
        domObserverActive: activeDisplayObservers > 0,
        observerRepairs,
    };
    if (!Array.isArray(chat)) return out;

    for (let i = 0; i < chat.length; i++) {
        if (!chat[i]?.extra?.beatriceGuide) continue;
        out.watched++;
        if (!chat[i].extra.display_text) continue;
        out.inData++;
        if (isDisplayApplied(i, chat[i])) out.onScreen++;
        else out.missing.push(i);
    }
    return out;
}

/** 当前有多少条待补渲染（诊断用）。 */
export function pendingAppendCount() {
    return pendingAppends.size;
}

/** 独立的纯文本尾段：不重铺正文，也不让角色卡的显示正则再次吞掉引导。 */
function restoreDisplayTail(messageId, msg) {
    const d = globalThis.document;
    const node = findMessageTextNode(d, messageId);
    const layer = activeDisplayLayer(msg);
    if (!node || !layer) return false;
    const text = layer.addition.trim();
    if (!text || !d?.createElement) return false;
    removeHostTail(node, layer);
    let tail = findDisplayTail(messageId);
    if (!tail) {
        tail = d.createElement('div');
        tail.className = 'bg-inline-guidance';
        tail.setAttribute('data-bg-message-id', String(messageId));
        // 放在正文容器之后、同一楼层内。即使正文被 iframe 替换或隐藏也不丢。
        if (node.parentNode?.insertBefore) {
            const siblings = [...(node.parentNode.children ?? [])];
            const anchor = siblings.filter(el => el === node || el.matches?.('.TH-streaming, .mes_streaming')).at(-1) ?? node;
            node.parentNode.insertBefore(tail, anchor.nextSibling);
        }
        else if (node.appendChild) node.appendChild(tail);
        else return false;
    }
    const spoken = guidanceBody(msg);
    const realm = msg.extra.beatriceGuide?.realm === 'void' ? 'void' : 'beatrice';
    const renderKey = `${realm}:${spoken}`;
    tail.setAttribute('data-bg-realm', realm);
    if (tail.getAttribute('data-bg-text') !== renderKey) {
        tail.setAttribute('data-bg-text', renderKey);
        const avatar = d.createElement('img');
        avatar.setAttribute('class', 'bg-guidance-avatar');
        avatar.setAttribute('src', modeImageUrl({ realm }, 'inline'));
        avatar.setAttribute('alt', realm === 'void' ? '人神' : '碧翠丝');
        const content = d.createElement('div');
        content.setAttribute('class', 'bg-guidance-content');
        content.textContent = spoken;
        if (tail.replaceChildren) tail.replaceChildren(avatar, content);
        else tail.textContent = spoken;
    }
    return isDisplayApplied(messageId, msg);
}

// Locate the complete owned suffix, never a matching sentence in the body.
// Mapping text offsets lets us delete only that suffix without rebuilding HTML,
// translated paragraphs, event handlers or streaming iframe nodes.
function hostTailRange(node, layer) {
    if (!node || !layer) return null;
    const parts = [];
    const visit = n => {
        if (n.nodeType === 3) parts.push({ node: n, text: String(n.nodeValue ?? n.textContent ?? '') });
        else for (const child of n.childNodes ?? []) visit(child);
    };
    visit(node);
    const raw = parts.length ? parts.map(p => p.text).join('') : String(node.textContent ?? '');
    let normalized = '', offsets = [];
    for (let i = 0; i < raw.length; i++) if (!/\s/.test(raw[i])) { normalized += raw[i]; offsets.push(i); }
    const suffix = layer.addition.replace(/\s+/g, '');
    if (!suffix || !normalized.endsWith(suffix)) return null;
    const start = offsets[normalized.length - suffix.length];
    // Require the exact divider+speaker+full guidance, not a partial tail match.
    return { parts, raw, start };
}
function removeHostTail(node, layer) {
    const found = hostTailRange(node, layer);
    if (!found) return false;
    const d = globalThis.document;
    if (found.parts.length && d?.createRange) {
        let offset = 0;
        const first = found.parts.find(p => {
            const end = offset + p.text.length;
            if (found.start < end) return true;
            offset = end; return false;
        });
        if (!first) return false;
        const last = found.parts.at(-1);
        const range = d.createRange();
        range.setStart(first.node, found.start - offset);
        range.setEnd(last.node, last.text.length);
        range.deleteContents();
        return true;
    }
    // Minimal fake/legacy text-only nodes: never replace an element subtree.
    if (!node.childNodes?.length && !node.children?.length) {
        node.textContent = found.raw.slice(0, found.start).replace(/\s+$/, '');
        return true;
    }
    return false;
}

function guidanceBody(msg) {
    const addition = activeDisplayLayer(msg)?.addition.trim() ?? '';
    return addition.replace(/^──────────\s*\n[^\n：:]+[：:]\s*/, '');
}

function findDisplayTail(messageId) {
    return globalThis.document?.querySelector?.(`#chat .mes[mesid="${Number(messageId)}"] .bg-inline-guidance`);
}

/**
 * 把某条消息该显示的内容直接写进 DOM（不经过酒馆的渲染函数）。
 *
 * ⚠️ 必须用 `messageFormatting` 而不是裸 `innerHTML` —— 正文来自模型，
 * 直接 innerHTML 会引入 XSS 面。
 *
 * @returns {boolean} 有没有真的写上去（找不到楼层节点就是 false）
 */
function applyDisplayToDom(ctx, messageId, msg) {
    try {
        const d = /** @type {any} */ (globalThis)?.document;
        const node = findMessageTextNode(d, messageId);
        if (!node) return false;
        if (msg?.extra?.beatriceGuide && msg.extra.display_text) {
            return restoreDisplayTail(messageId, msg);
        }

        // ⚠️ 取值必须是 `display_text ?? mes`，与酒馆 `updateMessageBlock` 的
        //    顺序一致。只写 display_text 的话，「正文被改过就清掉 display_text」
        //    那条路径会走到这里、把用户的正文**整条清空** ——
        //    这是显示修复测试当场抓出来的（页面变成空白）。
        const display = String(msg?.extra?.display_text ?? msg?.mes ?? '');
        const html =
            typeof ctx?.messageFormatting === 'function'
                ? ctx.messageFormatting(display, msg.name, msg.is_system, msg.is_user, messageId)
                : null;
        if (html) node.innerHTML = html;
        else node.textContent = display;
        // 格式化/正则可能移除尾段，写入成功不等于引导可见。
        return !msg?.extra?.beatriceGuide || !msg.extra.display_text || isDisplayApplied(messageId, msg);
    } catch {
        return false;
    }
}

/**
 * 「酒馆自己会不会显示 display_text」—— 诊断用。
 *
 * `null` = 还没试过；`true` = 官方渲染路径就认 display_text；
 * `false` = 它不认（那一行是**我们**补上去的，任何一次重渲染都会抹掉，
 * 所以必须靠下面的监视把话补回来）。
 *
 * 这个字段能一眼回答「到底是酒馆不支持，还是我们写错了」。
 *
 * @type {boolean|null}
 */
let hostHonorsDisplay = null;

/** 读取上面那个诊断值。 */
export function hostRenderHonorsDisplay() {
    return hostHonorsDisplay;
}

/**
 * 让酒馆重新渲染某条消息。
 *
 * 顺序：`updateMessageBlock`（ST 官方路径，会正确走一遍格式化与安全过滤）
 * → 自己改 DOM（老版本 / 特殊主题 / 楼层结构不同）。
 *
 * @returns {boolean} 内容是否**真的**放上去了
 */
function rerenderMessage(ctx, messageId, msg) {
    // A translated/rendered base belongs to another plugin. Add only our safe tail;
    // asking a host which ignores display_text to rerender would replace it by mes.
    if (activeDisplayLayer(msg)?.hadDisplay) return restoreDisplayTail(messageId, msg);
    // ① 官方路径。ST 原版内部取值是 `display_text ?? mes`，正是我们要的。
    try {
        if (typeof ctx?.updateMessageBlock === 'function') {
            const render = ctx.updateMessageBlock.__beatriceOriginal ?? ctx.updateMessageBlock;
            render.call(ctx, messageId, msg, { rerenderMessage: true });
            // ⚠️ 不能因为「没抛异常」就认为成功：楼层不存在时它是空操作。
            //    所以下面用 DOM 校验一遍，真没上去就走兜底。
            if (hostTailRange(findMessageTextNode(globalThis.document, messageId), activeDisplayLayer(msg))) {
                hostHonorsDisplay = true;
                return restoreDisplayTail(messageId, msg);
            }
            // 楼层在、但内容不对 → 这个宿主不认 display_text（TauriTavern 实测如此）
            if (findMessageTextNode(/** @type {any} */ (globalThis)?.document, messageId)) {
                hostHonorsDisplay = false;
            }
        }
    } catch (e) {
        console.warn(`[碧翠丝] updateMessageBlock 失败，回落直接改 DOM：${describeError(e)}`);
    }

    // ② 自己改 DOM。
    return applyDisplayToDom(ctx, messageId, msg);
}

/**
 * 接管 `ctx.updateMessageBlock`，让**任何**一次酒馆发起的重渲染都带上她的话。
 *
 * ── 为什么必须做到这一层（用户实测的 bug）
 *
 * 诊断里 `inData: 1 / onScreen: 0`：数据里写着，页面上没有。也就是说
 * TauriTavern 的渲染路径**不认** `extra.display_text`，我们自己调
 * `updateMessageBlock` 之后还得靠兜底补一次 DOM —— 而那一补只活到下一次
 * 重渲染为止（流式收尾、滚动重排、切走切回、改变字体大小……）。
 *
 * 之前只挂在渲染**事件**上，结果是：覆盖发生了，但没有任何事件再触发，
 * 话就永久消失。监视（watchDisplayedGuidance）解决「刚写完被覆盖」，
 * 这个包装解决「之后任何一次宿主渲染」—— 两道一起才盖得住。
 *
 * 幂等：重复调用只会包一层。包装后先调原函数，再检查要不要补。
 *
 * @param {any} ctx
 * @returns {boolean} 有没有装上
 */
export function patchUpdateMessageBlock(ctx) {
    try {
        if (!ctx || typeof ctx.updateMessageBlock !== 'function') return false;
        if (ctx.updateMessageBlock.__beatricePatched) return true;

        const original = ctx.updateMessageBlock;
        const wrapped = function (/** @type {any[]} */ ...args) {
            const out = original.apply(this, args);
            try {
                const idx = Number(args[0]);
                const msg = args[1] ?? ctx.chat?.[idx];
                // 只碰带我们记号的楼层，别人的消息一律不插手
                if (Number.isFinite(idx) && msg?.extra?.beatriceGuide && msg.extra.display_text) {
                    repairDisplayedGuidance(ctx, idx, { domOnly: true });
                }
            } catch {
                /* 补显示失败不能影响酒馆自己的渲染 */
            }
            return out;
        };
        wrapped.__beatriceOriginal = original;
        wrapped.__beatricePatched = true;
        ctx.updateMessageBlock = wrapped;
        return true;
    } catch {
        // ctx 可能是冻结对象 / 只读属性 —— 装不上不是致命错误，
        // 只是少了一道保险，靠监视与渲染事件兜着。
        return false;
    }
}

/**
 * 刚追加完之后，盯一小段时间。
 *
 * 只挂在渲染事件上是不够的（实测）：写入成功、校验也通过，然后酒馆的流式
 * 收尾把楼层按 `mes` 重铺一遍 —— **而这次重铺不一定会发渲染事件**。
 * 那一下之后就再没有任何东西看着它了，话永久消失。
 *
 * 所以在几个时间点上主动回头看一眼，缺了就补。次数与间隔都刻意很小：
 * 覆盖几乎都发生在生成结束后的几秒内；盯得越久越费，还容易和流式打架。
 *
 * @param {any} ctx
 * @param {number} messageId
 * @param {{delays?: number[]}} [opts]
 * @returns {() => void} 取消函数（换聊天 / 拆插件时要调）
 */
export function watchDisplayedGuidance(ctx, messageId, opts = {}) {
    const delays = Array.isArray(opts.delays) ? opts.delays : [400, 1200, 2500, 5000, 9000, 15000];
    /** @type {any[]} */
    const timers = [];
    let stopped = false;

    for (const delay of delays) {
        activeWatchTimers++;
        const timer = setTimeout(() => {
            // 到点了就把它从「还盯着」里摘掉；下面 stop() 不能重复摘
            timers.splice(timers.indexOf(timer), 1);
            activeWatchTimers--;
            try {
                const idx = Number(messageId);
                const msg = ctx?.chat?.[idx];
                if (!msg?.extra?.beatriceGuide || !msg.extra.display_text) return;
                if (isDisplayApplied(idx, msg) && !hostTailRange(findMessageTextNode(globalThis.document, idx), activeDisplayLayer(msg))) return;
                watchRepairs += repairDisplayedGuidance(ctx, idx, { domOnly: true });
            } catch {
                /* ignore */
            }
        }, delay);
        timers.push(timer);
    }

    return () => {
        if (stopped) return; // 取消函数要能被重复调用（拆插件时会连着调）
        stopped = true;
        for (const t of timers) {
            clearTimeout(t);
            activeWatchTimers--;
        }
        timers.length = 0;
    };
}

/** 持续监听实际 DOM，而非依赖宿主是否发送消息事件。无变化时不轮询。 */
export function observeDisplayedGuidance(getContext) {
    const d = globalThis.document;
    const Observer = globalThis.MutationObserver;
    if (!d?.body || typeof Observer !== 'function') return () => {};
    let stopped = false;
    let timer = null;
    let fullScan = true;
    const affected = new Set();
    const relevant = (n) => {
        const el = n?.nodeType === 3 ? n.parentElement : n;
        return Boolean(el?.id === 'chat' || el?.closest?.('#chat') || el?.querySelector?.('#chat'));
    };
    const options = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] };
    const schedule = () => {
        if (stopped || timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            if (stopped) return;
            // 自己写入时断开，避免反馈循环；后续宿主覆盖仍会再次通知。
            observer.disconnect();
            try {
                const ctx = getContext();
                if (fullScan) observerRepairs += repairDisplayedGuidance(ctx, undefined, { domOnly: true });
                else for (const idx of affected) observerRepairs += repairDisplayedGuidance(ctx, idx, { domOnly: true });
                affected.clear();
                fullScan = false;
            } catch (e) {
                console.warn('[碧翠丝] DOM 引导修复失败', e);
            } finally {
                if (!stopped) observer.observe(d.body, options);
            }
        }, 80);
    };
    const observer = new Observer((records) => {
        let changed = false;
        for (const r of records) {
            for (const n of [r.target, ...(r.addedNodes ?? []), ...(r.removedNodes ?? [])]) {
                if (!relevant(n)) continue;
                changed = true;
                const el = n?.nodeType === 3 ? n.parentElement : n;
                const floor = el?.closest?.('.mes[mesid]');
                const id = floor?.getAttribute?.('mesid');
                if (id != null && Number.isInteger(Number(id))) affected.add(Number(id));
                else fullScan = true; // chat replacement/removal needs a global reconciliation
            }
        }
        if (changed) schedule();
    });
    observer.observe(d.body, options);
    activeDisplayObservers++;
    schedule(); // 启动时也恢复已保存的引导，不要求先生成一轮。
    return () => {
        if (stopped) return;
        stopped = true;
        observer.disconnect();
        if (timer !== null) clearTimeout(timer);
        timer = null;
        activeDisplayObservers--;
    };
}
let activeDisplayObservers = 0;
let observerRepairs = 0;

/** 监视一共补回来过几次（诊断用：非 0 就说明这台酒馆确实会覆盖）。 */
let watchRepairs = 0;

/** 还有几个「回看点」没到时间（诊断用：>0 说明此刻正盯着）。 */
let activeWatchTimers = 0;

/** 读取上面的计数。 */
export function watchRepairCount() {
    return watchRepairs;
}

/** 读取「正在盯着的回看点」个数。 */
export function activeWatchCount() {
    return activeWatchTimers;
}

/**
 * 把上面几个模块级诊断值归零。
 *
 * 它们记的是「这台酒馆的行为」，所以是模块级的。测试要断言它们的**初始**
 * 状态时必须先归零，否则断言结果会取决于用例的执行顺序 —— 那种测试跑一次
 * 绿、换个顺序就红，比没有测试更浪费时间。
 */
export function resetDisplayDiagnostics() {
    hostHonorsDisplay = null;
    watchRepairs = 0;
    observerRepairs = 0;
    activeWatchTimers = 0;
}

/**
 * 找一个楼层的正文节点。
 *
 * 选择器写得宽一点：不同酒馆版本 / 主题里正文容器的 class 名不一样
 *（`.mes_text` 最常见，但也有别的写法）。主选择器都落空时，退到
 * 「楼层里最后一个 div」—— 名字块通常排在正文前面。
 *
 * @param {any} d
 * @param {number} messageId
 * @returns {any|null}
 */
function findMessageTextNode(d, messageId) {
    if (!d?.querySelector) return null;
    const mid = Number(messageId);

    const direct =
        d.querySelector(`#chat .mes[mesid="${mid}"] .mes_text`) ??
        d.querySelector(`.mes[mesid="${mid}"] .mes_text`) ??
        d.querySelector(`#chat .mes[mesid="${mid}"] .mes_text_wrapper`);
    if (direct) return direct;

    const mes = d.querySelector(`#chat .mes[mesid="${mid}"]`) ?? d.querySelector(`.mes[mesid="${mid}"]`);
    if (!mes) return null;

    const inner = mes.querySelector?.('.mes_text') ?? mes.querySelector?.('[class*="mes_text"]');
    if (inner) return inner;

    // 不猜测「最后一个 div」：它可能是按钮、iframe 或编辑工具栏。
    return null;
}

/**
 * 检查 display_text 是否已经落到 DOM 上。
 *
 * 用途：`updateMessageBlock` 在楼层不存在时不报错也不生效，
 * 所以不能拿「没抛异常」当成功。
 *
 * 判定刻意宽松（只要页面上出现了她那段话的结尾就算成功），
 * 因为不同主题会把文本重新排版、加空白或插入标签。
 *
 * @returns {boolean}
 */
function visibleText(node) {
    if (!node) return '';
    if (typeof globalThis.getComputedStyle === 'function') {
        for (let el = node; el?.nodeType === 1; el = el.parentElement) {
            const style = globalThis.getComputedStyle(el);
            if (el.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';
        }
    }
    return String(node.innerText ?? node.textContent ?? '').replace(/\s+/g, '');
}

function isDisplayApplied(messageId, msg) {
    try {
        if (!activeDisplayLayer(msg)) return false;
        const tail = guidanceBody(msg).slice(-24).replace(/\s+/g, '');
        if (!tail) return false;

        const d = /** @type {any} */ (globalThis)?.document;
        const own = findDisplayTail(messageId);
        const realm = msg.extra.beatriceGuide?.realm === 'void' ? 'void' : 'beatrice';
        if (own && own.getAttribute?.('data-bg-text') === `${realm}:${guidanceBody(msg)}` &&
            own.getAttribute?.('data-bg-realm') === realm && visibleText(own).includes(tail)) return true;
        return false; // Raw text alone is not a completed avatar card.
    } catch {
        return false;
    }
}

/**
 * 清掉某条消息上追加的引导（渲染层的数据，`mes` 本来就没被动过）。
 * 用户想「让正文恢复原样」时用。
 *
 * @param {any} ctx
 * @param {number} messageId
 * @returns {boolean}
 */
export function clearAppendedGuidance(ctx, messageId) {
    try {
        const msg = ctx?.chat?.[Number(messageId)];
        const layer = displayLayer(msg);
        if (!layer) return false;
        const ownsDisplay = msg.extra.display_text === layer.output;
        const renderedInBody = visibleText(findMessageTextNode(globalThis.document, messageId))
            .includes(guidanceBody(msg).slice(-24).replace(/\s+/g, ''));
        retireDisplayLayer(msg, layer, !sameSource(msg, layer));
        pendingAppends.delete(Number(messageId));
        findDisplayTail(messageId)?.remove?.();
        // A later plugin override belongs to that plugin, including its rendered DOM.
        if (!ownsDisplay) return true;
        if (layer.hadDisplay) return renderedInBody ? applyDisplayToDom(ctx, Number(messageId), msg) : true;
        return rerenderMessage(ctx, Number(messageId), msg);
    } catch {
        return false;
    }
}

/**
 * 落一条注入消息到聊天。
 *
 * 两个动作必须**都做**（本机实测的坑）：
 *  - `chat.push()` 进数据 —— 否则刷新后消息消失
 *  - `addOneMessage()` 渲染楼层 —— 否则当前页面看不到
 * 只做任一个都会出问题。
 *
 * @param {any} ctx
 * @param {{guidance?: string, commentary?: string, emotion?: string, hooks_used?: string[]}} result
 * @param {any} settings
 * @param {{ reason?: string, validate?: () => boolean }} [opts]
 * @returns {Promise<{ok: boolean, error?: string, message?: any, text?: string}>}
 */
export async function injectGuidance(ctx, result, settings, opts = {}) {
    const text = buildInjectionText(result, settings);
    // 空壳（只有标题 / 只有一个空引用块）不算内容 —— 不能往聊天里塞无意义的楼层
    if (isHollowInjection(text, settings)) return { ok: false, error: '没有可注入的内容' };

    if (settings?.injection?.mode === 'off') {
        return { ok: false, error: '注入已在设置里关闭' };
    }

    const message = {
        name: isVoid(settings) ? '人神' : (String(settings?.injection?.speakerName ?? '贝翠丝').trim() || '贝翠丝'),
        is_user: false,
        // is_system: true → 隐藏，不发给 LLM（见文件头说明）
        is_system: true,
        mes: text,
        extra: {
            beatriceGuide: {
                injected: true,
                at: Date.now(),
                emotion: String(result?.emotion ?? 'calm'),
                hooksUsed: Array.isArray(result?.hooks_used) ? result.hooks_used.slice(0, 12) : [],
                reason: String(opts.reason ?? ''),
            },
        },
        swipes: [text],
        swipe_id: 0,
    };

    try {
        if (!Array.isArray(ctx?.chat)) return { ok: false, error: '当前没有可写入的聊天' };

        if (opts.validate && !opts.validate()) return { ok: false, error: '请求目标已失效' };
        ctx.chat.push(message);

        if (typeof ctx.addOneMessage === 'function') {
            try {
                await ctx.addOneMessage(message, { isSmallSys: settings?.injection?.isSmallSys !== false });
            } catch (e) {
                // 渲染失败不算致命：数据已经进去了，刷新页面还能看到
                console.warn(`[碧翠丝] 渲染注入消息失败（数据已写入，刷新可见）：${describeError(e)}`);
            }
        }

        if (opts.validate && !opts.validate()) return { ok: false, error: '请求目标已失效' };
        if (typeof ctx.saveChat === 'function') {
            try {
                await ctx.saveChat();
            } catch (e) {
                // 群聊里 saveChat 会抛，但内存与 chatMetadata 仍是好的
                console.warn(`[碧翠丝] saveChat 失败（消息仍在内存中）：${describeError(e)}`);
            }
        }

        if (opts.validate && !opts.validate()) return { ok: false, error: '请求目标已失效' };
        return { ok: true, message, text };
    } catch (e) {
        return { ok: false, error: describeError(e) };
    }
}

/**
 * 给注入的消息楼层打一个标记 class，方便 CSS 单独美化。
 *
 * 为什么需要：`addOneMessage` 渲染出来的楼层用的是酒馆自己的 class，
 * 我们没法在渲染前插手。所以渲染后回查 DOM 补一个标记。
 * 找不到就静默跳过（不同酒馆版本的 DOM id 规则不一样，不能硬依赖）。
 *
 * @param {any} ctx
 */
export function tagInjectedMessageDom(ctx) {
    try {
        const chat = ctx?.chat;
        if (!Array.isArray(chat)) return;
        const idx = chat.length - 1;
        if (idx < 0 || !chat[idx]?.extra?.beatriceGuide?.injected) return;

        const doc = /** @type {any} */ (globalThis)?.document;
        if (!doc?.querySelector) return;
        const node = doc.querySelector(`#chat .mes[mesid="${idx}"]`);
        if (node?.classList?.add) node.classList.add(`${CSS_PREFIX}injected-mes`);
    } catch {
        /* 标记失败不影响功能 */
    }
}

/** 统计当前聊天里已经注入了多少条贝翠丝的话。 */
export function countInjected(ctx) {
    try {
        const chat = ctx?.chat;
        if (!Array.isArray(chat)) return 0;
        return chat.filter((m) => m?.extra?.beatriceGuide?.injected).length;
    } catch {
        return 0;
    }
}
