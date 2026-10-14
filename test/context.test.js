/**
 * 上下文快照（GuideContext）的测试。
 *
 * 为什么这些用例值得存在：
 *  - `buildGuideContext` 是唯一大量读聊天记录的地方。它有两个「错了就完蛋」的性质：
 *    ① **必须排除插件自己注入的消息**。注入的引导一旦被当成剧情事实喂回辅助模型，
 *       就会形成「引导 → 被当剧情 → 再基于它引导」的自我强化复读机，而且会越滚越偏；
 *    ② **必须截断**。几百楼的长聊天整段塞进提示词，辅助模型会去引导几十轮前的事。
 *  - `similarity` / `findDuplicate` 是去重记忆的核心。世界书钩子池有限，抓不住复读的
 *    表现是「贝翠丝几十轮都在暗示同一个地方」，用户只会觉得这插件很笨。
 *    这里特意用了「换字不改意」的中文句子 —— 复读时模型不会一字不差。
 *  - `currentTurnIndex` 拿来做幂等标记（同一条 AI 消息只引导一次）。它多数一条注入消息，
 *    就会导致下一轮被误判成「已经引导过」而永久沉默。
 *  - `cut` 的空白折叠决定了场面是不是一行一条。没折叠的话，一条多行正文会把
 *    「最近 8 条」的节选撑成一整页。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import {
    buildGuideContext,
    currentTurnIndex,
    cut,
    findDuplicate,
    isInjectedMessage,
    roleplayMessages,
    similarity,
    speakerNames,
} from '../src/context.js';
import { defaultSettings } from '../src/config.js';

/** 插件自己注入的消息（形状见 CONTRACTS §5）。 */
function injected(mes) {
    return {
        name: '贝翠丝',
        is_user: false,
        is_system: true,
        mes,
        extra: { beatriceGuide: { injected: true, at: 1 } },
    };
}

/** 造一个假 ctx。默认是一个「有用户名、没有角色卡」的最小可用上下文。 */
function fakeCtx({ chat = [], name1 = '契约者', name2 = '', characterId = 0, characters = [] } = {}) {
    return { chat, name1, name2, characterId, characters };
}

describe('similarity —— 字符二元组 Jaccard', () => {
    test('完全相同 → 1，标点与空白差异不算差异', () => {
        assert.equal(similarity('今晚的钟声很不对劲', '今晚的钟声很不对劲'), 1);
        assert.equal(similarity('今晚的钟声很不对劲。', '今晚的钟声很不对劲'), 1);
        assert.equal(similarity(' 今晚 的钟声，很不对劲！ ', '今晚的钟声很不对劲'), 1);
        assert.equal(similarity('「今晚的钟声很不对劲」', '今晚的钟声很不对劲'), 1);
    });

    test('完全无关 → 接近 0', () => {
        const score = similarity('今晚的钟声很不对劲', 'ABCDEFG');
        assert.ok(score < 0.1, `实际 ${score}`);
    });

    test('换字不改意的中文句子 → 高相似度（复读检测的核心场景）', () => {
        const score = similarity('今天街上的人都在往同一个方向走', '今天街上的人全都朝同一个方向去了');
        assert.ok(score > 0.4, `实际 ${score}，低于这个值就抓不到换字复读了`);
        assert.ok(score < 1, '毕竟不是同一句，不该判成完全相同');
    });

    test('空串 / 非字符串输入 → 0', () => {
        assert.equal(similarity('', '随便什么'), 0);
        assert.equal(similarity('随便什么', ''), 0);
        assert.equal(similarity('', ''), 0);
        assert.equal(similarity(null, '随便什么'), 0);
        assert.equal(similarity(undefined, undefined), 0);
    });

    test('单字比较不崩（长度 1 的串用自身当二元组）', () => {
        assert.equal(similarity('好', '好'), 1);
        assert.equal(similarity('好', '坏'), 0);
    });
});

