/**
 * 注入层（把引导落成聊天里的一条消息）的测试。
 *
 * 为什么这些用例值得存在：
 *  - 注入要**同时**做两件事：`ctx.chat.push()` 进数据 + `ctx.addOneMessage()` 渲染楼层。
 *    只做前者 → 当前页面看不到（用户以为插件没反应）；只做后者 → 刷新后消息消失。
 *    本机实测踩过这个坑，所以两条都要分别断言「被调用过」，还要断言拿到的是同一条消息。
 *  - 反过来，渲染失败**不能**算整次注入失败：数据已经在内存里了，刷新就能看到。
 *    把它判成失败会让上层记一条假错误、还可能重试造成重复注入。
 *  - 注入消息的形状必须带 `is_system: true`（隐藏、不发给 LLM）和自家标记
 *    （`extra.beatriceGuide.injected`）。少了标记就会「注入 → 触发引导 → 再注入」无限回环。
 *  - `injection.maxChars` 是气泡/楼层的长度硬约束，超长时的取舍顺序
 *    （先砍吐槽、再硬截引导）直接决定用户看到的是「一句完整暗示」还是「半截话」。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import { buildInjectionText, countInjected, injectGuidance, isOwnInjectedMessage } from '../src/inject.js';
import { defaultSettings } from '../src/config.js';

/** 造一份设置，只关心注入相关的参数。 */
function settingsWith({ mode = 'appended', maxChars = 600, speakerName = '贝翠丝', isSmallSys = true } = {}) {
    const s = defaultSettings();
    s.injection.mode = mode;
    s.injection.maxChars = maxChars;
    s.injection.speakerName = speakerName;
    s.injection.isSmallSys = isSmallSys;
    return s;
}

/** 插件自己注入的消息（形状见 CONTRACTS §5）。 */
function injectedMessage(mes = '自家低语') {
    return { name: '贝翠丝', is_user: false, is_system: true, mes, extra: { beatriceGuide: { injected: true } } };
}

/** 造一个假 ctx，并记录 addOneMessage / saveChat 的调用次数。 */
function fakeCtx({ chat = [], addOneMessage, saveChat } = {}) {
    const calls = { added: /** @type {Array<{msg: any, opts: any}>} */ ([]), saved: 0 };
    const ctx = {
        chat,
        addOneMessage: addOneMessage ?? (async (msg, opts) => { calls.added.push({ msg, opts }); }),
        saveChat: saveChat ?? (async () => { calls.saved++; }),
    };
    return { ctx, calls };
}

/**
 * 临时接管 console.warn。
 * 注入的失败路径会打警告 —— 既不想让它污染测试输出，也想顺便断言「真的警告了」。
 */
async function captureWarn(fn) {
    const original = console.warn;
    /** @type {string[]} */
    const lines = [];
    console.warn = (...args) => { lines.push(args.map((a) => String(a)).join(' ')); };
    try {
        return { value: await fn(), lines };
    } finally {
        console.warn = original;
    }
}

describe('buildInjectionText —— 注入正文的三种形状', () => {
    test('只有 guidance', () => {
        assert.equal(
            buildInjectionText({ guidance: '街角的风向变了' }, settingsWith()),
            '【贝翠丝的低语】\n「街角的风向变了」',
        );
    });

    test('只有 commentary', () => {
        assert.equal(
            buildInjectionText({ commentary: '又走神了' }, settingsWith()),
            '【贝翠丝的低语】\n—— 贝翠丝：又走神了',
        );
    });

    test('两者都有', () => {
        assert.equal(
            buildInjectionText({ guidance: '街角的风向变了', commentary: '又走神了' }, settingsWith()),
            '【贝翠丝的低语】\n「街角的风向变了」\n—— 贝翠丝：又走神了',
        );
    });

    test('自定义称呼会同时出现在标题与落款里', () => {
        assert.equal(
            buildInjectionText({ guidance: '甲', commentary: '乙' }, settingsWith({ speakerName: '小碧' })),
            '【小碧的低语】\n「甲」\n—— 小碧：乙',
        );
    });

    test('称呼为空 / 全是空白 → 退回默认称呼', () => {
        for (const name of ['', '   ']) {
            assert.match(buildInjectionText({ guidance: '甲' }, settingsWith({ speakerName: name })), /^【贝翠丝的低语】/);
        }
    });

    test('两段都空 → 只留下标题（契约允许空串或只含标题）', () => {
        assert.equal(buildInjectionText({}, settingsWith()), '【贝翠丝的低语】');
        assert.equal(buildInjectionText(null, settingsWith()), '【贝翠丝的低语】');
    });

    test('纯空白内容视为空', () => {
        assert.equal(buildInjectionText({ guidance: '   ', commentary: '\n' }, settingsWith()), '【贝翠丝的低语】');
    });

    test('settings 缺失时用默认称呼与默认上限', () => {
        assert.equal(buildInjectionText({ guidance: '甲' }, undefined), '【贝翠丝的低语】\n「甲」');
    });
});

