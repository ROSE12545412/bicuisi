/**
 * 世界书读取与候选筛选的测试。
 *
 * ── 这一层改过一次设计，测试要跟着改
 *
 * 原设计：只读**标了标签**的条目（`[引导] xxx`），要求用户/卡作者去标标签。
 * 用户一句话点破了前提：
 *   「没有写卡作者会为了我们的插件来特地制定剧情条目。」
 *
 * 所以现在默认读**全部条目**，由 AI 判断哪些是剧情条目。
 * 这个文件测的就是新语义：
 *   - 标签解析仍然要准（它降级成了可选的硬过滤）
 *   - **不带标签的条目必须能进候选**（新设计的核心，也是旧设计最大的错）
 *   - `excludeTags` 仍然是硬排除（剧透保护，不是筛选）
 *   - 候选清单的格式化、编号、上限
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import {
    collectCandidates,
    discoverBookNames,
    formatCandidatesForScan,
    formatHooksForPrompt,
    isExcluded,
    listAllBooks,
    parseEntryTags,
    passesManualFilter,
    readBook,
    truncate,
} from '../src/worldbook.js';
import { defaultSettings } from '../src/config.js';

/** 造一份带默认规则的设置。 */
function settingsWith(overrides = {}) {
    const s = defaultSettings();
    Object.assign(s.worldbook, overrides);
    return s;
}

describe('parseEntryTags —— 标签解析（现在只是可选的硬过滤，但解析本身仍要准）', () => {
    const rules = {
        tags: ['引导', '钩子', '剧情', '地点', '事件', '线索'],
        excludeTags: ['禁止引导', '剧透', '勿引导'],
    };

    test('方括号 + 空格分隔', () => {
        const r = parseEntryTags('[引导] 旧城区的传言', rules);
        assert.deepEqual(r.tags, ['引导']);
        assert.equal(r.label, '旧城区的传言');
    });

    test('方括号 + 冒号分隔（值在括号内）', () => {
        const r = parseEntryTags('[引导：旧城区的传言]', rules);
        assert.deepEqual(r.tags, ['引导']);
        assert.equal(r.label, '旧城区的传言');
    });

    test('中文方头括号 / 圆括号 / 无括号前缀式', () => {
        assert.deepEqual(parseEntryTags('【地点】王都下水道', rules).tags, ['地点']);
        assert.deepEqual(parseEntryTags('（线索）卖花女人的眼神', rules).tags, ['线索']);
        const r = parseEntryTags('引导 - 罗兹瓦尔宅邸的邀约', rules);
        assert.deepEqual(r.tags, ['引导']);
        assert.equal(r.label, '罗兹瓦尔宅邸的邀约');
    });

    test('多个标签同时出现', () => {
        const r = parseEntryTags('[剧情][地点] 边境伯的宅邸', rules);
        assert.deepEqual(r.tags, ['剧情', '地点']);
        assert.equal(r.label, '边境伯的宅邸');
    });

    test('标签带值的多种分隔符', () => {
        for (const sep of ['·', '|', '/', '：']) {
            const r = parseEntryTags(`[引导${sep}钟楼的钟声]`, rules);
            assert.deepEqual(r.tags, ['引导'], `分隔符 ${sep}`);
            assert.equal(r.label, '钟楼的钟声', `分隔符 ${sep}`);
        }
    });

    test('排除标签被识别，且与包含标签同时出现时仍然排除', () => {
        assert.equal(parseEntryTags('[禁止引导] 结局真相', rules).excluded, true);
        assert.equal(parseEntryTags('[引导][剧透] 大结局', rules).excluded, true);
    });

    test('无标签的普通标题', () => {
        const r = parseEntryTags('莱因哈鲁特人物卡', rules);
        assert.deepEqual(r.tags, []);
        assert.equal(r.label, '');
    });

    test('空注释不崩', () => {
        for (const input of ['', null, undefined, '   ']) {
            const r = parseEntryTags(/** @type {any} */ (input), rules);
            assert.deepEqual(r.tags, []);
        }
    });

    test('说明性后缀会被剥离（`←` 后面是给作者自己看的注释）', () => {
        const r = parseEntryTags('[地点] 王都下水道 · 东段暗渠 ← 中文方头括号也可以', rules);
        assert.equal(r.label, '王都下水道 · 东段暗渠');
    });

    test('⚠️ 说明文字里带括号会把名字切坏（已知限制，用测试记录下来）', () => {
        const r = parseEntryTags('[地点] 王都下水道 ← 也可以，[地点] 也在白名单里', rules);
        assert.notEqual(r.label, '王都下水道', '括号是标签区域的边界，这里会被切');
    });
});

