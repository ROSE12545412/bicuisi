/**
 * 碧翠丝的禁书库 / src/context.js
 * ---------------------------------------------------------------------------
 * 组装「当前局势」快照，交给辅助 API。
 *
 * 这里是**唯一**大量读聊天记录的地方，所以两个原则：
 *  1. **必须截断**。一个跑了几百楼的长聊天如果整段塞进提示词，
 *     不但贵，还会把真正的近期事件稀释掉 —— 辅助模型会去引导几十轮前的事。
 *  2. **必须防自己**。插件注入的「贝翠丝的低语」消息不能出现在场面节选里，
 *     否则模型会把自己的上一次输出当成剧情事实再讲一遍（自我强化的复读机）。
 */

/** 从后往前取多少条消息作为场面节选。 */
const SCENE_MESSAGES = 8;

/** 场面里单条消息的截断长度。 */
const SCENE_MSG_CHARS = 220;

/** 最新一段正文取多少字（判断剧情走到哪 + 当吐槽素材）。 */
const LAST_AI_CHARS = 600;

/** 契约者最后发言取多少字。 */
const LAST_USER_CHARS = 300;

/** 去重记忆里取最近多少条给模型看。 */
const RECENT_SPOKEN = 6;

/**
 * 判断一条消息是不是本插件自己注入的。
 *
 * 需要这个判断是因为：注入的引导本身会出现在 `ctx.chat` 里，
 * 如果把它当成剧情事实再喂回辅助模型，就会形成
 * 「引导 → 被当成剧情 → 又基于它引导」的自我强化回环。
 *
 * @param {any} message
 * @returns {boolean}
 */
export function isInjectedMessage(message) {
    try {
        return Boolean(message?.extra?.beatriceGuide?.injected);
    } catch {
        return false;
    }
}

/** 截断到 n 个字符，超出加省略号。 */
export function cut(text, n) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (s.length <= n) return s;
    return `${s.slice(0, n)}…`;
}

/**
 * 取聊天里「真正属于角色扮演」的消息（排除插件注入的消息和空消息）。
 * @param {any} ctx
 * @returns {any[]}
 */
export function roleplayMessages(ctx) {
    try {
        const chat = ctx?.chat;
        if (!Array.isArray(chat)) return [];
        return chat.filter((m) => {
            if (!m || isInjectedMessage(m)) return false;
            const text = String(m.mes ?? '').trim();
            if (!text) return false;
            return true;
        });
    } catch {
        return [];
    }
}

/** 从后往前找最后一条符合条件的消息。 */
function findLast(messages, predicate) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (predicate(messages[i])) return messages[i];
    }
    return null;
}

/**
 * 当前是第几条 AI 消息（等价于「第几轮」）。
 * 用它在聊天数据里做幂等标记：同一条 AI 消息只引导一次。
 * @param {any} ctx
 * @returns {number}
 */
export function currentTurnIndex(ctx) {
    try {
        const chat = ctx?.chat;
        if (!Array.isArray(chat)) return 0;
        let n = 0;
        for (const m of chat) {
            if (!m) continue;
            if (!m.is_user && !m.is_system) n++;
        }
        return n;
    } catch {
        return 0;
    }
}

/**
 * 当前聊天里的角色名 / 用户名。
 * @param {any} ctx
 * @returns {{userName: string, charName: string}}
 */
export function speakerNames(ctx) {
    let userName = '';
    let charName = '';
    try {
        userName = String(ctx?.name1 ?? '').trim();
    } catch {
        /* ignore */
    }
    try {
        const chid = Number(ctx?.characterId);
        const chars = ctx?.characters;
        if (Array.isArray(chars) && Number.isFinite(chid) && chid >= 0 && chars[chid]) {
            charName = String(chars[chid]?.name ?? '').trim();
        }
        if (!charName) charName = String(ctx?.name2 ?? '').trim();
    } catch {
        /* ignore */
    }
    return { userName, charName };
}

/**
 * 组装 GuideContext。
 *
 * @param {any} ctx
 * @param {any} settings
 * @param {{ hooksText?: string, hooks?: any[], recentSpoken?: string[] }} [extras]
 * @returns {any} 见 docs/CONTRACTS.md §3
 */
