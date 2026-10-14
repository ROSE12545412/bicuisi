/**
 * 碧翠丝的禁书库 / src/llm/guide.js
 * ---------------------------------------------------------------------------
 * 引导生成：取钩子 → 组装提示词 → 调辅助 API → 容错解析 → 去重。
 *
 * 解析层必须**极其容错**。实测过的现实：即使提示词明确写了「只输出 JSON」，
 * 不同模型仍然会返回这些花样：
 *   - ```json 围栏
 *   - 前面加一句「好的，以下是结果：」
 *   - 末尾跟一句「希望对你有帮助！」
 *   - 单引号当键名
 *   - 中文引号 「guidance」 当键名
 *   - 尾随逗号
 *   - 直接输出纯文本（完全没有 JSON）
 * 最后一种不能算失败 —— 那句纯文本往往就是一条能用的引导，丢了可惜。
 */

import { EMOTIONS } from '../config.js';
import { resolveStageLlm } from '../api-presets.js';
import { isRuleBook } from '../realm-worldbook.js';
import { formatFactsForPrompt, getFactState, uncertainContext } from '../facts.js';
import { getMemoryPrompt } from '../memories.js';
import { buildGuideContext, findDuplicate } from '../context.js';
import { LlmClient, toText, describeError } from './client.js';
import { buildOutputSchema, buildPersonaMessages, buildUserPrompt, buildSourceAssessmentPrompt } from '../prompts.js';
import { formatHooksForPrompt, formatIndexForLocate, resolveHookContents } from '../worldbook.js';

/**
 * 从模型输出里抠出第一个**平衡的** `{...}` 对象。
 *
 * 为什么不用贪婪正则 `/ \{[\s\S]*\} /`：模型常在 JSON 后面继续写解释文字，
 * 贪婪匹配会一路吃到最后一个 `}`，把尾部的说明文字包进来导致 parse 失败。
 * 所以这里手动扫一遍括号深度，并且**跳过字符串内部的括号**。
 *
 * @param {string} text
 * @returns {string} 找不到返回空串
 */
export function extractBalancedJson(text) {
    const s = String(text ?? '');
    const start = s.indexOf('{');
    if (start < 0) return '';

    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;

    for (let i = start; i < s.length; i++) {
        const ch = s[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === quote) {
                inString = false;
            }
            continue;
        }

        if (ch === '"' || ch === "'" || ch === '“' || ch === '”' || ch === '「' || ch === '」') {
            inString = true;
            quote = ch === '“' || ch === '”' ? '”' : ch === '「' || ch === '」' ? '」' : ch;
            // 中文引号成对规则和 ASCII 不同，简化处理：配对到同类右引号
            if (ch === '“') quote = '”';
            if (ch === '「') quote = '」';
            continue;
        }

        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return '';
}

/**
 * 把「中文引号被当成 JSON 字符串定界符」的文本换成 ASCII 双引号。
 *
 * 为什么需要单独一步、而且必须在 extractBalancedJson **之前**做：
 * 模型（尤其是中文语料为主的模型）经常把 `"key": "value"` 写成
 * `「key」：「value」` 或 `“key”：“value”`。这时候
 *  - `extractBalancedJson` 会把 `「…」` 当成字符串内容，于是整个
 *    `{「guidance」：「街角的风向变了」}` 被当成**一个 value**，
 *    解析出来就变成 `{ "「guidance」：「街角的风向变了」": ... }` 这种垃圾；
 *  - 放到 extractBalancedJson 之后再换已经晚了（对象边界已经切错了）。
 *
 * ⚠️ 不能无脑全局替换：如果 JSON 是正常的 ASCII 引号，而**字符串内容里**
 * 出现了中文引号（例 `{"guidance":"他说「别回头」"}`），全局替换会当场把
 * JSON 结构破坏掉。所以这里只在确认「中文引号确实在当定界符用」时才换 ——
 * 判据是 `「xxx」` 这类片段的紧接着是一个冒号（键）或逗号/右花括号（值）。
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeCjkQuotes(text) {
    const s = String(text ?? '');
    if (!/[「」“”]/.test(s)) return s;

    // 中文引号在「定界符」位置上的形态：引号片段后面紧跟 : , } 之一
    const looksLikeDelimiter = /[「“][^「」“”\n]{0,40}[」”]\s*[:：,，}]/.test(s);
    if (!looksLikeDelimiter) return s;

    // 只在**引号成对出现在结构位置**时才换，避免动到字符串内部的中文引号。
    // 这里的取舍：宁可漏救一种畸形输出，也不要把本来能解析的 JSON 弄坏。
    return s
        .replace(/[「“]([^「」“”\n]{0,40})[」”](\s*[:：])/g, '"$1"$2') // 键
        .replace(/[:：]\s*[「“]([^「」“”\n]{0,400})[」”]/g, ': "$1"') // 值
        .replace(/([,{，｛]\s*)[「“]([^「」“”\n]{0,400})[」”](\s*[,}，｝])/g, '$1"$2"$3'); // 无键的值
}

/**
 * 在**不碰字符串字面量内部**的前提下，修掉 JSON 里那些「结构位置上的全角标点」。
 *
 * 为什么必须逐字符扫描、不能用 `/：/g` 全局替换：
 * 模型输出的引导是一句中文，里面天然带全角标点。
 * `{"guidance":"先去东边，再去西边",}`（尾随逗号，需要走抢救路径）如果被全局替换，
 * 句子会变成「先去东边,再去西边」—— 解析是成功了，但**模型的原话被静默改写**。
 * 用户看到的是一句标点乱掉的中文，而且完全不知道是插件干的。
 *
 * 所以这里区分位置：
 *  - 在字符串**内部**（`inString`）→ 双引号与反斜杠要转义，其余字符原样保留；
 *    但**引号本身**要归一化（中文引号当定界符是常见的畸形写法）。
 *  - 在字符串**外部**（结构位置）→ 全角冒号/逗号/花括号/方括号一律换成半角。
 *
 * @param {string} text
 * @returns {string}
 */
