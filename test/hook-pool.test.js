/**
 * 「AI 通读世界书 → 建立线索池」这一层的测试。
 *
 * ── 为什么这些测试重要
 *
 * 用户对原设计的批评很直接：
 *   「没有写卡作者会为了我们的插件来特地制定剧情条目。如果 ai 帮选你应该
 *     把提示词做好，让 ai 仔细阅读世界书里的内容确定哪些是剧情条目。」
 *
 * 后来实测又遇到「AI 认为没有适合的条目」并追加要求：
 *   「你要给这个通读世界书调用的 ai 放内置提示词，让它知道自己读这本世界书
 *     为了什么，而且只读条目是看不出什么的，要读条目里面的内容。
 *     最后你还要加一个自主勾选条目的选项，全交给 ai 可能会有遗漏，这是个保底。」
 *
 * 所以这里把四个环节分别钉住：
 *  1. 提示词本身 —— 判断标准 / 任务目的 / 读正文
 *  2. 返回解析 —— 模型会带围栏、会数错编号、会用别的字段名
 *  3. 「挑不出来」的理由 —— 让用户能判断是书的问题还是提示词的问题
 *  4. 缓存与手动保底 —— 什么该重筛、手动路径的产出结构
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import { buildScanSystemPrompt, parsePickResult, parseWhyEmpty } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { blankChatData, isHookPoolFresh, setHookPool } from '../src/core/store.js';

describe('buildScanSystemPrompt — future plot purpose', () => {
    const p = buildScanSystemPrompt(12, 0);
    test('full body, not titles or summaries; includes entering characters and events', () => {
        for (const text of ['完整正文', '不是标题', '未来事件', '登场人物', '末尾', 'why_empty']) assert.ok(p.includes(text));
    });
    test('entire future pool without arbitrary caps, no static setting catalog', () => {
        assert.ok(p.includes('不按比例或任意数量砍掉'));
        assert.ok(p.includes('无剧情联系的静态世界观不选'));
        assert.ok(p.includes('不要判断「现在有没有用」'));
    });
    test('JSON source numbers and explanatory empty result', () => {
        for (const key of ['"picks"', '"index"', '"kind"', '"reason"', 'why_empty']) assert.ok(p.includes(key));
    });
});

describe('parsePickResult —— 解析 AI 的挑选结果', () => {
    test('标准 { picks: [{index, kind, reason}] }', () => {
        const r = parsePickResult(
            '{"picks":[{"index":3,"kind":"线索","reason":"有悬念"},{"index":1,"kind":"地点","reason":"可去"}]}',
            10,
        );
        assert.deepEqual(r, [
            { index: 1, reason: '可去', kind: '地点' },
            { index: 3, reason: '有悬念', kind: '线索' },
        ]);
    });

    test('带 ```json 围栏 + 前后解释文字', () => {
        const r = parsePickResult('好的：\n```json\n{"picks":[{"index":2}]}\n```\n希望有帮助', 10);
        assert.deepEqual(r, [{ index: 2, reason: '', kind: '' }]);
    });

    test('裸数组也能解析', () => {
        assert.deepEqual(
            parsePickResult('[1, 5, 9]', 10).map((x) => x.index),
            [1, 5, 9],
        );
    });

    test('⭐ 越界编号必须丢掉（否则会去动错误的条目）', () => {
        const r = parsePickResult('{"picks":[{"index":1},{"index":999},{"index":0},{"index":-5}]}', 5);
        assert.deepEqual(r.map((x) => x.index), [1], `越界编号混进来了：${JSON.stringify(r)}`);
    });

    test('重复编号去重', () => {
        assert.deepEqual(
            parsePickResult('{"picks":[{"index":2},{"index":2},{"index":3}]}', 5).map((x) => x.index),
            [2, 3],
        );
    });

    test('字段名变体（selected / result / id / no）', () => {
        assert.deepEqual(parsePickResult('{"selected":[{"id":4}]}', 5).map((x) => x.index), [4]);
        assert.deepEqual(parsePickResult('{"result":[{"no":2}]}', 5).map((x) => x.index), [2]);
    });

    test('字符串数字也能认（"3"）', () => {
        assert.deepEqual(parsePickResult('{"picks":[{"index":"3"}]}', 5).map((x) => x.index), [3]);
    });

    test('解析不出来时返回空数组，而不是抛异常', () => {
        for (const bad of ['', '   ', '模型说它不想选', '{坏 JSON', null, undefined]) {
            assert.deepEqual(parsePickResult(/** @type {any} */ (bad), 5), [], `输入 ${JSON.stringify(bad)}`);
        }
    });

    test('空 picks 返回空（调用方据此提示「确实没有合适的」）', () => {
        assert.deepEqual(parsePickResult('{"picks":[]}', 5), []);
    });
});

