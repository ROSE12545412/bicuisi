/**
 * 两段式（通读编索引 → 引导时先定位再取材）的测试。
 *
 * ── 为什么改成了两段式
 *
 * 用户一句话戳中了旧设计的要害（原话）：
 *   「那你就不能让读表 ai 读一下正文判断目前是第几章
 *     然后寻找对应章节的对应剧情给出提示吗」
 *
 * 旧设计让通读**直接挑出**「能用来推进剧情」的条目，上限约 15%。
 * 但它挑的时候**完全不知道剧情演到哪** —— 而「这条有没有用」恰恰取决于
 * 你在第几章。没被挑中的条目之后每一轮都看不到，**哪怕它正是这轮最该用的**。
 * 这个损失不可逆，是那套设计里唯一的硬伤。
 *
 * 现在：通读只编索引（基本不淘汰），定位带着正文去检索。
 *
 * 这里钉住四件事：
 *  1. 编索引的提示词 —— 不许判断「现在有没有用」、每条都要写
 *  2. 定位的提示词 —— 必须有上下文判断、条件不足时允许零选
 *  3. 两个解析器 —— 越界编号一律丢掉
 *  4. 正文按需取回 —— 池子里不存正文，用时现取；取不到要能退回
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import { buildIndexSystemPrompt, parseIndexResult } from '../src/app.js';
import {
    buildLocateSystemPrompt,
    buildLocateUserPrompt,
    parseLocateResult,
    shouldLocate,
} from '../src/llm/guide.js';
import { formatIndexForLocate, resolveHookContents } from '../src/worldbook.js';
import { defaultSettings } from '../src/config.js';
import { LOCATE_MODES } from '../src/config.js';

// ---------------------------------------------------------------------------
// 编索引的提示词
// ---------------------------------------------------------------------------

describe('buildIndexSystemPrompt —— 编索引的提示词', () => {
    const p = buildIndexSystemPrompt(400, 0);

    test('明确说了不许判断「现在有没有用」', () => {
        // 这是整个改动的理由所在：模型不知道剧情演到哪，问了也答不准，
        // 而且它会因此丢掉后面才用得上的条目。
        assert.ok(/不要判断/.test(p) && /现在有没有用/.test(p), '必须写明不许判断当下是否有用');
    });

    test('要求每条都写一行（漏掉 = 永久丢失）', () => {
        assert.ok(/每一条/.test(p), '要强调每一条');
        assert.ok(/漏掉/.test(p), '要说清漏掉的后果');
    });

    test('phase 那一栏要求「宁宽勿窄」', () => {
        // 写窄了检索会漏掉它 —— 那是这份索引最严重的错误。
        assert.ok(/宁可写得宽/.test(p), '必须明确宁可写宽');
        assert.ok(/任何阶段/.test(p), '要给一个宽松的兜底写法');
    });

    test('只允许三类不写，且明确说了「标题像设定不要跳过」', () => {
        assert.ok(/纯数值/.test(p), '数值表要排除');
        assert.ok(/剧透/.test(p), '剧透要排除');
        // 判据是正文不是标题 —— 实测里钩子经常藏在「设定补充」这种标题下
        assert.ok(/不要跳过/.test(p), '要阻止它按标题过滤');
        assert.ok(/判据是正文/.test(p), '要写明判据是正文');
    });

    test('输出格式给了 index/brief/phase 三个字段', () => {
        assert.ok(p.includes('"index"') && p.includes('"brief"') && p.includes('"phase"'));
    });

    test('截断时告诉模型「这不是全部」', () => {
        const truncated = buildIndexSystemPrompt(50, 300);
        assert.ok(truncated.includes('300'), '要把没列出来的条数告诉它');
        assert.ok(!buildIndexSystemPrompt(50, 0).includes('不是全部'));
    });
});

describe('parseIndexResult —— 解析索引', () => {
    test('正常一批', () => {
        const r = parseIndexResult('{"index":[{"index":1,"brief":"讲什么","phase":"开局"}]}', 10);
        assert.equal(r.length, 1);
        assert.deepEqual(r[0], { index: 1, brief: '讲什么', phase: '开局' });
    });

    test('带 markdown 围栏也能解析', () => {
        const r = parseIndexResult('好的：\n```json\n{"index":[{"index":2,"brief":"x"}]}\n```\n完毕', 10);
        assert.deepEqual(r.map((x) => x.index), [2]);
    });

    test('⭐ 越界编号必须丢掉', () => {
        // 编号错了就会把摘要贴到别的条目上，用户看到的是「描述和内容对不上」，
        // 而且完全没法排查。
        const r = parseIndexResult('{"index":[{"index":1},{"index":999},{"index":0},{"index":-3}]}', 5);
        assert.deepEqual(r.map((x) => x.index), [1]);
    });

    test('重复编号去重', () => {
        const r = parseIndexResult('{"index":[{"index":2,"brief":"a"},{"index":2,"brief":"b"}]}', 5);
        assert.equal(r.length, 1);
    });

    test('别的字段名也认（items / rows / 裸数组）', () => {
        assert.deepEqual(parseIndexResult('{"items":[{"no":3}]}', 5).map((x) => x.index), [3]);
        assert.deepEqual(parseIndexResult('{"rows":[{"id":4}]}', 5).map((x) => x.index), [4]);
        assert.deepEqual(parseIndexResult('[1,2,3]', 5).map((x) => x.index), [1, 2, 3]);
    });

    test('brief / phase 缺失时给空串而不是 undefined', () => {
        const r = parseIndexResult('{"index":[{"index":1}]}', 5);
        assert.equal(r[0].brief, '');
        assert.equal(r[0].phase, '');
    });

    test('解析不了就返回空数组，不抛异常', () => {
        for (const bad of ['', '完全不是 JSON', null, undefined, '{"index":"不是数组"}']) {
            assert.deepEqual(parseIndexResult(/** @type {any} */ (bad), 5), []);
        }
    });

    test('编号为字符串数字也认', () => {
        assert.deepEqual(parseIndexResult('{"index":[{"index":"3"}]}', 5).map((x) => x.index), [3]);
    });
});