describe('findDuplicate —— 复读检测', () => {
    const prev = '旧城区的地下交易不太对劲';

    test('命中：达到阈值算重复', () => {
        const r = findDuplicate(prev, [prev]);
        assert.equal(r.duplicate, true);
        assert.equal(r.score, 1);
        assert.equal(r.matched, prev);
    });

    test('不命中：分数低于阈值', () => {
        const r = findDuplicate('去钟楼看看', [prev]);
        assert.equal(r.duplicate, false);
        assert.ok(r.score < 0.72, `实际 ${r.score}`);
    });

    test('threshold 可调：同一对句子在不同阈值下结论不同', () => {
        const a = '今天街上的人都在往同一个方向走';
        const b = '今天街上的人全都朝同一个方向去了';
        assert.equal(findDuplicate(a, [b], 0.9).duplicate, false);
        assert.equal(findDuplicate(a, [b], 0.4).duplicate, true);
    });

    test('matched 是最相似的那一条（不是列表里的最后一条）', () => {
        const many = ['完全不相干的句子内容', prev, '另一句也说不上像的话'];
        const r = findDuplicate(prev, many);
        assert.equal(r.matched, prev);
        assert.equal(r.score, 1);
        assert.equal(r.duplicate, true);
    });

    test('spoken 为空或不是数组 → 不重复、不崩', () => {
        for (const empty of [[], null, undefined, '不是数组', 42]) {
            const r = findDuplicate('随便一句话', empty);
            assert.equal(r.duplicate, false, `输入 ${JSON.stringify(empty)}`);
            assert.equal(r.score, 0);
            assert.equal(r.matched, '');
        }
    });

    test('返回结构始终齐全（调用方直接读 .score / .matched）', () => {
        assert.deepEqual(Object.keys(findDuplicate('x', [])).sort(), ['duplicate', 'matched', 'score']);
    });
});

describe('isInjectedMessage —— 认自家消息', () => {
    test('extra.beatriceGuide.injected === true 判真', () => {
        assert.equal(isInjectedMessage(injected('【贝翠丝的低语】')), true);
    });

    test('标记是真值就判真（不要求严格布尔）', () => {
        assert.equal(isInjectedMessage({ extra: { beatriceGuide: { injected: 1 } } }), true);
    });

    test('其它形状判假', () => {
        assert.equal(isInjectedMessage({ mes: '普通消息' }), false);
        assert.equal(isInjectedMessage({ extra: {} }), false);
        assert.equal(isInjectedMessage({ extra: { beatriceGuide: {} } }), false);
        assert.equal(isInjectedMessage({ extra: { beatriceGuide: { injected: false } } }), false);
        assert.equal(isInjectedMessage({ extra: { otherPlugin: { injected: true } } }), false, '别的插件的标记不算');
        assert.equal(isInjectedMessage({ extra: '不是对象' }), false);
    });

    test('null / undefined / 非对象不崩', () => {
        for (const bad of [null, undefined, 0, '', 'string', 42]) {
            assert.equal(isInjectedMessage(bad), false, `输入 ${String(bad)}`);
        }
    });
});

describe('cut —— 单行化 + 截断', () => {
    test('短文本原样返回（只做首尾去空白）', () => {
        assert.equal(cut('  短文本  ', 100), '短文本');
        assert.equal(cut('正好六个字啊', 6), '正好六个字啊');
    });

    test('刚好等于上限不截断，超过才补省略号', () => {
        assert.equal(cut('一二三四五', 5), '一二三四五');
        assert.equal(cut('一二三四五六', 5), '一二三四五…');
        assert.equal(cut('一二三四五六', 5).length, 6, '截断后是「上限 + 省略号」');
    });

    test('空白折叠：换行 / 制表 / 连续空格都变成单个空格', () => {
        assert.equal(cut('第一行\n第二行', 100), '第一行 第二行');
        assert.equal(cut('很多    空格\t和\n换行', 100), '很多 空格 和 换行');
    });

    test('按折叠后的长度截断', () => {
        assert.equal(cut('a\n\n\n\nb', 2), 'a …');
    });

    test('null / undefined / 数字输入不崩', () => {
        assert.equal(cut(null, 10), '');
        assert.equal(cut(undefined, 10), '');
        assert.equal(cut(42, 10), '42');
    });
});