export function buildGuideContext(ctx, settings, extras = {}) {
    const messages = roleplayMessages(ctx);
    const recent = messages.slice(-SCENE_MESSAGES);

    const sceneText = recent
        .map((m) => {
            const who = m.is_user ? speakerNames(ctx).userName || '契约者' : String(m.name ?? '').trim() || '同行者';
            return `${who}：${cut(m.mes, SCENE_MSG_CHARS)}`;
        })
        .join('\n');

    const lastAi = findLast(messages, (m) => !m.is_user && !m.is_system);
    const lastUser = findLast(messages, (m) => m.is_user);

    const spoken = Array.isArray(extras.recentSpoken) ? extras.recentSpoken.slice(-RECENT_SPOKEN) : [];
    const names = speakerNames(ctx);

    // 刚写完的正文：调用方（app.runPostGeneration）会把**定稿的正文全文**传进来。
    //
    // 为什么不用上面的 `lastAi`：`SCENE_MESSAGES` 只取最近几条、每条又截到
    // `SCENE_MSG_CHARS`，那是给「来龙去脉」看的。而这一版的核心是
    // 「读完之后再开口」，模型需要看到**完整的**那一段才接得上。
    //
    // 传不进来时（例如手工触发、老路径）退回 lastAi，行为不至于变差。
    const finished = String(extras.finishedText ?? '').trim();

    return {
        userName: names.userName,
        charName: names.charName,
        sceneText,
        lastUserText: lastUser ? cut(lastUser.mes, LAST_USER_CHARS) : '',
        lastAiText: finished || (lastAi ? cut(lastAi.mes, LAST_AI_CHARS) : ''),
        hooksText: String(extras.hooksText ?? ''),
        hooks: Array.isArray(extras.hooks) ? extras.hooks : [],
        // 两段式第一段（定位）的结论：「故事现在演到哪了」。
        // 空串表示这次没跑定位（索引太小，或定位失败）——
        // buildUserPrompt 见不到它就不写那一段，不会出现空标题。
        locatedPhase: String(extras.locatedPhase ?? ''),
        turnIndex: currentTurnIndex(ctx),
        recentSpoken: spoken,
    };
}

/**
 * 字符二元组 Jaccard 相似度。
 *
 * 为什么不用简单的「包含」或编辑距离：
 *  - 模型复读时几乎不会一字不差，总会换几个字（「旧城区」→「旧城那边」），
 *    `includes` 抓不到。
 *  - 编辑距离对长句不敏感，「今天街上的人都在往同一个方向走」和
 *    「今天街上的人全都朝同一个方向去了」编辑距离不小，但语义上就是复读。
 * 二元组 Jaccard 对这种「换字不改意」的情况最稳，而且 O(n) 很便宜。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0~1
 */
export function similarity(a, b) {
    const s1 = String(a ?? '').replace(/[\s，。！？、,.!?「」“”"'…—]/g, '');
    const s2 = String(b ?? '').replace(/[\s，。！？、,.!?「」“”"'…—]/g, '');
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;

    /** 生成字符二元组集合（长度 1 的串用自身） */
    const grams = (s) => {
        const set = new Set();
        if (s.length === 1) {
            set.add(s);
            return set;
        }
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
    };

    const g1 = grams(s1);
    const g2 = grams(s2);
    let inter = 0;
    for (const g of g1) if (g2.has(g)) inter++;
    const union = g1.size + g2.size - inter;
    return union > 0 ? inter / union : 0;
}

/**
 * 判断一句新话是不是在重复已经说过的内容。
 * @param {string} text
 * @param {string[]} spoken
 * @param {number} [threshold]
 * @returns {{duplicate: boolean, score: number, matched: string}}
 */
export function findDuplicate(text, spoken, threshold = 0.72) {
    const list = Array.isArray(spoken) ? spoken : [];
    let best = { duplicate: false, score: 0, matched: '' };
    for (const prev of list) {
        const score = similarity(text, prev);
        if (score > best.score) best = { duplicate: score >= threshold, score, matched: String(prev) };
    }
    return best;
}