// ---------------------------------------------------------------------------
// 索引清单排版
// ---------------------------------------------------------------------------

describe('formatIndexForLocate —— 索引排成检索清单', () => {
    const hooks = [
        { label: '旧城区的传言', kind: '线索', brief: '有人说夜里有人搬箱子', phase: '开局' },
        { label: '王都下水道', kind: '地点', brief: '', phase: '王都篇' },
    ];

    test('每条一行，编号从 1 开始', () => {
        const r = formatIndexForLocate(hooks);
        const lines = r.text.split('\n');
        assert.equal(lines.length, 2);
        assert.ok(lines[0].startsWith('1. '), '第一行要从 1 开始');
        assert.ok(lines[1].startsWith('2. '));
    });

    test('标题 / 分类 / 阶段 / 摘要都在行里', () => {
        const line = formatIndexForLocate(hooks).text.split('\n')[0];
        assert.ok(line.includes('旧城区的传言'), '要有标题');
        assert.ok(line.includes('线索'), '要有分类');
        assert.ok(line.includes('开局'), '要有阶段');
        assert.ok(line.includes('有人说夜里有人搬箱子'), '要有摘要');
    });

    test('⭐ 没有摘要的条目也照样列出来（用正文开头兜底）', () => {
        // 这是索引模式和「筛选」的分界线：没被 AI 描述到的条目
        // 绝不能从清单里消失 —— 消失 = 检索不到 = 退回筛选。
        const r = formatIndexForLocate([{ label: 'X', content: '这是正文开头，很长很长' }]);
        assert.equal(r.used.length, 1, '不能被丢掉');
        assert.ok(r.text.includes('这是正文开头'), '要用正文开头兜底');
    });

    test('既没摘要又没正文 → 明说「没写摘要」，不留空壳', () => {
        const r = formatIndexForLocate([{ label: 'X' }]);
        assert.ok(r.text.includes('没写摘要') || r.text.includes('没有标题'));
    });

    test('字符上限到了就停，并报告漏掉几条', () => {
        const many = Array.from({ length: 50 }, (_, i) => ({ label: `条目${i}`, brief: 'x'.repeat(40) }));
        const r = formatIndexForLocate(many, { maxChars: 400 });
        assert.ok(r.used.length < 50, '要截断');
        assert.equal(r.omitted, 50 - r.used.length, 'omitted 要对得上');
        // ⚠️ 至少留一条：全截掉会让定位拿到空清单，比截断更糟
        assert.ok(r.used.length >= 1, '不能截成空的');
    });

    test('空输入不崩', () => {
        for (const bad of [null, undefined, '不是数组', []]) {
            const r = formatIndexForLocate(/** @type {any} */ (bad));
            assert.equal(r.text, '');
            assert.equal(r.used.length, 0);
        }
    });
});

// ---------------------------------------------------------------------------
// 定位的提示词
// ---------------------------------------------------------------------------