describe('buildInjectionText —— 超长时的取舍顺序', () => {
    test('优先砍 commentary，保留完整的 guidance', () => {
        const s = settingsWith({ maxChars: 60 });
        const guidance = '钟楼的钟声今晚会多敲三下，天亮前最好去看一眼';
        const commentary = '你居然还没注意到这件事，真是迟钝得可以，我都不想说了';
        const lean = `【贝翠丝的低语】\n「${guidance}」`;
        const full = `${lean}\n—— 贝翠丝：${commentary}`;
        assert.ok(full.length > 60, `用例前提：完整版必须超上限（实际 ${full.length}）`);
        assert.ok(lean.length <= 60, `用例前提：砍掉吐槽后必须装得下（实际 ${lean.length}）`);

        const text = buildInjectionText({ guidance, commentary }, s);
        assert.equal(text, lean);
        assert.ok(text.includes(guidance), `guidance 被弄丢了：${text}`);
        assert.ok(!text.includes(commentary), `commentary 应该被优先舍弃：${text}`);
        assert.ok(!text.includes('——'), '落款也要一起去掉');
        assert.ok(text.length <= 60, `实际 ${text.length}`);
    });

    test('砍掉吐槽后仍然超长 → 硬截 guidance，长度不超过 maxChars', () => {
        const s = settingsWith({ maxChars: 60 });
        const text = buildInjectionText({ guidance: '一'.repeat(300), commentary: '吐槽' }, s);
        assert.equal(text.length, 60, `实际 ${text.length}：${text}`);
        assert.ok(text.startsWith('【贝翠丝的低语】\n「'));
        assert.ok(text.endsWith('…」'), '硬截要留省略号');
    });

    test('上限被夹到最小值 60 时：刚好装得下的 guidance 完整保留，装不下的吐槽先走', () => {
        const s = settingsWith({ maxChars: 60 });
        // 标题 8 + 换行 1 + 「 1 + 」 1 = 11，所以 49 字的 guidance 正好占满 60
        const guidance = '一'.repeat(49);
        const text = buildInjectionText({ guidance, commentary: '二'.repeat(40) }, s);
        assert.equal(text.length, 60);
        assert.ok(text.includes(guidance), '正好装得下的 guidance 必须完整保留');
        assert.ok(!text.includes('二'), '装不下的是吐槽');
    });

    test('上限极小时会溢出（至少给 20 字预算的保护）—— 断言实际长度', () => {
        const s = settingsWith({ maxChars: 25 });
        const text = buildInjectionText({ guidance: '一'.repeat(300) }, s);
        // budget = max(20, 25 - 8 - 4) = 20 → 8(标题) + 1(换行) + 1(「) + 21(20字+省略号) + 1(」) = 32
        assert.equal(text.length, 32, `实际 ${text.length}：${text}`);
        // 注意：normalizeSettings 会把 injection.maxChars 夹到 >= 60，
        // 所以这个溢出只在「未经归一化的设置」下出现（例如直接构造 settings 调用本函数）。
    });

    test('guidance 为空而吐槽超长时，把吐槽硬截下来（不留空引用块、也不整段丢弃）', () => {
        const s = settingsWith({ maxChars: 60 });
        const commentary = '你居然到现在都还没注意到钟楼上那面钟的异常，真是迟钝得让我无话可说，我本来都懒得出声提醒你了，哼';
        // 用例前提：连「只有吐槽」这一档都装不下 —— 这才是触发硬截的条件
        //（判断依据是 **渲染后的文本**，不是原始字符串长度）
        const onlyForm = `【贝翠丝的低语】\n—— 贝翠丝：${commentary}`;
        assert.ok(onlyForm.length > 60, `用例前提：只有吐槽也超上限（实际 ${onlyForm.length}）`);

        const text = buildInjectionText({ commentary }, s);

        // 期望：吐槽是这次**唯一**的内容，砍不掉就该硬截它。
        // 缺陷版本的表现：lean 分支只认 guidance，guidance 为空时直接落到硬截分支，
        // 吐出「【贝翠丝的低语】\n「」」—— 吐槽没了，只剩一个空引用块。
        assert.ok(!text.includes('「」'), `不该出现空的引用块：${text}`);
        assert.ok(text.length <= 60, `实际 ${text.length}：${text}`);
        assert.ok(text.includes(commentary.slice(0, 20)), `至少保留吐槽开头：${text}`);
        assert.ok(text.endsWith('…'), `硬截要留省略号：${text}`);
        assert.ok(text.includes('—— 贝翠丝：'), `只有吐槽时也要有落款：${text}`);
    });
});