describe('isExcluded / passesManualFilter —— 硬排除 vs 可选过滤', () => {
    test('⭐ 默认（白名单为空）时**不按标签过滤** —— 所有条目都通过', () => {
        // 新设计的核心：不再要求作者标标签。
        const s = settingsWith();
        assert.deepEqual(s.worldbook.tags, [], '白名单默认应该是空的');
        assert.equal(passesManualFilter({ comment: '一个完全没标签的条目' }, s), true);
        assert.equal(passesManualFilter({ comment: '[引导] 有标签的' }, s), true);
    });

    test('用户主动填了白名单时才按标签过滤', () => {
        const s = settingsWith({ tags: ['引导'] });
        assert.equal(passesManualFilter({ comment: '[引导] 有标签的' }, s), true);
        assert.equal(passesManualFilter({ comment: '没标签的' }, s), false);
    });

    test('⭐ excludeTags 是硬排除，不受白名单影响（剧透保护）', () => {
        // 这不是「筛选」，是用户主动声明的「这块别碰」——
        // AI 再聪明也不该覆盖它，所以在收集阶段就挡掉。
        const s = settingsWith({ tags: [] });
        assert.equal(isExcluded({ comment: '[禁止引导] 结局真相' }, s), true);
        assert.equal(isExcluded({ comment: '[剧透] 幕后黑手' }, s), true);
        assert.equal(isExcluded({ comment: '普通条目' }, s), false);
    });
});

describe('discoverBookNames —— 世界书发现', () => {
    function fakeCtx({ characterWorld, chatBook, globals, chid = 0 } = {}) {
        return {
            characterId: chid,
            characters: [{ name: '测试卡', data: { extensions: { world: characterWorld } } }],
            chatMetadata: { world_info: chatBook },
            powerUserSettings: { world_info: { globalSelect: globals ?? [] } },
        };
    }

    test('三处来源合并，角色卡优先', () => {
        const names = discoverBookNames(
            fakeCtx({ characterWorld: '卡书', chatBook: '聊天书', globals: ['全局书A'] }),
            defaultSettings(),
        );
        assert.deepEqual(names, ['卡书', '聊天书', '全局书A']);
    });

    test('用户显式配置时只用手动指定的', () => {
        const s = defaultSettings();
        s.worldbook.bookNames = ['我指定的书'];
        assert.deepEqual(discoverBookNames(fakeCtx({ characterWorld: '卡书' }), s), ['我指定的书']);
    });

    test('上下文缺字段不崩', () => {
        assert.deepEqual(discoverBookNames({}, defaultSettings()), []);
        assert.deepEqual(discoverBookNames(null, defaultSettings()), []);
    });
});

describe('listAllBooks —— 列出所有世界书（供用户勾选）', () => {
    test('getWorldInfoNames 同步或异步都支持', async () => {
        assert.deepEqual(await listAllBooks({ getWorldInfoNames: () => ['甲', '乙'] }), ['甲', '乙']);
        assert.deepEqual(await listAllBooks({ getWorldInfoNames: async () => ['甲', '乙'] }), ['甲', '乙']);
    });

    test('getWorldInfoNames 抛异常时回落全局勾选', async () => {
        const names = await listAllBooks({
            powerUserSettings: { world_info: { globalSelect: ['全局一'] } },
            getWorldInfoNames: () => {
                throw new Error('没有这个接口');
            },
        });
        assert.ok(names.includes('全局一'));
    });

    test('什么都没有时返回空数组', async () => {
        assert.deepEqual(await listAllBooks({}), []);
        assert.deepEqual(await listAllBooks(null), []);
    });
});