describe('buildLocateSystemPrompt —— 定位的提示词', () => {
    const p = buildLocateSystemPrompt(4);

    test('第一步就要求判断剧情演到哪，并且不只看这一段', () => {
        assert.ok(/判断现在演到哪|演到哪/.test(p), '要有位置判断这一步');
        assert.ok(/不要只看这一段|把上文一起读/.test(p), '要让它读上下文，不能只看最后一段');
    });

    test('数量上限写进了提示词', () => {
        assert.ok(buildLocateSystemPrompt(4).includes('4 条'));
        assert.ok(buildLocateSystemPrompt(7).includes('7 条'));
    });

    test('⭐ 缺少条件或证据时允许零选，不能强行挑最近条目', () => {
        assert.match(p, /允许 pick: \[\]/, '没有值得核查的候选时必须允许零选');
        assert.match(p, /缺少什么条件或证据/, '零选必须说明缺失的前提');
        assert.match(p, /不得.*强行挑选/, '必须禁止为了引导强行挑选');
        assert.doesNotMatch(p, /一条都不挑是最差的结果|最接近的那一条/, '不能残留强制最近条目的指令');
        const empty = parseLocateResult('{"phase":"条件不足","pick":[],"why":"缺少入场证据"}', 4);
        assert.deepEqual(empty.picks, []);
        assert.equal(empty.why, '缺少入场证据');
    });

    test('给了五类优先找的东西', () => {
        for (const kw of ['未兑现', '反常', '可去的地方', '未点破', '征兆']) {
            assert.ok(p.includes(kw), `缺少一类：${kw}`);
        }
    });

    test('明确不要挑「已经兑现过的」，避免马后炮', () => {
        assert.ok(/兑现过/.test(p), '要说清「已经发生过的不要再提」');
    });

    test('输出格式给了 phase / pick / why', () => {
        assert.ok(p.includes('"phase"') && p.includes('"pick"'));
    });
});

describe('buildLocateUserPrompt —— 定位的用户消息', () => {
    test('正文放在最前面，索引在后', () => {
        const t = buildLocateUserPrompt(
            { finishedText: '她走进酒馆。', historyText: '之前在路上。' },
            '1. 某条目（开局）讲什么',
        );
        assert.ok(t.indexOf('她走进酒馆') < t.indexOf('某条目'), '正文要在索引前面');
        assert.ok(t.includes('之前在路上'), '要有上文');
    });

    test('没有索引时不留空标题', () => {
        const t = buildLocateUserPrompt({ finishedText: 'x' }, '');
        assert.ok(t.includes('索引是空的'));
    });
});

describe('parseLocateResult —— 解析定位结果', () => {
    test('正常返回', () => {
        const r = parseLocateResult('{"phase":"刚到王都","pick":[3,17],"why":"都还没发生"}', 20);
        assert.equal(r.phase, '刚到王都');
        assert.deepEqual(r.picks, [3, 17]);
        assert.equal(r.why, '都还没发生');
    });

    test('⭐ 越界编号必须丢掉', () => {
        // 越界编号会取到**别的条目**的正文，让她说出一句和剧情无关的话，
        // 用户完全无从排查。
        const r = parseLocateResult('{"pick":[1,999,0,-2]}', 5);
        assert.deepEqual(r.picks, [1]);
    });

    test('重复编号去重并排序', () => {
        assert.deepEqual(parseLocateResult('{"pick":[9,2,9,5]}', 20).picks, [2, 5, 9]);
    });

    test('裸数组也认', () => {
        assert.deepEqual(parseLocateResult('[3,17]', 20).picks, [3, 17]);
    });

    test('别的字段名也认', () => {
        assert.deepEqual(parseLocateResult('{"picks":[4]}', 20).picks, [4]);
        assert.deepEqual(parseLocateResult('{"selected":[{"index":6}]}', 20).picks, [6]);
    });

    test('解析不了返回空 picks 而不是抛异常', () => {
        for (const bad of ['', '不是 JSON', null, undefined, '{}']) {
            const r = parseLocateResult(/** @type {any} */ (bad), 5);
            assert.deepEqual(r.picks, []);
            assert.equal(r.phase, '');
        }
    });
});