function repairStructuralPunctuation(text) {
    const s = String(text ?? '');
    let out = '';
    let inString = false;
    let quoteChar = '';

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        if (inString) {
            // 闭合引号：ASCII 双引号 / 中文引号（与开启的那个配对）
            if (ch === quoteChar || (quoteChar === '"' && (ch === '”' || ch === '」'))) {
                inString = false;
                out += '"';
                continue;
            }
            // 字符串内部：只转义，绝不改标点
            if (ch === '"') out += '\\"';
            else if (ch === '\\') out += '\\\\';
            else out += ch;
            continue;
        }

        // 结构位置：开启一个字符串
        if (ch === '"' || ch === '“' || ch === '「') {
            inString = true;
            quoteChar = ch === '“' ? '”' : ch === '「' ? '」' : '"';
            out += '"';
            continue;
        }

        // 结构位置的全角标点 → 半角
        const fullToHalf = FULLWIDTH_STRUCTURE[ch];
        out += fullToHalf ?? ch;
    }

    return out;
}

/** 结构位置上的全角标点映射。字符串内部不使用这张表。 */
const FULLWIDTH_STRUCTURE = Object.freeze({
    '：': ':',
    '，': ',',
    '｛': '{',
    '｝': '}',
    '［': '[',
    '］': ']',
    '　': ' ',
});

/**
 * 尽量把一段「不太标准的 JSON」救回来。
 * @param {string} raw
 * @returns {any|null}
 */
function lenientParse(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;

    // ① 直接 parse
    try {
        return JSON.parse(s);
    } catch {
        /* 继续救 */
    }

    // ② 结构位置的全角标点 + 中文引号定界符 → 标准化（字符串内部不动）
    const swapped = repairStructuralPunctuation(s)
        // ③ 尾随逗号
        .replace(/,\s*([}\]])/g, '$1');
    try {
        return JSON.parse(swapped);
    } catch {
        /* 继续救 */
    }

    // ④ 单引号键名/字符串 → 双引号。只在「单引号成对且内部没有双引号」时替换。
    const singleQuoted = swapped.replace(/'([^'"]*)'/g, '"$1"');
    try {
        return JSON.parse(singleQuoted);
    } catch {
        /* 放弃 */
    }

    return null;
}

/** 按字符上限截断，尽量在标点处收尾（读起来不像被腰斩）。 */
export function smartTrim(text, maxChars) {
    const s = String(text ?? '').trim();
    const limit = Number(maxChars);
    if (!Number.isFinite(limit) || limit <= 0 || s.length <= limit) return s;

    const slice = s.slice(0, limit);
    // 在 limit 的 60%~100% 之间找最后一个句读，在那里断开更自然
    const floor = Math.floor(limit * 0.6);
    for (let i = slice.length - 1; i >= floor; i--) {
        if ('。！？…；，、,.!?;'.includes(slice[i])) {
            const cut = slice.slice(0, i + 1);
            // 如果切开后太短（丢了一半以上），不如硬截
            return cut.length >= floor ? cut : slice;
        }
    }
    return slice;
}

/**
 * 解析辅助 API 的输出。
 *
 * @param {string} text
 * @param {any} settings
 * @returns {{ok: boolean, result: {guidance: string, commentary: string, emotion: string, hooks_used: string[]}, error?: string, salvage?: string}}
 */