describe('isOwnInjectedMessage —— 防回环标记', () => {
    test('命中自家标记判真', () => {
        const ctx = { chat: [{ mes: '普通' }, injectedMessage()] };
        assert.equal(isOwnInjectedMessage(ctx, 1), true);
    });

    test('相邻楼层判假（只认带标记的那一条）', () => {
        const ctx = { chat: [{ mes: '前一条' }, injectedMessage(), { mes: '后一条' }] };
        assert.equal(isOwnInjectedMessage(ctx, 0), false);
        assert.equal(isOwnInjectedMessage(ctx, 1), true);
        assert.equal(isOwnInjectedMessage(ctx, 2), false);
    });

    test('别的插件 / 别的字段的标记判假', () => {
        const ctx = {
            chat: [
                { mes: 'x', extra: { otherPlugin: { injected: true } } },
                { mes: 'y', extra: { beatriceGuide: {} } },
                { mes: 'z', extra: { beatriceGuide: { injected: false } } },
            ],
        };
        assert.equal(isOwnInjectedMessage(ctx, 0), false);
        assert.equal(isOwnInjectedMessage(ctx, 1), false);
        assert.equal(isOwnInjectedMessage(ctx, 2), false);
    });

    test('下标越界 / 负数 / 非数字 → 判假，不崩', () => {
        const ctx = { chat: [{ mes: '普通' }, injectedMessage()] };
        for (const bad of [-1, 2, 99, 1.5, NaN, Infinity, undefined, 'abc', {}]) {
            assert.equal(isOwnInjectedMessage(ctx, bad), false, `下标 ${String(bad)}`);
        }
    });

    test('字符串下标能识别（宿主有时会传字符串）', () => {
        assert.equal(isOwnInjectedMessage({ chat: [{ mes: '普通' }, injectedMessage()] }, '1'), true);
    });

    test('null 下标会被当成 0（Number(null) === 0）—— 记录现状，真实调用点只会传数字', () => {
        assert.equal(isOwnInjectedMessage({ chat: [injectedMessage()] }, null), true);
    });

    test('chat 不是数组 → 判假，不崩', () => {
        assert.equal(isOwnInjectedMessage({ chat: '不是数组' }, 0), false);
        assert.equal(isOwnInjectedMessage({}, 0), false);
        assert.equal(isOwnInjectedMessage(null, 0), false);
        assert.equal(isOwnInjectedMessage(undefined, 0), false);
    });
});