describe('shouldLocate —— 什么时候值得多跑一次定位', () => {
    const s = defaultSettings();

    test('auto：索引小的时候不跑（多一次往返不划算）', () => {
        s.guidance.locate = 'auto';
        s.guidance.locateMinHooks = 12;
        assert.equal(shouldLocate(s, 3), true, '小池也必须定位剧情进度');
        assert.equal(shouldLocate(s, 11), true);
        assert.equal(shouldLocate(s, 12), true, '到了阈值才跑');
        assert.equal(shouldLocate(s, 300), true);
    });

    test('on：只要有索引就跑', () => {
        s.guidance.locate = 'on';
        assert.equal(shouldLocate(s, 1), true);
        assert.equal(shouldLocate(s, 0), false, '没索引可定位');
    });

    test('off：永远不跑（退回「整份索引当素材」）', () => {
        s.guidance.locate = 'off';
        assert.equal(shouldLocate(s, 500), true);
    });

    test('默认是 auto', () => {
        assert.equal(defaultSettings().guidance.locate, 'auto');
        assert.deepEqual([...LOCATE_MODES], ['auto', 'on', 'off']);
    });
});

// ---------------------------------------------------------------------------
// 正文按需取回
// ---------------------------------------------------------------------------

/** 造一个只有一本书、两个条目的假 ctx。 */
function makeCtx(opts = {}) {
    const entries = [
        { uid: 1, comment: '旧城区的传言', content: '夜里有人搬箱子，白天什么都没有。' },
        { uid: 2, comment: '王都下水道', content: '水道错综复杂。' },
    ];
    return {
        loadWorldInfo: async (/** @type {string} */ name) => {
            if (opts.throwOnLoad) throw new Error('读不到');
            if (opts.noBook) return null;
            return { entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])) };
        },
    };
}

describe('resolveHookContents —— 用时才把正文取回来', () => {
    test('⭐ 按 (书, 编号) 从世界书现取正文', async () => {
        // 索引模式的池子里**不存正文**（几百条太重且会过期），
        // 所以这一步是「她到底看到了什么」的唯一来源。
        const hooks = [{ book: 'A', uid: 1, label: '旧城区的传言', content: '' }];
        const out = await resolveHookContents(makeCtx(), hooks);
        assert.ok(out[0].content.includes('夜里有人搬箱子'), '必须取到世界书里的正文');
    });

    test('不改原对象（调用方那份要保持干净）', async () => {
        const hooks = [{ book: 'A', uid: 1, label: 'x', content: '' }];
        await resolveHookContents(makeCtx(), hooks);
        assert.equal(hooks[0].content, '', '原数组不能被就地改掉');
    });

    test('作者改了世界书 → 立刻用上新版（不用清池子重读）', async () => {
        const ctx = makeCtx();
        const first = await resolveHookContents(ctx, [{ book: 'A', uid: 2, content: '' }]);
        assert.ok(first[0].content.includes('错综复杂'));
        // 换一本书的内容
        ctx.loadWorldInfo = async () => ({ entries: { 2: { uid: 2, comment: '王都下水道', content: '改过了。' } } });
        const second = await resolveHookContents(ctx, [{ book: 'A', uid: 2, content: '' }]);
        assert.equal(second[0].content, '改过了。');
    });

    test('书读不到时退回池子里存的那份，不报错', async () => {
        const hooks = [{ book: 'A', uid: 1, content: '存量正文' }];
        const out = await resolveHookContents(makeCtx({ throwOnLoad: true }), hooks);
        assert.equal(out[0].content, '存量正文');
    });

    test('书没了（返回 null）也不崩', async () => {
        const out = await resolveHookContents(makeCtx({ noBook: true }), [{ book: 'A', uid: 1, content: '兜底' }]);
        assert.equal(out[0].content, '兜底');
    });

    test('手工加的条目（没有 book）原样留着', async () => {
        const out = await resolveHookContents(makeCtx(), [{ label: '我手写的', content: '自己写的素材' }]);
        assert.equal(out[0].content, '自己写的素材');
    });

    test('条目被删了（uid 对不上）→ 退回存量而不是变空', async () => {
        const out = await resolveHookContents(makeCtx(), [{ book: 'A', uid: 999, content: '旧的' }]);
        assert.equal(out[0].content, '旧的');
    });

    test('超长正文按上限截断', async () => {
        const out = await resolveHookContents(makeCtx(), [{ book: 'A', uid: 1, content: '' }], { maxChars: 5 });
        assert.ok(out[0].content.length <= 8, `应当被截断，实际 ${out[0].content.length}`);
    });

    test('空输入不崩', async () => {
        for (const bad of [null, undefined, '不是数组', []]) {
            const out = await resolveHookContents(makeCtx(), /** @type {any} */ (bad));
            assert.deepEqual(out, []);
        }
    });
});