describe('parseWhyEmpty —— 「为什么一条都挑不出来」', () => {
    test('从标准 JSON 里取 why_empty', () => {
        assert.equal(parseWhyEmpty('{"picks":[],"why_empty":"全部是数值表"}'), '全部是数值表');
    });

    test('字段名变体', () => {
        assert.equal(parseWhyEmpty('{"picks":[],"whyEmpty":"全是空条目"}'), '全是空条目');
        assert.equal(parseWhyEmpty('{"picks":[],"reason_if_empty":"都读不懂"}'), '都读不懂');
    });

    test('JSON 写坏了，但用自然语言说了原因 → 正则兜底', () => {
        assert.equal(parseWhyEmpty('{"picks":[] 坏掉了\n理由：正文都是空的'), '正文都是空的');
        assert.equal(parseWhyEmpty('why_empty: 全是已发生剧情'), '全是已发生剧情');
    });

    test('⭐ 什么都没说 → 空串（调用方要显示「它没说明理由」而不是假装有理由）', () => {
        assert.equal(parseWhyEmpty('{"picks":[]}'), '');
        assert.equal(parseWhyEmpty(''), '');
        assert.equal(parseWhyEmpty(null), '');
        assert.equal(parseWhyEmpty('模型随便说了点什么'), '');
    });

    test('理由过长会被截断（避免把一大段塞进界面）', () => {
        const long = '很长的理由'.repeat(100);
        const out = parseWhyEmpty(JSON.stringify({ picks: [], why_empty: long }));
        assert.ok(out.length <= 200, `实际 ${out.length}`);
    });
});

describe('线索池的手动建立（用户要的保底路径）', () => {
    test('⭐ 手动建出来的池子与 AI 建的**结构完全一致**（下游不用区分来源）', () => {
        // 用户要求：「最后你还要加一个自主勾选条目的选项，全交给 ai 可能会有遗漏，这是个保底。」
        // 保底路径要是产出结构不一致，下游引导就会拿到半截数据 —— 那比没有更糟。
        const data = blankChatData();
        setHookPool(
            data,
            [
                {
                    book: '主书',
                    uid: 3,
                    label: '旧城区的传言',
                    content: '夜里有人搬箱子。',
                    kind: '手选',
                    why: '手动指定',
                },
            ],
            ['主书'],
        );
        const hook = data.hookPool.hooks[0];
        // AI 路径产出的字段：book / uid / label / content / kind / why
        for (const key of ['book', 'uid', 'label', 'content', 'kind', 'why']) {
            assert.ok(key in hook, `手动建池缺字段 ${key} —— 下游会拿到半截数据`);
        }
        assert.equal(isHookPoolFresh(data, defaultSettings(), ['主书']), true);
    });

    test('手动建的池子也受有效期约束（不会永远不重读）', () => {
        const data = blankChatData();
        setHookPool(data, [{ label: 'x', content: 'y' }], ['甲']);
        const s = defaultSettings();
        s.worldbook.poolTtlMs = 1;
        data.hookPool.at = Date.now() - 10;
        assert.equal(isHookPoolFresh(data, s, ['甲']), false);
    });
});

describe('正文下标定位的兜底（顺序反了也不能漏掉这一轮）', () => {
    test('⭐ messageIndexOfTurn 把「第几轮」换算成消息下标', async () => {
        const { GuideController } = await import('../src/app.js');
        const { defaultSettings } = await import('../src/config.js');

        const ctx = {
            chat: [
                { name: '你', is_user: true, mes: 'a' },
                { name: '角色', is_user: false, mes: 'b' }, // 第 1 轮 → 下标 1
                { name: '你', is_user: true, mes: 'c' },
                { name: '角色', is_user: false, mes: 'd' }, // 第 2 轮 → 下标 3
            ],
        };
        const app = new GuideController(ctx, defaultSettings());
        assert.equal(app.messageIndexOfTurn(1), 1);
        assert.equal(app.messageIndexOfTurn(2), 3);
        // 越界 / 非法输入返回 null（调用方据此走别的大分支）
        assert.equal(app.messageIndexOfTurn(9), null);
        assert.equal(app.messageIndexOfTurn(0), null);
        assert.equal(app.messageIndexOfTurn('x'), null);
    });

    test('跳过插件自己注入的隐藏消息（那些不算「轮」）', async () => {
        const { GuideController } = await import('../src/app.js');
        const { defaultSettings } = await import('../src/config.js');

        const ctx = {
            chat: [
                { name: '你', is_user: true, mes: 'a' },
                { name: '角色', is_user: false, mes: 'b' },
                { name: '碧翠丝', is_system: true, mes: '旁注', extra: { beatriceGuide: { injected: true } } },
                { name: '你', is_user: true, mes: 'c' },
                { name: '角色', is_user: false, mes: 'd' },
            ],
        };
        const app = new GuideController(ctx, defaultSettings());
        assert.equal(app.messageIndexOfTurn(2), 4, '隐藏的旁注楼层不该被算成一「轮」');
    });
});