describe('currentTurnIndex —— 第几轮', () => {
    test('只数非 user 非 system 的消息', () => {
        const ctx = fakeCtx({
            chat: [
                { mes: '甲', is_user: true },
                { mes: '乙', is_user: false },
                { mes: '丙', is_system: true },
                { mes: '丁', is_user: false, is_system: false },
                injected('贝翠丝的低语'),
            ],
        });
        assert.equal(currentTurnIndex(ctx), 2, '注入的隐藏消息不能计入轮次');
    });

    test('空聊天 = 0', () => {
        assert.equal(currentTurnIndex(fakeCtx()), 0);
        assert.equal(currentTurnIndex({ chat: [] }), 0);
    });

    test('chat 不是数组 = 0，不崩', () => {
        assert.equal(currentTurnIndex({ chat: '不是数组' }), 0);
        assert.equal(currentTurnIndex({}), 0);
        assert.equal(currentTurnIndex(null), 0);
    });

    test('含 null / undefined 项不崩', () => {
        assert.equal(currentTurnIndex({ chat: [null, { mes: 'x' }, undefined] }), 1);
    });
});

describe('speakerNames —— 用户 / 角色名', () => {
    test('name1 与 characters[characterId].name，顺手去空白', () => {
        const ctx = { name1: ' 阿强 ', name2: '备用名', characterId: 0, characters: [{ name: ' 贝翠丝 ' }] };
        assert.deepEqual(speakerNames(ctx), { userName: '阿强', charName: '贝翠丝' });
    });

    test('角色卡没名字时回落 name2', () => {
        const ctx = { name1: '阿强', name2: '备用名', characterId: 0, characters: [{ name: '   ' }] };
        assert.deepEqual(speakerNames(ctx), { userName: '阿强', charName: '备用名' });
    });

    test('characterId 越界 / characters 不是数组 → 回落 name2', () => {
        assert.equal(speakerNames({ name2: '备用名', characterId: 5, characters: [] }).charName, '备用名');
        assert.equal(speakerNames({ name2: '备用名', characterId: -1, characters: [{ name: 'x' }] }).charName, '备用名');
        assert.equal(speakerNames({ name2: '备用名', characters: '不是数组' }).charName, '备用名');
    });

    test('上下文缺字段不崩，返回空串', () => {
        assert.deepEqual(speakerNames({}), { userName: '', charName: '' });
        assert.deepEqual(speakerNames(null), { userName: '', charName: '' });
        assert.deepEqual(speakerNames(undefined), { userName: '', charName: '' });
    });
});

describe('roleplayMessages —— 只留真正的角色扮演消息', () => {
    test('排除自家注入消息、空消息与脏数据', () => {
        const ctx = fakeCtx({
            chat: [
                { mes: '正文A' },
                injected('自家低语'),
                { mes: '   ' },
                null,
                { mes: '' },
                { mes: '正文B', is_user: true },
            ],
        });
        const out = roleplayMessages(ctx);
        assert.equal(out.length, 2);
        assert.deepEqual(out.map((m) => m.mes), ['正文A', '正文B']);
    });

    test('chat 不是数组 → 空数组', () => {
        assert.deepEqual(roleplayMessages({ chat: 42 }), []);
        assert.deepEqual(roleplayMessages(null), []);
    });
});