describe('readBook —— 条目规范化（两套字段命名都要兼容）', () => {
    const ctxWithBook = (/** @type {any} */ book) => ({ loadWorldInfo: async () => book });

    test('v2 原始格式（keys / enabled / insertion_order）', async () => {
        const ctx = ctxWithBook({
            entries: { 0: { comment: '[引导] A', content: '内容A', keys: ['k1'], enabled: true, insertion_order: 5 } },
        });
        const [e] = await readBook(ctx, '书');
        assert.deepEqual(e.keys, ['k1']);
        assert.equal(e.disabled, false);
        assert.equal(e.order, 5);
    });

    test('扁平化格式（key 单数 / disable / order）', async () => {
        const ctx = ctxWithBook({ entries: { 7: { content: 'B', key: 'k1', disable: true, order: 9 } } });
        const [e] = await readBook(ctx, '书');
        assert.deepEqual(e.keys, ['k1']);
        assert.equal(e.disabled, true);
        assert.equal(e.uid, 7);
    });

    test('书不存在 / 没有 entries → 空数组，不抛', async () => {
        assert.deepEqual(await readBook(ctxWithBook(null), '书'), []);
        assert.deepEqual(await readBook(ctxWithBook({ foo: 1 }), '书'), []);
    });

    test('没有 loadWorldInfo 的宿主 → 抛错（上层给可读提示）', async () => {
        await assert.rejects(() => readBook({}, '书'), /不支持 loadWorldInfo/);
    });
});

describe('collectCandidates —— 候选收集（新设计的核心）', () => {
    /** 造一个假 ctx。 */
    function buildCtx(books, { characterWorld } = {}) {
        return {
            characterId: 0,
            characters: [{ data: { extensions: { world: characterWorld ?? Object.keys(books)[0] ?? '' } } }],
            chatMetadata: {},
            powerUserSettings: { world_info: { globalSelect: [] } },
            loadWorldInfo: async (/** @type {string} */ name) => books[name] ?? null,
        };
    }

    test('⭐ 不带标签的条目必须进候选（旧设计把它们全丢了）', async () => {
        const ctx = buildCtx({
            主书: {
                entries: {
                    0: { comment: '一个完全没标签的条目', content: '有内容' },
                    1: { comment: '另一个没标签的', content: '也有内容' },
                },
            },
        });
        const out = await collectCandidates(ctx, settingsWith(), {});
        assert.equal(
            out.candidates.length,
            2,
            `无标签条目被漏掉了：${JSON.stringify(out.candidates.map((c) => c.comment))}`,
        );
        assert.equal(out.manualFilter, false, '默认不该启用标签过滤');
    });

    test('⭐ 退役 excludeTags 不限制 AI 全文来源', async () => {
        const ctx = buildCtx({
            主书: {
                entries: {
                    0: { comment: '[禁止引导] 结局真相', content: '其实……' },
                    1: { comment: '正常条目', content: '有内容' },
                },
            },
        });
        const out = await collectCandidates(ctx, settingsWith(), {});
        assert.deepEqual(out.candidates.map((c) => c.comment), ['[禁止引导] 结局真相', '正常条目']);
    });

    test('禁用条目保留，仅空正文跳过', async () => {
        const ctx = buildCtx({
            主书: {
                entries: {
                    0: { comment: '禁用的', content: 'x', disable: true },
                    1: { comment: '空的', content: '   ' },
                    2: { comment: '好的', content: '有内容' },
                },
            },
        });
        const out = await collectCandidates(ctx, settingsWith(), {});
        assert.deepEqual(out.candidates.map((c) => c.comment), ['禁用的', '好的']);
        assert.equal(out.skipped, 1);
    });

    test('退役常量开关不再过滤', async () => {
        const ctx = buildCtx({
            主书: {
                entries: {
                    0: { comment: '设定', content: 'x', constant: true },
                    1: { comment: '剧情', content: 'y' },
                },
            },
        });
        const off = await collectCandidates(ctx, settingsWith({ includeConstantEntries: false }), {});
        assert.deepEqual(off.candidates.map((c) => c.comment), ['设定', '剧情']);
        const on = await collectCandidates(ctx, settingsWith({ includeConstantEntries: true }), {});
        assert.equal(on.candidates.length, 2);
    });

    test('退役白名单不再过滤', async () => {
        const ctx = buildCtx({
            主书: {
                entries: {
                    0: { comment: '[引导] 有标签', content: 'x' },
                    1: { comment: '没标签', content: 'y' },
                },
            },
        });
        const out = await collectCandidates(ctx, settingsWith({ tags: ['引导'] }), {});
        assert.deepEqual(out.candidates.map((c) => c.comment), ['[引导] 有标签', '没标签']);
        assert.equal(out.manualFilter, false);
    });

    test('按插入顺序排序', async () => {
        const ctx = buildCtx({
            主书: {
                entries: {
                    0: { comment: '第三', content: 'x', order: 30 },
                    1: { comment: '第一', content: 'x', order: 10 },
                    2: { comment: '第二', content: 'x', order: 20 },
                },
            },
        });
        const out = await collectCandidates(ctx, settingsWith(), {});
        assert.deepEqual(out.candidates.map((c) => c.comment), ['第一', '第二', '第三']);
    });

    test('某本书读失败 → 记进 errors，其他书照常', async () => {
        const ctx = {
            characterId: 0,
            characters: [{ data: { extensions: { world: '坏书' } } }],
            chatMetadata: { world_info: '好书' },
            powerUserSettings: { world_info: { globalSelect: [] } },
            loadWorldInfo: async (/** @type {string} */ name) => {
                if (name === '坏书') throw new Error('文件损坏');
                return { entries: { 0: { comment: '好的', content: 'ok' } } };
            },
        };
        const out = await collectCandidates(ctx, settingsWith(), {});
        assert.equal(out.candidates.length, 1);
        assert.equal(out.errors.length, 1);
    });

    test('没有任何世界书 → 空结果且不抛', async () => {
        const out = await collectCandidates(
            { characterId: -1, characters: [], chatMetadata: {}, powerUserSettings: {} },
            settingsWith(),
            {},
        );
        assert.deepEqual(out.candidates, []);
        assert.deepEqual(out.books, []);
    });
});