describe('Human confirmation is mandatory', () => {
    test('ensureHookPool may read candidates but never confirms a pending selection', async () => {
        const { GuideController } = await import('../src/app.js');
        const { getCharacterPool } = await import('../src/core/store.js');
        const settings = defaultSettings();
        settings.worldbook.bookNames = ['Selected'];
        const ctx = { characterId: 0, characters: [{ name: 'Alice', avatar: 'alice.png' }], chatId: 'a',
            extensionSettings: {}, chatMetadata: {}, chat: [] };
        const app = new GuideController(ctx, settings);
        app.buildHookPool = async () => ({ ok: true, needsConfirmation: true, reviewId: 'pending', candidates: [], selectedIndices: [] });
        app.confirmHookPoolSelection = async () => { assert.fail('ensure must not auto-confirm'); };
        await app.ensureHookPool({ silent: true });
        assert.equal(getCharacterPool(ctx), null, 'no pool exists without human confirmation');
    });
});

describe('线索池的缓存语义', () => {
    test('空数据 → 没有可用的池子', () => {
        const data = blankChatData();
        assert.equal(data.hookPool, null);
        assert.equal(isHookPoolFresh(data, defaultSettings(), ['书A']), false);
    });

    test('存进去之后可读，且书单一致时算新鲜', () => {
        const data = blankChatData();
        setHookPool(data, [{ label: 'A', content: 'x' }], ['书A']);
        assert.equal(data.hookPool.hooks.length, 1);
        assert.equal(isHookPoolFresh(data, defaultSettings(), ['书A']), true);
    });

    test('⭐ 书单变了 → 池子失效（旧线索可能来自完全不同的世界观）', () => {
        const data = blankChatData();
        setHookPool(data, [{ label: 'A', content: 'x' }], ['书A']);
        assert.equal(isHookPoolFresh(data, defaultSettings(), ['书B']), false, '换书必须重筛');
        assert.equal(isHookPoolFresh(data, defaultSettings(), ['书A', '书B']), false, '加书也要重筛');
        assert.equal(isHookPoolFresh(data, defaultSettings(), []), false);
    });

    test('书单顺序不同不算变化（集合比较）', () => {
        const data = blankChatData();
        setHookPool(data, [{ label: 'A', content: 'x' }], ['甲', '乙']);
        assert.equal(isHookPoolFresh(data, defaultSettings(), ['乙', '甲']), true);
    });

    test('⭐ 过期 → 失效', () => {
        const data = blankChatData();
        setHookPool(data, [{ label: 'A', content: 'x' }], ['书A']);
        const s = defaultSettings();
        s.worldbook.poolTtlMs = 1;
        data.hookPool.at = Date.now() - 10;
        assert.equal(isHookPoolFresh(data, s, ['书A']), false);
    });

    test('结构坏掉的池子当作没有（宁可重筛，也不要拿半截数据去引导）', () => {
        const s = defaultSettings();
        for (const bad of [
            { at: Date.now(), books: ['书A'] }, // 没有 hooks
            { at: Date.now(), hooks: [], books: ['书A'] }, // 空 hooks
            { at: 'x', hooks: [{ label: 'A' }], books: ['书A'] }, // at 非法
            'not-an-object',
            null,
        ]) {
            const data = { ...blankChatData(), hookPool: /** @type {any} */ (bad) };
            assert.equal(isHookPoolFresh(data, s, ['书A']), false, `坏池子 ${JSON.stringify(bad)} 应该判为失效`);
        }
    });
});