describe('buildGuideContext —— 场面快照组装', () => {
    test('插件自己注入的消息必须排除在场面之外（防自我强化复读）', () => {
        const ctx = fakeCtx({
            chat: [
                { mes: '契约者推开了旧城区的木门。', is_user: true },
                injected('【贝翠丝的低语】\n「旧城区的地下交易不太对劲」'),
                { mes: '门后是一条向下延伸的石阶。', is_user: false, name: '爱蜜莉雅' },
            ],
        });
        const out = buildGuideContext(ctx, defaultSettings(), {});
        assert.ok(!out.sceneText.includes('贝翠丝的低语'), `场面里混进了自家消息：${out.sceneText}`);
        assert.ok(!out.sceneText.includes('地下交易'), '注入的引导正文也不能漏进场面');
        assert.ok(out.sceneText.includes('旧城区的木门'));
        assert.ok(out.sceneText.includes('向下延伸的石阶'));
    });

    test('注入消息排在最后也不会被当成「最新 AI 正文」', () => {
        const ctx = fakeCtx({
            chat: [
                { mes: '石阶尽头有风。', is_user: false, name: '爱蜜莉雅' },
                injected('【贝翠丝的低语】\n「再往下走走看」'),
            ],
        });
        const out = buildGuideContext(ctx, defaultSettings(), {});
        assert.equal(out.lastAiText, '石阶尽头有风。');
        assert.equal(out.turnIndex, 1, '注入的隐藏消息不算一轮');
    });

    test('场面只取最后 8 条', () => {
        const chat = Array.from({ length: 10 }, (_, i) => ({ mes: `第${i}条`, is_user: i % 2 === 0, name: '甲' }));
        const out = buildGuideContext(fakeCtx({ chat }), defaultSettings(), {});
        assert.equal(out.sceneText.split('\n').length, 8);
        assert.ok(!out.sceneText.includes('第0条'));
        assert.ok(!out.sceneText.includes('第1条'));
        assert.ok(out.sceneText.includes('第2条'));
        assert.ok(out.sceneText.includes('第9条'));
    });

    test('场面单条按 220 字截断', () => {
        const chat = [{ mes: '啊'.repeat(500), is_user: false, name: '甲' }];
        const out = buildGuideContext(fakeCtx({ chat }), defaultSettings(), {});
        const body = out.sceneText.split('：').slice(1).join('：');
        assert.equal(body.length, 221, '220 字 + 一个省略号');
        assert.ok(body.endsWith('…'));
    });

    test('lastUserText 取最后一条用户消息，lastAiText 取最后一条正文', () => {
        const ctx = fakeCtx({
            chat: [
                { mes: '第一句用户', is_user: true },
                { mes: '第一段正文', is_user: false, name: '甲' },
                { mes: '第二句用户', is_user: true },
                { mes: '第二段正文', is_user: false, name: '甲' },
            ],
        });
        const out = buildGuideContext(ctx, defaultSettings(), {});
        assert.equal(out.lastUserText, '第二句用户');
        assert.equal(out.lastAiText, '第二段正文');
    });

    test('lastUserText / lastAiText 按各自上限截断（300 / 600）', () => {
        const ctx = fakeCtx({
            chat: [
                { mes: '用'.repeat(400), is_user: true },
                { mes: '正'.repeat(1000), is_user: false, name: '甲' },
            ],
        });
        const out = buildGuideContext(ctx, defaultSettings(), {});
        assert.equal(out.lastUserText.length, 301);
        assert.equal(out.lastAiText.length, 601);
    });

    test('没有可用消息时两个字段是空串', () => {
        const ctx = fakeCtx({ chat: [injected('自家消息'), { mes: '   ' }] });
        const out = buildGuideContext(ctx, defaultSettings(), {});
        assert.equal(out.lastUserText, '');
        assert.equal(out.lastAiText, '');
        assert.equal(out.sceneText, '');
    });

    test('别的插件注入的系统消息目前会进场面（契约只要求排除自家消息）', () => {
        const ctx = fakeCtx({ chat: [{ mes: '别的插件的提示', is_system: true }] });
        const out = buildGuideContext(ctx, defaultSettings(), {});
        assert.equal(out.sceneText, '同行者：别的插件的提示');
        assert.equal(out.lastAiText, '', '但它不算「最新 AI 正文」');
    });

    test('用户消息的作者名取 name1，缺了就写「契约者」', () => {
        const chat = [{ mes: '在。', is_user: true }];
        assert.equal(buildGuideContext(fakeCtx({ chat }), defaultSettings(), {}).sceneText, '契约者：在。');
        assert.equal(buildGuideContext(fakeCtx({ chat, name1: '阿强' }), defaultSettings(), {}).sceneText, '阿强：在。');
    });

    test('AI 消息的作者名取消息自身的 name，缺了就写「同行者」', () => {
        assert.equal(
            buildGuideContext(fakeCtx({ chat: [{ mes: '嗯。', is_user: false, name: '爱蜜莉雅' }] }), defaultSettings(), {}).sceneText,
            '爱蜜莉雅：嗯。',
        );
        assert.equal(
            buildGuideContext(fakeCtx({ chat: [{ mes: '嗯。', is_user: false }] }), defaultSettings(), {}).sceneText,
            '同行者：嗯。',
        );
    });

    test('recentSpoken 最多取最后 6 条', () => {
        const out = buildGuideContext(fakeCtx(), defaultSettings(), {
            recentSpoken: ['第1句', '第2句', '第3句', '第4句', '第5句', '第6句', '第7句'],
        });
        assert.deepEqual(out.recentSpoken, ['第2句', '第3句', '第4句', '第5句', '第6句', '第7句']);
    });

    test('recentSpoken 不是数组 → 空数组', () => {
        for (const bad of [undefined, null, '不是数组', 42]) {
            assert.deepEqual(buildGuideContext(fakeCtx(), defaultSettings(), { recentSpoken: bad }).recentSpoken, []);
        }
    });

    test('hooksText 从 extras 透传；不传时是空串', () => {
        const text = '[引导] 钟声：钟楼每晚敲十三下。';
        assert.equal(buildGuideContext(fakeCtx(), defaultSettings(), { hooksText: text }).hooksText, text);
        assert.equal(buildGuideContext(fakeCtx(), defaultSettings(), {}).hooksText, '');
        assert.equal(buildGuideContext(fakeCtx(), defaultSettings()).hooksText, '', 'extras 整个不传也要能跑');
        assert.equal(buildGuideContext(fakeCtx(), defaultSettings(), { hooksText: null }).hooksText, '');
    });

    test('hooks 原样透传，非数组时退回空数组', () => {
        const hooks = [{ label: '钟声' }];
        assert.equal(buildGuideContext(fakeCtx(), defaultSettings(), { hooks }).hooks, hooks);
        assert.deepEqual(buildGuideContext(fakeCtx(), defaultSettings(), { hooks: 'x' }).hooks, []);
    });

    test('userName / charName 随 ctx 走', () => {
        const ctx = { ...fakeCtx(), name1: '阿强', characters: [{ name: '贝翠丝' }], characterId: 0 };
        const out = buildGuideContext(ctx, defaultSettings(), {});
        assert.equal(out.userName, '阿强');
        assert.equal(out.charName, '贝翠丝');
    });

    test('chat 不是数组时不崩，契约里的字段一个都不少', () => {
        for (const bad of [{}, { chat: '不是数组' }, { chat: null }, null, undefined]) {
            const out = buildGuideContext(bad, defaultSettings(), {});
            assert.deepEqual(Object.keys(out).sort(), [
                'charName',
                'hooks',
                'hooksText',
                'lastAiText',
                'lastUserText',
                'locatedPhase',
                'recentSpoken',
                'sceneText',
                'turnIndex',
                'userName',
            ]);
            assert.equal(out.sceneText, '');
            assert.equal(out.lastAiText, '');
            assert.equal(out.turnIndex, 0);
            assert.equal(out.userName, '');
        }
    });

    test('settings 参数当前没被用到，传 undefined 也能跑', () => {
        const out = buildGuideContext(fakeCtx({ chat: [{ mes: '嗯。', is_user: false }] }), undefined, {});
        assert.equal(out.sceneText, '同行者：嗯。');
    });
});