describe('injectGuidance —— 成功路径必须同时做两件事', () => {
    test('数据进 chat + 渲染楼层 + 落盘，三件都做', async () => {
        const { ctx, calls } = fakeCtx();
        const result = { guidance: '街角的风向变了', commentary: '又走神了', emotion: 'smug', hooks_used: ['旧城区'] };
        const r = await injectGuidance(ctx, result, settingsWith());

        assert.equal(r.ok, true);
        assert.equal(ctx.chat.length, 1, '没做 chat.push → 刷新后消息会消失');
        assert.equal(calls.added.length, 1, '没做 addOneMessage → 当前页面看不到');
        assert.equal(calls.added[0].msg, ctx.chat[0], '渲染的必须是刚推入的那一条');
        assert.equal(calls.saved, 1, '还要落盘');
        assert.equal(r.text, ctx.chat[0].mes);
    });

    test('渲染时带上 isSmallSys 选项（跟随设置）', async () => {
        const a = fakeCtx();
        await injectGuidance(a.ctx, { guidance: '甲' }, settingsWith({ isSmallSys: false }));
        assert.deepEqual(a.calls.added[0].opts, { isSmallSys: false });

        const b = fakeCtx();
        await injectGuidance(b.ctx, { guidance: '甲' }, settingsWith());
        assert.deepEqual(b.calls.added[0].opts, { isSmallSys: true });
    });

    test('注入消息的形状符合契约 §5', async () => {
        const { ctx } = fakeCtx();
        const before = Date.now();
        const r = await injectGuidance(
            ctx,
            { guidance: '甲', emotion: 'smug', hooks_used: ['钟声'] },
            settingsWith(),
            { reason: '每 2 轮' },
        );

        const msg = ctx.chat[0];
        assert.equal(msg, r.message);
        assert.equal(msg.is_user, false);
        assert.equal(msg.is_system, true, 'is_system:true 才会隐藏且不发给 LLM');
        assert.equal(msg.name, '贝翠丝');
        assert.equal(msg.mes, r.text);
        assert.equal(msg.swipes.length, 1);
        assert.equal(msg.swipes[0], r.text);
        assert.equal(msg.swipe_id, 0);
        assert.equal(msg.extra.beatriceGuide.injected, true, '少了这个标记就会无限回环');
        assert.ok(msg.extra.beatriceGuide.at >= before);
        assert.equal(msg.extra.beatriceGuide.emotion, 'smug');
        assert.deepEqual(msg.extra.beatriceGuide.hooksUsed, ['钟声']);
        assert.equal(msg.extra.beatriceGuide.reason, '每 2 轮');
    });

    test('reason 省略时是空串，emotion 缺失时是 calm', async () => {
        const { ctx } = fakeCtx();
        await injectGuidance(ctx, { guidance: '甲' }, settingsWith());
        assert.equal(ctx.chat[0].extra.beatriceGuide.reason, '');
        assert.equal(ctx.chat[0].extra.beatriceGuide.emotion, 'calm');
    });

    test('hooksUsed 最多留 12 条', async () => {
        const { ctx } = fakeCtx();
        await injectGuidance(ctx, { guidance: '甲', hooks_used: Array.from({ length: 20 }, (_, i) => `h${i}`) }, settingsWith());
        assert.equal(ctx.chat[0].extra.beatriceGuide.hooksUsed.length, 12);
    });

    test('自定义称呼进消息的 name 字段与正文', async () => {
        const { ctx } = fakeCtx();
        await injectGuidance(ctx, { guidance: '甲' }, settingsWith({ speakerName: '小碧' }));
        assert.equal(ctx.chat[0].name, '小碧');
        assert.match(ctx.chat[0].mes, /^【小碧的低语】/);
    });

    test('注入的消息本身能被 isOwnInjectedMessage 认出来（闭环）', async () => {
        const { ctx } = fakeCtx();
        await injectGuidance(ctx, { guidance: '甲' }, settingsWith());
        assert.equal(isOwnInjectedMessage(ctx, 0), true);
        assert.equal(countInjected(ctx), 1);
    });
});