describe('formatCandidatesForScan —— 给 AI 的清单格式', () => {
    test('编号从 1 开始，带标题与摘要', () => {
        const out = formatCandidatesForScan([
            { comment: '甲', content: '内容甲' },
            { comment: '乙', content: '内容乙' },
        ]);
        assert.match(out.text, /^1\. 甲/m);
        assert.match(out.text, /^2\. 乙/m);
        assert.equal(out.used.length, 2);
        assert.equal(out.omitted, 0);
    });

    test('没有标题时给可辨认的占位（不能是空行）', () => {
        const out = formatCandidatesForScan([{ comment: '', uid: 7, content: 'x' }]);
        assert.match(out.text, /无标题/);
    });

    test('⭐ 超过条目数上限时截断，并回报 omitted（提示词要据此说明）', () => {
        /** @type {any[]} */
        const list = [];
        for (let i = 0; i < 50; i++) list.push({ comment: `条${i}`, content: 'x' });
        const out = formatCandidatesForScan(list, { maxEntries: 10 });
        assert.equal(out.used.length, 10);
        assert.equal(out.omitted, 40, '必须回报有多少条没列出来');
    });

    test('超过总字符上限时也截断', () => {
        /** @type {any[]} */
        const list = [];
        for (let i = 0; i < 100; i++) list.push({ comment: `条${i}`, content: 'X'.repeat(500) });
        const out = formatCandidatesForScan(list, { maxCharsPerEntry: 500, maxCharsTotal: 2000 });
        assert.ok(out.chars <= 2600, `实际 ${out.chars}`);
        assert.ok(out.omitted > 0);
    });

    test('空列表不崩', () => {
        const out = formatCandidatesForScan([]);
        assert.equal(out.text, '');
        assert.equal(out.used.length, 0);
    });
});

describe('truncate —— 截断保留头尾', () => {
    test('短文本原样返回', () => {
        assert.equal(truncate('短', 100), '短');
    });

    test('长文本保留头部为主、尾部为辅', () => {
        const text = 'A'.repeat(50) + 'B'.repeat(50);
        const out = truncate(text, 40);
        assert.ok(out.length <= 43);
        assert.ok(out.startsWith('A'));
        assert.ok(out.includes('…'));
        assert.ok(out.endsWith('B'));
    });

    test('非法上限不误截', () => {
        assert.equal(truncate('一二三', 0), '一二三');
        assert.equal(truncate('一二三', -5), '一二三');
        assert.equal(truncate('一二三', NaN), '一二三');
    });
});

describe('formatHooksForPrompt —— 给引导模型看的线索格式', () => {
    test('带 kind 与标题', () => {
        const text = formatHooksForPrompt([
            { kind: '线索', label: '钟声', content: '钟楼每晚敲十三下。' },
            { label: '无 kind 的', content: 'x' },
        ]);
        assert.match(text, /\[线索\]钟声：钟楼每晚敲十三下。/);
        assert.match(text, /无 kind 的：x/);
    });

    test('⭐ 空列表要明确告知「没有线索」，而不是给空字符串', () => {
        // 空字符串会让模型以为「线索部分被省略了」，进而开始自己编。
        assert.match(formatHooksForPrompt([]), /没有可用的线索/);
        assert.match(formatHooksForPrompt(null), /没有可用的线索/);
    });
});