export function parseGuideResult(text, settings) {
    const guidanceMax = Number(settings?.guidance?.maxChars) || 60;
    const commentaryMax = Number(settings?.commentary?.maxChars) || 40;

    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, result: emptyResult(), error: '模型返回空内容' };

    // ── 先判断「这次输出是不是被 token 上限截断了」────────────────────
    //
    // 用户实测看到气泡里只有半句话（`哼，光顾着发呆，旁边`），而且正文末尾没有引导。
    // 那不是提示词写坏了 —— 是模型输出到一半被 maxTokens 掐断：半截 JSON 解析不出来，
    // 于是走了「救不回来就把纯文本当引导」那条兜底，把残句直接贴到了界面上。
    //
    // 截断的特征很好认：**大括号没闭合**（或结尾是未转义的引号）。所以这里在解析
    // 之前先认出来，返回一个**可操作**的错误（去调大 maxTokens），
    // 而不是把半句话当内容用 —— 宁可这一轮不出声，也不要显示残句。
    if (looksTruncated(raw)) {
        return {
            ok: false,
            result: emptyResult(),
            error:
                '输出被 token 上限截断了（JSON 没有闭合）—— 到设置里把「最多输出 token」调大（建议 800~1500），' +
                '或把「引导字数」「吐槽字数」调小',
            truncated: true,
        };
    }

    // 剥掉 ```json ... ``` 围栏
    const deFenced = raw
        .replace(/^\s*```[a-zA-Z]*\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();

    // 先把「中文引号当定界符」的畸形输出归一化，**再**切平衡对象。
    // 顺序反过来的话对象边界会被切错（见 normalizeCjkQuotes 的说明）。
    const normalized = normalizeCjkQuotes(deFenced);

    const jsonText = extractBalancedJson(normalized) || extractBalancedJson(deFenced) || extractBalancedJson(raw);
    let parsed = jsonText ? lenientParse(jsonText) : null;

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const result = {
            guidance: smartTrim(pickField(parsed, ['guidance', 'guide', 'hint', '引导', '暗示']), guidanceMax),
            commentary: smartTrim(
                pickField(parsed, ['commentary', 'comment', 'quip', 'remark', '吐槽', '评论']),
                commentaryMax,
            ),
            emotion: normalizeEmotion(pickField(parsed, ['emotion', 'mood', 'feeling', '情绪', '表情'])),
            hooks_used: pickArray(parsed, ['hooks_used', 'hooks', 'used', '用到的线索']),
        };

        if (!result.guidance && !result.commentary) {
            return { ok: false, result, error: 'JSON 解析成功但 guidance 与 commentary 都是空的' };
        }
        return { ok: true, result, sourceAssessment: Array.isArray(parsed.sourceAssessment) ? parsed.sourceAssessment : [] };
    }

    // 救不回来：把纯文本当引导用 —— 但只在长度合理时。
    // 太长的多半是模型在复述世界书或写了一大段旁白，硬塞进气泡会很难看。
    const fallback = deFenced.replace(/\s+/g, ' ').trim();
    const looksLikeChatter = fallback.length > 0 && fallback.length <= guidanceMax * 3;
    const result = {
        guidance: looksLikeChatter ? smartTrim(fallback, guidanceMax) : '',
        commentary: '',
        emotion: 'calm',
        hooks_used: [],
    };
    if (!result.guidance) {
        return { ok: false, result, error: '模型没有返回可解析的 JSON，纯文本也不适合当引导' };
    }
    return { ok: true, result, salvage: '模型没按 JSON 输出，已把纯文本兜底当作引导' };
}

/** 空结果。 */
function emptyResult() {
    return { guidance: '', commentary: '', emotion: 'calm', hooks_used: [] };
}

/** 从对象里按候选键名取第一个非空字符串（兼容模型换字段名）。 */
function pickField(obj, keys) {
    for (const key of keys) {
        const value = obj?.[key];
        const text = toText(value);
        if (text) return text;
    }
    return '';
}

/** 从对象里按候选键名取字符串数组。 */
function pickArray(obj, keys) {
    for (const key of keys) {
        const value = obj?.[key];
        if (Array.isArray(value)) return value.map((v) => toText(v)).filter(Boolean).slice(0, 12);
        const single = toText(value);
        if (single) return [single];
    }
    return [];
}

/** 把情绪名归一化到合法枚举。 */
export function normalizeEmotion(value) {
    const s = toText(value).toLowerCase();
    if (!s) return 'calm';
    if (EMOTIONS.includes(s)) return s;

    // 模型有时会用中文或近义词
    const alias = {
        平静: 'calm',
        冷静: 'calm',
        得意: 'smug',
        傲娇: 'smug',
        不屑: 'smug',
        生气: 'annoyed',
        恼火: 'annoyed',
        烦躁: 'annoyed',
        担心: 'worried',
        忧虑: 'worried',
        紧张: 'worried',
        微笑: 'smile',
        开心: 'smile',
        高兴: 'smile',
        思考: 'thinking',
        沉思: 'thinking',
        疑惑: 'thinking',
        happy: 'smile',
        angry: 'annoyed',
        sad: 'worried',
        neutral: 'calm',
    };
    return alias[s] ?? 'calm';
}

/** 引导一次请求的完整结果。 */
export function emptyGuideOutcome() {
    return {
        ok: false,
        result: emptyResult(),
        hooks: [],
        books: [],
        scanned: 0,
        sourceAssessment: [],
        retrievedSources: 0,
        error: '',
        notes: /** @type {string[]} */ ([]),
        duplicate: false,
        duplicateScore: 0,
        aborted: false,
        meta: /** @type {any} */ ({}),
    };
}

/**
 * 「定位」那一步的系统提示词 —— 两段式里的第一段。
 *
 * ── 它解决的是什么问题
 *
 * 通读（编索引）那一步是在**完全不知道剧情演到哪**的情况下给每条写描述的。
 * 「这条现在用不用得上」它答不了 —— 那取决于你在第几章。
 *
 * 这一步才是回答那个问题的地方：它手里有**刚写完的正文**，有上下文。
 * 先判断现在演到哪，再从索引里把该看的几条调出来。
 *
 * 索引只是检索目录，允许不选。候选适用性必须在读原文后核查。
 *
 * @param {number} maxPick 最多挑几条
 * @returns {string}
 */
export function buildLocateSystemPrompt(maxPick) {
    return `你是一位熟悉这部作品的读者。你要做两件事：**判断故事现在演到哪了**，
然后**检索值得取回原文核查的候选条目**，不是认定下一步剧情。
索引是轻量检索目录，不是正史证据；摘要、阶段标签与检索理由不得当作事实或触发条件已满足的证明。
先用中立事实、正文和上文核对已发生事件、人物是否已经登场；未知不等于未发生，不得从缺失记录推断结论。
不迎合任何角色立场。最终适用性必须在取回原文后逐项核查；你只负责定位候选。

━━━ 为什么需要你 ━━━

有个角色（贝翠丝）马上要说一句**暗示性的话**，把剧情往某个方向轻轻推一下。
她手上有一份世界书索引（可能有几百条），全读一遍没必要。
你先定位、再把该看的几条原文调出来，她照着写。

━━━ 第一步：判断现在演到哪 ━━━

读刚写完的正文 —— 但**不要只看这一段**，把上文一起读。
主角现在在什么地方？见过谁了？哪些事已经发生了、哪些还没有？

给出一句话的阶段判断，例如「刚到王都，还没跟任何人打过交道」。
可以借用索引里的阶段名，也可以自己归纳。

━━━ 第二步：挑出这个阶段用得上的条目 ━━━

判断标准只有一条：

  **如果让她照着这条说一句话，能不能让玩家产生
    「那我是不是该去某处看看」的念头？**

优先找这几类（从强到弱）：

1. **未兑现的事**：约定、期限、欠下的人情、谁在等谁
2. **反常的细节**：某人说不通的举动、多出来的东西、不对劲的地方
3. **可去的地方**：有具体名字，而且那里「有事可做」
4. **未点破的秘密**：谁在回避什么话题、藏了什么、身份上的疑点
5. **征兆**：天气异常、多出来的钟声、街上的人都在往同一个方向走

━━━ 第三步：挑几条 ━━━

最多 ${maxPick} 条。宁少勿滥 —— 挑 1~2 条真正贴合的，比挑 4 条勉强的强。

没有值得核查的候选时允许 pick: []，并明确说明缺少什么条件或证据。
不得为了有引导而强行挑选；候选看似接近也不代表它适用于当前剧情。

━━━ 不要挑 ━━━

- 上文里已经兑现过的（再说一遍就是马后炮）
- 直接点破谜底 / 结局的
- 和当前场景完全无关的（主角在内陆，你挑一条海岛设定）
- 纯粹的世界观底色（「这个世界有魔法」这种，说了等于没说）

━━━ 输出格式 ━━━

只输出 JSON，不要 markdown 围栏，不要解释文字。

{"phase":"当前剧情阶段（一句话）","pick":[3,17],"why":"为什么这几条贴合现在"}`;
}

/**
 * 「定位」那一步的用户消息。
 *
 * 索引只给 `编号. 分类标题（阶段）摘要` —— **不含正文**。
 * 这正是两段式省 token 的地方：通读一次把几十万字压成几百行，
 * 之后每轮只需要过一遍这几百行，而不是重发全书。
 *
 * @param {{finishedText?: string, historyText?: string}} data
 * @param {string} indexText
 * @returns {string}
 */
export function buildLocateUserPrompt(data, indexText) {
    const finished = String(data?.finishedText ?? '').trim();
    const history = String(data?.historyText ?? '').trim();
    const parts = [];
    parts.push('【刚刚写完的正文 —— 故事现在演到这里】');
    parts.push(finished || '（这一轮没有正文）');
    if (history) {
        parts.push('');
        parts.push('【在这段正文之前发生了什么】');
        parts.push(history);
    }
    parts.push('');
    parts.push('【中立事实记录 —— 未记载的条件仍属未知】');
    parts.push(String(data?.factsText ?? '').trim() || '（暂无中立事实记录；不得推断缺失条件已满足）');
    parts.push('');
    parts.push('【世界书索引 —— 仅用于检索，不是正史证据】');
    parts.push(indexText || '（索引是空的）');
    parts.push('');
    parts.push('请判断现在演到哪，然后挑出这个阶段用得上的条目（只回 JSON）。');
    return parts.join('\n');
}

/**
 * 解析「定位」那一步的返回。
 *
 * **越界编号一律丢掉**：宁可少给一条原文，也不能把别的条目的正文当成依据 ——
 * 那会让她说出一句和当前剧情毫无关系的话，用户完全没法排查。
 *
 * @param {string} text
 * @param {number} total
 * @returns {{phase: string, picks: number[], why: string}}
 */
export function parseLocateResult(text, total) {
    const max = Number(total) || 0;
    const raw = String(text ?? '');
    if (!raw.trim()) return { phase: '', picks: [], why: '' };

    /** @type {any} */
    let obj = null;
    try {
        obj = lenientParse(raw);
    } catch {
        obj = null;
    }
    if (obj === null || obj === undefined) return { phase: '', picks: [], why: '' };

    // 模型偶尔只回一个裸数组 `[3,17]`
    const isArr = Array.isArray(obj);
    const list = isArr ? obj : (obj.pick ?? obj.picks ?? obj.index ?? obj.indices ?? obj.selected ?? []);
    const phase = isArr ? '' : String(obj.phase ?? obj.stage ?? '').trim().slice(0, 120);
    const why = isArr ? '' : String(obj.why ?? obj.reason ?? obj.note ?? '').trim().slice(0, 200);

    const seen = new Set();
    const picks = [];
    for (const item of Array.isArray(list) ? list : []) {
        const n = typeof item === 'object' && item !== null ? (item.index ?? item.no ?? item.id) : item;
        const idx = Number(n);
        if (!Number.isInteger(idx) || idx < 1 || (max > 0 && idx > max)) continue;
        if (seen.has(idx)) continue;
        seen.add(idx);
        picks.push(idx);
    }
    picks.sort((a, b) => a - b);
    return { phase, picks, why };
}

/**
 * 跑「定位」那一步：判断剧情演到哪，并挑出该看原文的条目。
 *
 * 失败不致命，但不能把索引当素材：没有可用原文时只回应当前处境。
 *
 * @param {any} ctx
 * @param {any} settings
 * @param {{hooks: any[], finishedText?: string, historyText?: string, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, phase: string, picked: any[], picks: number[], why: string, error: string, meta: any, chars: number}>}
 */
export async function locateHooks(ctx, settings, opts = {}) {
    const hooks = Array.isArray(opts.hooks) ? opts.hooks.filter(h => !isRuleBook(h.book)) : [];
    const out = {
        ok: false,
        phase: '',
        picked: /** @type {any[]} */ ([]),
        picks: /** @type {number[]} */ ([]),
        why: '',
        error: '',
        meta: /** @type {any} */ ({}),
        chars: 0,
    };
    if (!hooks.length) {
        out.error = '索引是空的';
        return out;
    }

    const index = formatIndexForLocate(hooks, {
        // Locate must see the entire relevant pool, not an arbitrary prefix.
        maxChars: Number.MAX_SAFE_INTEGER,
        briefChars: 200,
    });
    out.chars = index.chars;

    const maxPick = Math.max(1, Number(settings?.guidance?.locateMaxPick) || 4);
    const config = resolveStageLlm(settings, 'locate');
    const client = new LlmClient(ctx, config, '剧情定位');
    const response = await client.complete({
        system: `${buildLocateSystemPrompt(maxPick)}\n\n【中立事实记录】\n${opts.factsText || formatFactsForPrompt(ctx)}`,
        user: buildLocateUserPrompt({ ...opts, factsText: opts.factsText || formatFactsForPrompt(ctx) }, index.text),
        // 定位是检索任务，不是创作任务 —— 温度压低，免得它「发挥」
        temperature: 0.2,
        // JSON 定位未用 schema，但同样需要为推理和完整答案预留预算。
        maxTokens: Math.max(Number(config.maxTokens) || 400, Number(config.structuredMaxTokens) || 0),
        signal: opts.signal,
    });
    out.meta = response.meta ?? {};
    if (!response.ok) {
        out.error = response.error || '定位请求失败';
        return out;
    }

    const parsed = parseLocateResult(response.text, index.used.length);
    out.phase = parsed.phase;
    out.why = parsed.why;
    out.picks = parsed.picks.slice(0, maxPick);
    // 用**索引里那一份**去取，编号才对得上
    out.picked = out.picks.map((i) => index.used[i - 1]).filter(Boolean);
    out.ok = out.picked.length > 0;
    if (!out.ok) out.error = '它没有挑出任何条目';
    return out;
}

/**
 * 判断这一次要不要跑定位。
 *
 * `auto`（默认）只在索引**够大**时才跑：索引只有几条的时候，
 * 把全部素材直接发过去比多一次往返又便宜又准 —— 定位这一步没有意义。
 *
 * @param {any} settings
 * @param {number} hookCount
 * @returns {boolean}
 */
export function shouldLocate(settings, hookCount) {
    // Every guidance must first ground itself in current story progress.
    // Retired auto/off settings no longer bypass progress location.
    return hookCount > 0;
}

/** Normalize diagnostic claims only against sources actually retrieved, never pool summaries.
 * Applicability is a model judgement, not a programmatic proof of semantic dependencies.
 */
export function normalizeSourceAssessment(value, sources = [], supportingTexts = []) {
    const rows = Array.isArray(value) ? value : [];
    return sources.filter((s) => s.book).map((source) => {
        const matching = rows.filter((r) => r && typeof r === 'object'
            && r.book === source.book && String(r.uid) === String(source.uid));
        const row = matching.length === 1 ? matching[0] : null;
        const strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
        const conditions = strings(row?.conditions);
        const evidence = strings(row?.evidence);
        let status = ['applicable', 'unknown', 'excluded'].includes(row?.status) ? row.status : 'unknown';
        // Exact quotes establish provenance only; semantic applicability remains a
        // conservative model judgement. Missing/conflicting conditions veto approval.
        const original = String(source.content ?? '');
        const support = supportingTexts.filter((s) => typeof s === 'string' && s.trim());
        const sourceQuote = evidence.some((q) => q.length >= 4 && original.includes(q));
        const factQuote = evidence.some((q) => q.length >= 4 && !original.includes(q)
            && support.some((s) => s.includes(q) && !uncertainContext(s, q)));
        const anchored = evidence.length > 0 && evidence.every((q) => q.length >= 4
            && (original.includes(q) || support.some((s) => s.includes(q) && !uncertainContext(s, q))));
        const unresolved = /unknown|missing|unconfirmed|unsupported|excluded|conflict|not satisfied|not established|未知|缺失|缺少|尚未|未确认|未满足|无证据|没有证据|冲突|不适用|不成立/i;
        if (status === 'applicable' && (!conditions.length || !sourceQuote || !factQuote || !anchored
            || conditions.some((c) => unresolved.test(c) || /^(?:all conditions (?:are )?(?:met|satisfied)|条件(?:均|全部|都)(?:已)?满足)[.!。\s]*$/i.test(c))
            || unresolved.test(String(row?.reason ?? '')))) status = 'unknown';
        return {
            book: source.book, uid: source.uid, status, conditions,
            reason: typeof row?.reason === 'string' && row.reason.trim()
                ? row.reason.trim() : '模型未提供可核查的适用性判断；触发条件仍未知',
            evidence,
        };
    });
}

/** Run a neutral, strict assessment before any canonical text reaches composition. */
export async function assessRetrievedSources(ctx, settings, sources, opts = {}) {
    const canonical = sources.filter((s) => s.book);
    if (!canonical.length) return { sources, sourceAssessment: [], error: '', meta: {} };
    const confirmed = getFactState(ctx).facts.filter((f) => f.status === 'confirmed')
        .flatMap((f) => f.evidence.map((e) => e.quote));
    const prose = (Array.isArray(ctx?.chat) ? ctx.chat : [])
        .filter((m) => m && !m.is_user && !m.is_system && !m.extra?.beatriceGuide?.injected)
        .map((m) => String(m.mes ?? ''));
    if (opts.finishedText) prose.push(String(opts.finishedText));
    const supportingTexts = [...confirmed, ...prose];
    const fail = (error, meta = {}) => ({ sources: [], sourceAssessment: normalizeSourceAssessment([], canonical), error, meta });
    if (opts.signal?.aborted) return fail('已被用户中止');
    let response;
    try {
        response = await new LlmClient(ctx, resolveStageLlm(settings, 'assess'), '原文适用性核查').complete({
            system: buildSourceAssessmentPrompt(),
            user: JSON.stringify({ sources: canonical.map((s) => ({ book: s.book, uid: s.uid, content: s.content })),
                confirmedEvidence: confirmed, completedAiProse: prose, factsText: formatFactsForPrompt(ctx) }),
            jsonSchema: { name: 'source_applicability', strict: true, value: { type: 'object', additionalProperties: false,
                required: ['sourceAssessment'], properties: { sourceAssessment: buildOutputSchema(settings).value.properties.sourceAssessment } } },
            // 客户端沿用阶段预设的 maxTokens/structuredMaxTokens，不用固定值覆盖。
            temperature: 0.1, signal: opts.signal,
        });
    } catch (e) { return fail(describeError(e)); }
    if (!response.ok || opts.signal?.aborted) return fail(response.error || '适用性核查失败', response.meta ?? {});
    let parsed;
    try { parsed = JSON.parse(response.text); } catch { return fail('适用性核查必须返回完整严格 JSON', response.meta ?? {}); }
    const sourceAssessment = normalizeSourceAssessment(parsed?.sourceAssessment, canonical, supportingTexts);
    const approved = sources.filter((s) => !s.book || sourceAssessment.some((r) => r.book === s.book
        && String(r.uid) === String(s.uid) && r.status === 'applicable'));
    // With retrieved canon but no approved canon, suppress the entire round rather
    // than letting commentary or a user note launder rejected canonical details.
    const anyCanon = sourceAssessment.some((r) => r.status === 'applicable');
    return { sources: anyCanon ? approved : [], sourceAssessment, meta: response.meta ?? {},
        error: anyCanon ? '' : '原文触发条件未知、冲突或证据不支持；本轮引导与吐槽已关闭，可补足事实后重试' };
}

/** Shared retrieval for other composition paths. No observations or facts mutations here. */
export async function retrieveVerifiedSources(ctx, settings, opts = {}) {
    const hooks = Array.isArray(opts.hooks) ? opts.hooks.filter(h => !isRuleBook(h.book)) : [];
    const out = { sources: [], located: null, sourceAssessment: [], retrievedSources: 0, error: '' };
    if (!hooks.length) return out;
    try {
        const located = await locateHooks(ctx, settings, { ...opts, hooks, factsText: formatFactsForPrompt(ctx) });
        out.located = located;
        if (!located.ok) { out.error = located.error; return out; }
        const candidates = located.picked.map((h) => h.book
            ? { ...h, content: '', brief: '' } : { ...h, brief: '', sourceType: 'user-note' });
        const hydrated = await resolveHookContents(ctx, candidates, { maxChars: Number.MAX_SAFE_INTEGER, signal: opts.signal });
        const originals = hydrated.filter((h) => String(h.content ?? '').trim())
            .map((h) => ({ ...h, brief: '', sourceType: h.book ? 'worldbook-original' : 'user-note' }));
        out.retrievedSources = originals.length;
        const assessed = await assessRetrievedSources(ctx, settings, originals, opts);
        out.sources = assessed.sources;
        out.sourceAssessment = assessed.sourceAssessment;
        out.error = assessed.error;
    } catch (e) { out.error = describeError(e); }
    return out;
}

/**
 * 跑一次引导生成。
 *
 * @param {any} ctx
 * @param {any} settings
 * @param {{ signal?: AbortSignal, recentSpoken?: string[], force?: boolean }} [opts]
 * @returns {Promise<any>} 见 emptyGuideOutcome 的形状
 */
export async function runGuide(ctx, settings, opts = {}) {
    const outcome = emptyGuideOutcome();

    if (!settings?.enabled) {
        outcome.error = '插件总开关已关闭';
        return outcome;
    }
    if (!settings?.guidance?.enabled && !settings?.commentary?.enabled) {
        outcome.error = '引导与吐槽都已关闭';
        return outcome;
    }

    const signal = opts.signal;
    if (signal?.aborted) {
        outcome.error = '已被用户中止';
        outcome.aborted = true;
        return outcome;
    }

    // ① 取线索
    //
    // ⚠️ 这里**不再读世界书**。线索池由 `app.buildHookPool()` 提前筛好并缓存 ——
    // 那一步要通读整本世界书（可能几十万字）让 AI 判断哪些是剧情条目，
    // 每 2 轮做一次既慢又贵。而「哪些条目是剧情条目」变化很慢（只有作者改书才会变），
    // 所以筛一次、缓存进 chatMetadata，这里只取现成的。
    //
    // 池子为空时不在这里补筛：引导是「抢先式」的（要在正文生成期间并发跑完），
    // 塞一次通读进去会把延迟从几秒拉到几十秒。改由 app 在生成开始前就准备好。
    const poolHooks = Array.isArray(opts.hooks) ? opts.hooks.filter(h => !isRuleBook(h.book)) : [];
    outcome.hooks = poolHooks;
    outcome.books = Array.isArray(opts.books) ? opts.books : [];
    outcome.scanned = 0;
    if (!poolHooks.length) {
        outcome.notes.push('这次没有可用线索（线索池为空或还没建立）');
    }

    // ①.5 定位（两段式里的第一段）
    //
    // 池子现在是**索引**（几百条，每条一句话摘要），不是「已经挑好的几条」。
    // 「哪几条跟现在这轮剧情对得上」必须带着正文来判断 —— 那正是这一步做的。
    //
    // 定位/读取失败必须关闭来源通道；摘要不是正史，不能作为创作兜底。
    let usedHooks = [];
    const factsText = formatFactsForPrompt(ctx);
    let locatedPhase = '';
    if (poolHooks.length) {
        try {
            const loc = await locateHooks(ctx, settings, {
                hooks: poolHooks,
                finishedText: opts.finishedText,
                historyText: opts.historyText,
                factsText,
                signal,
            });
            if (loc.meta?.notice) outcome.notes.push(loc.meta.notice);
            outcome.located = {
                phase: loc.phase,
                picks: loc.picks,
                why: loc.why,
                ok: loc.ok,
                // 编号是给模型用的，用户要看的是**名字** ——
                // 「挑了第 3、7 条」没法判断对错，「挑了《王都下水道》」才行。
                labels: loc.picked.map((/** @type {any} */ h) => h.label).filter(Boolean),
                total: poolHooks.length,
            };
            if (loc.ok) {
                locatedPhase = loc.phase;
                // 取回**原文**：索引里不存正文（几百条太重，而且会过期），
                // 到这一步才按需从世界书现取 —— 顺带能拿到作者的更新。
                try {
                    // The legacy resolver falls back to cached content on read failure.
                    // Clear all origin-backed caches first: only a fresh original is canon.
                    // Manual entries without book origins remain explicit user notes, not canon.
                    const candidates = loc.picked.map((h) => h.book
                        ? { ...h, content: '', brief: '' }
                        : { ...h, brief: '', sourceType: 'user-note' });
                    const hydrated = await resolveHookContents(ctx, candidates, {
                        maxChars: Number.MAX_SAFE_INTEGER,
                        signal,
                    });
                    usedHooks = hydrated.filter((h) => String(h.content ?? '').trim())
                        .map((h) => ({ ...h, brief: '', sourceType: h.book ? 'worldbook-original' : 'user-note' }));
                    if (usedHooks.length < loc.picked.length) {
                        outcome.notes.push('部分原文不可读取，已排除；不使用摘要或存量内容补充正史');
                    }
                } catch (e) {
                    usedHooks = [];
                    outcome.notes.push(`取回条目正文失败（${describeError(e)}），无可用原文；仅回应当前处境`);
                }
                outcome.notes.push(
                    `定位到「${loc.phase || '当前阶段'}」，取得 ${usedHooks.length} 条可用来源（含明确标注的用户笔记）`,
                );
            } else {
                outcome.notes.push(`定位没成功（${loc.error}）—— 不使用索引摘要创作剧情，仅回应当前处境`);
            }
        } catch (e) {
            outcome.notes.push(`定位出错（${describeError(e)}）—— 不使用索引摘要创作剧情，仅回应当前处境`);
        }
    }

    outcome.hooks = usedHooks;
    outcome.retrievedSources = usedHooks.length;
    const assessed = await assessRetrievedSources(ctx, settings, usedHooks, opts);
    outcome.sourceAssessment = assessed.sourceAssessment;
    if (assessed.error) {
        outcome.error = assessed.error;
        outcome.notes.push(assessed.error);
        outcome.recoverable = true;
        outcome.aborted = Boolean(signal?.aborted);
        return outcome;
    }
    if (assessed.sourceAssessment.some((r) => r.status !== 'applicable')) {
        outcome.notes.push('未知或排除来源已从创作提示词中移除；仅使用通过核查的原文');
        // A locator phase could incorporate rejected source details. Do not relay it.
        locatedPhase = '';
    }
    usedHooks = assessed.sources;

    // Composition receives selected full originals only, with explicit origin labels.
    // Manual no-book entries are user notes and cannot establish canonical facts.
    const promptHooks = usedHooks.map((h) => ({
        ...h,
        content: h.book
            ? `【世界书原文 book=${JSON.stringify(h.book)} uid=${JSON.stringify(h.uid)}】\n${h.content}`
            : `【用户手写笔记：非正史，不得作为世界书事实】\n${h.content}`,
    }));

    // ② 组装上下文
    const ctxData = buildGuideContext(ctx, settings, {
        hooksText: formatHooksForPrompt(promptHooks),
        hooks: promptHooks,
        recentSpoken: opts.recentSpoken,
        // 调用时机是「正文生成完毕」，所以要把**刚写完的正文全文**交给模型。
        // 不传它，模型就看不到正文，写出来的引导必然接不上 —— 这正是
        // 用户反馈「正文没有插入引导」的根因。
        finishedText: opts.finishedText,
        locatedPhase,
    });
    ctxData.factsText = factsText;
    outcome.turnIndex = ctxData.turnIndex;
    outcome.hooks = usedHooks;

    // ③ 调辅助 API
    //
    // ⚠️ **一次调用同时拿到引导与吐槽**（`guidance` + `commentary` 两个字段）。
    // 这是刻意的：两件事共享同一份「当前局势」理解（同样的世界书线索、
    // 同样的最近对话），拆成两次请求等于把同样的上下文发两遍、付两次钱，
    // 而且两次判断还可能互相矛盾（比如一次觉得该往东、一次吐槽他往东）。
    const client = new LlmClient(ctx, resolveStageLlm(settings, 'compose'), '剧情引导');
    const response = await client.complete({
        messages: buildPersonaMessages(settings, `${buildUserPrompt(ctxData, settings)}${settings.realm === 'void' ? '' : getMemoryPrompt(ctx)}\n\n【预核查已完成】本次提供的世界书原文已通过独立中立核查；未通过者完全不可用。sourceAssessment 返回 []，不要重复核查长文或创造新的证据。若发现明确冲突，可报告 unknown/excluded，程序将关闭本轮台词。`, factsText),
        jsonSchema: buildOutputSchema(settings),
        maxTokens: settings.llm?.maxTokens,
        temperature: settings.llm?.temperature,
        signal,
    });
    outcome.meta = response.meta ?? {};
    if (response.meta?.notice) outcome.notes.push(response.meta.notice);

    if (!response.ok) {
        outcome.error = response.error || '辅助 API 请求失败';
        outcome.aborted = Boolean(response.aborted);
        return outcome;
    }

    // ④ 解析
    const parsed = parseGuideResult(response.text, settings);
    outcome.result = parsed.result;
    // Composition cannot overwrite the earlier neutral approval/diagnostics.
    const compositionClaims = normalizeSourceAssessment(parsed.sourceAssessment, usedHooks);
    if (compositionClaims.some((r) => r.status === 'excluded'
        || (r.status === 'unknown' && parsed.sourceAssessment?.some((p) => p.book === r.book
            && String(p.uid) === String(r.uid) && p.status === 'unknown')))) {
        outcome.result = emptyResult();
        outcome.error = '创作阶段报告来源条件未知或冲突；已关闭引导与吐槽';
        outcome.notes.push(outcome.error);
        outcome.recoverable = true;
        return outcome;
    }
    if (parsed.salvage) outcome.notes.push(parsed.salvage);
    if (!parsed.ok) {
        outcome.error = parsed.error || '解析失败';
        return outcome;
    }

    // ⑤ 去重：如果这次说的话和之前高度重合，标记出来让上层决定要不要换话题重试。
    //    注意这里**不直接丢弃** —— 只有 guidance 和 commentary 都重复才算废。
    const spoken = Array.isArray(opts.recentSpoken) ? opts.recentSpoken : [];
    const dupG = parsed.result.guidance ? findDuplicate(parsed.result.guidance, spoken) : null;
    const dupC = parsed.result.commentary ? findDuplicate(parsed.result.commentary, spoken) : null;
    const gDup = Boolean(dupG?.duplicate);
    const cDup = Boolean(dupC?.duplicate);
    outcome.duplicateScore = Math.max(dupG?.score ?? 0, dupC?.score ?? 0);

    if (gDup && (!parsed.result.commentary || cDup)) {
        outcome.duplicate = true;
        outcome.notes.push(`这次的引导与之前说过的内容重复度 ${(outcome.duplicateScore * 100).toFixed(0)}%，已丢弃`);
        return outcome;
    }
    if (gDup && parsed.result.commentary && !cDup) {
        // 引导重复但吐槽是新的 —— 保留吐槽，掐掉重复的引导
        outcome.notes.push('这次的引导与之前重复，已只保留吐槽');
        parsed.result.guidance = '';
    }

    outcome.ok = Boolean(parsed.result.guidance || parsed.result.commentary);
    if (!outcome.ok) outcome.error = '模型返回的内容被去重或截断后为空';
    return outcome;
}


/**
 * 判断模型的输出是不是**被 token 上限掐断**了。
 *
 * ── 为什么需要这个
 *
 * 用户实测在气泡里看到半句话（`哼，光顾着发呆，旁边`），同时正文末尾没有引导。
 * 复盘发现是同一次输出的两半：JSON 写到一半被 `maxTokens` 截断 →
 * 解析失败 → 走了「救不回来就把纯文本当引导」的兜底 → 把残句贴了出来。
 *
 * 所以「解析失败」有两种完全不同的情况，必须分开：
 *
 *   模型写坏了格式  → 可以尝试抢救（已有 lenientParse 那一套）
 *   **输出被截断**  → 抢救没有意义（内容本身就不完整），应当直接报错，
 *                     并告诉用户去调大 token 上限
 *
 * 判据（宽松但够用）：
 *   · 有 `{` 但没有配平的 `}`
 *   · 或者引号数量是奇数（字符串没闭合）
 *   · 或者结尾停在半个转义序列上（`\`）
 *
 * 刻意不追求严格 —— 这里只用来**区分错误类型**，误判的代价只是提示信息不够准，
 * 而漏判的代价是把半句话显示给用户。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksTruncated(text) {
    const s = String(text ?? '').trim();
    if (!s) return false;

    // 结尾停在半个转义符上
    if (/\\$/.test(s)) return true;

    // 数一数花括号与方括号是否配平（忽略字符串里的，用最简单的状态机）
    let depth = 0;
    let bracket = 0;
    let inString = false;
    let quoteCount = 0;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\') {
            i++; // 跳过被转义的下一个字符
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            quoteCount++;
            if (inString) continue;
            continue;
        }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '[') bracket++;
        else if (ch === ']') bracket--;
    }

    // 括号没配平 → 一定被截断了
    if (depth !== 0 || bracket !== 0) return true;
    // 字符串没闭合
    if (inString || quoteCount % 2 !== 0) return true;
    // 压根没出现对象（模型只吐了半句自然语言）——不算截断，交给别的分支处理
    return false;
}