describe('injectGuidance —— 关闭与失败路径', () => {
    test('mode:off → ok:false，且一条消息都不推', async () => {
        const { ctx, calls } = fakeCtx();
        const r = await injectGuidance(ctx, { guidance: '甲' }, settingsWith({ mode: 'off' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /关闭/);
        assert.equal(ctx.chat.length, 0);
        assert.equal(calls.added.length, 0);
        assert.equal(calls.saved, 0);
    });

    test('没有内容可注入时不该往聊天里塞一条空消息', async () => {
        const { ctx, calls } = fakeCtx();
        const r = await injectGuidance(ctx, { guidance: '', commentary: '' }, settingsWith());
        // 期望：判失败。injectGuidance 里本来就有「没有可注入的内容 → ok:false」这道闸，
        // 但 buildInjectionText 永远至少返回一个标题，所以那道闸是死代码，
        // 结果是往用户的聊天记录里推了一条只有【贝翠丝的低语】的空楼层。
        assert.equal(r.ok, false, `实际推入了：${JSON.stringify(ctx.chat[0])}`);
        assert.equal(ctx.chat.length, 0);
        assert.equal(calls.added.length, 0);
    });

    test('addOneMessage 抛异常 → 仍返回 ok:true（数据已进，渲染失败不致命）', async () => {
        const { ctx, calls } = fakeCtx({
            addOneMessage: async () => { throw new Error('DOM 挂了'); },
        });
        const { value: r, lines } = await captureWarn(() => injectGuidance(ctx, { guidance: '甲' }, settingsWith()));

        assert.equal(r.ok, true, '渲染失败不能把整次注入判失败');
        assert.equal(ctx.chat.length, 1, '数据必须已经在 chat 里');
        assert.equal(calls.saved, 1, '落盘不该被渲染失败带崩');
        assert.ok(lines.some((l) => l.includes('渲染注入消息失败')), `没有打警告：${lines.join(' | ')}`);
    });

    test('saveChat 抛异常（群聊场景）→ 不导致整体失败', async () => {
        const { ctx, calls } = fakeCtx({
            saveChat: async () => { throw new Error('群聊不支持 saveChat'); },
        });
        const { value: r, lines } = await captureWarn(() => injectGuidance(ctx, { guidance: '甲' }, settingsWith()));

        assert.equal(r.ok, true);
        assert.equal(ctx.chat.length, 1);
        assert.equal(calls.added.length, 1);
        assert.ok(lines.some((l) => l.includes('saveChat 失败')), `没有打警告：${lines.join(' | ')}`);
    });

    test('宿主没有 addOneMessage / saveChat 时不崩（数据仍进 chat）', async () => {
        const ctx = { chat: [] };
        const r = await injectGuidance(ctx, { guidance: '甲' }, settingsWith());
        assert.equal(r.ok, true);
        assert.equal(ctx.chat.length, 1);
    });

    test('chat 不是数组 → ok:false，不崩', async () => {
        for (const bad of [{}, { chat: '不是数组' }, { chat: null }, null, undefined]) {
            const r = await injectGuidance(bad, { guidance: '甲' }, settingsWith());
            assert.equal(r.ok, false, `输入 ${JSON.stringify(bad)}`);
            assert.match(r.error, /没有可写入的聊天/);
        }
    });

    test('chat 被冻结（push 抛错）→ ok:false 且带出真实原因，不往外抛', async () => {
        const ctx = { chat: Object.freeze([]) };
        const r = await injectGuidance(ctx, { guidance: '甲' }, settingsWith());
        assert.equal(r.ok, false);
        assert.ok(r.error, '必须把真实原因带出来');
    });
});

describe('countInjected —— 统计已注入条数', () => {
    test('只数带自家标记的', () => {
        const ctx = {
            chat: [
                injectedMessage(),
                { mes: '普通 AI 消息' },
                injectedMessage('第二条'),
                { mes: '别的插件', extra: { otherPlugin: { injected: true } } },
                { mes: '显式 false', extra: { beatriceGuide: { injected: false } } },
            ],
        };
        assert.equal(countInjected(ctx), 2);
    });

    test('空聊天 = 0', () => {
        assert.equal(countInjected({ chat: [] }), 0);
    });

    test('脏数据不崩', () => {
        assert.equal(countInjected({ chat: [null, undefined, 0, 'x', {}] }), 0);
        assert.equal(countInjected({}), 0);
        assert.equal(countInjected({ chat: '不是数组' }), 0);
        assert.equal(countInjected(null), 0);
        assert.equal(countInjected(undefined), 0);
    });
});
