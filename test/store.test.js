/**
 * 持久化层（store）的测试。
 *
 * 为什么这些用例值得存在：
 *  - 两类数据的落点是分开的：设置跨聊天共享（`extensionSettings`），
 *    去重记忆跟聊天走（`chatMetadata`）。放错了的表现很隐蔽 ——
 *    「换张卡还在念叨上一条剧情线的引导」，用户只会觉得插件疯了。
 *  - `getSettings` 的补全结果**必须就地写回**容器：不写回的话，设置面板渲染的是
 *    补全后的默认值（每 2 轮），实际生效的却是缺字段被当成 0 的值（永不触发），
 *    这种「面板显示的和实际跑的不一样」是最难查的一类 bug。
 *  - 落盘路径全是「本机实测踩过的坑」：群聊里 `saveChat()` 会抛、`saveMetadata()`
 *    才是安全的、`saveChat()` 还会静默吞错。所以每个失败分支都要有用例，
 *    而且断言的是「返回什么」而不是「抛不抛」—— 这一层绝不允许把异常漏给上层。
 *  - 去重记忆有 200 条上限：长聊天里它会被写进 chatMetadata，不封顶会把存档撑大。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import {
    DATA_VERSION,
    blankChatData,
    exportAll,
    getChatData,
    getSettings,
    importAll,
    rememberSpoken,
    resetChatData,
    saveChatData,
    saveSettings,
} from '../src/core/store.js';
import { CHAT_KEY, EXT_ID, SETTINGS_KEY } from '../src/config.js';

/** 造一个假 ctx（带空白容器）。 */
function fakeCtx(overrides = {}) {
    return { extensionSettings: {}, chatMetadata: {}, ...overrides };
}

/** 造一个假 ctx，并统计各个落盘函数的调用次数。 */
function trackedCtx() {
    const calls = { metadata: 0, chat: 0, debounced: 0, settings: 0 };
    const ctx = {
        extensionSettings: {},
        chatMetadata: {},
        saveMetadata: async () => { calls.metadata++; },
        saveChat: async () => { calls.chat++; },
        saveSettingsDebounced: async () => { calls.debounced++; },
        saveSettings: async () => { calls.settings++; },
    };
    return { ctx, calls };
}

/** 临时接管 console.warn：既不污染测试输出，也能断言「真的警告了」。 */
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

describe('getSettings —— 补全 + 就地写回', () => {
    test('extensionSettings 不存在时会被创建', () => {
        const ctx = {};
        const s = getSettings(ctx);
        assert.ok(ctx.extensionSettings, 'ctx.extensionSettings 应该被创建出来');
        assert.equal(ctx.extensionSettings[SETTINGS_KEY], s);
    });

    test('extensionSettings 是 null 时会被就地替换成对象', () => {
        const ctx = { extensionSettings: null };
        const s = getSettings(ctx);
        assert.equal(typeof ctx.extensionSettings, 'object');
        assert.equal(ctx.extensionSettings[SETTINGS_KEY], s);
    });

    test('多次调用返回同一个引用（就地写回，不是每次新建）', () => {
        const ctx = fakeCtx();
        const a = getSettings(ctx);
        const b = getSettings(ctx);
        assert.equal(a, b);
        assert.equal(ctx.extensionSettings[SETTINGS_KEY], a);
    });

    test('缺字段被补全（老配置升级路径）', () => {
        const ctx = fakeCtx();
        ctx.extensionSettings[SETTINGS_KEY] = { cadence: { everyN: 5 } };
        const s = getSettings(ctx);
        assert.equal(s.cadence.everyN, 5, '用户填的值要保留');
        assert.equal(s.cadence.probability, 0.5, '缺的字段要补默认');
        assert.equal(s.guidance.maxChars, 60);
        assert.equal(s.injection.speakerName, '贝翠丝');
        assert.deepEqual(s.ui.avatarPos, { x: 24, y: 220 });
    });

    test('返回值已经过归一化（越界值夹回、非法枚举退回默认）', () => {
        const ctx = fakeCtx();
        ctx.extensionSettings[SETTINGS_KEY] = { cadence: { everyN: 999 }, llm: { mode: '乱写' } };
        const s = getSettings(ctx);
        assert.equal(s.cadence.everyN, 20);
        assert.equal(s.llm.mode, 'profile');
    });

    test('写回容器的是补全后的同一个对象（面板读到的就是生效值）', () => {
        const ctx = fakeCtx();
        const s = getSettings(ctx);
        assert.equal(ctx.extensionSettings[SETTINGS_KEY], s);
        assert.equal(ctx.extensionSettings[SETTINGS_KEY].guidance.maxChars, 60);
    });

    test('多余字段保留（前向兼容）', () => {
        const ctx = fakeCtx();
        ctx.extensionSettings[SETTINGS_KEY] = { 未来字段: 1, cadence: { 未来: 2 } };
        const s = getSettings(ctx);
        assert.equal(s.未来字段, 1);
        assert.equal(s.cadence.未来, 2);
    });

    test('ctx 为 null / undefined → 返回一份可用的默认设置，而不是抛错', () => {
        for (const bad of [null, undefined]) {
            const s = getSettings(bad);
            assert.equal(s.enabled, true);
            assert.equal(s.cadence.everyN, 2);
            assert.equal(s.guidance.maxChars, 60);
            // tags 默认空 = 不按标签过滤，由 AI 判断全部条目（见 config.js 的说明）
            assert.deepEqual(s.worldbook.tags, []);
        }
    });

    test('连 extensionSettings 都写不进去时也不崩（极端宿主）', () => {
        // 冻结对象上赋值在严格模式会抛 TypeError，ensureExtensionSettingsContainer 会吃掉它
        const s = getSettings(Object.freeze({}));
        assert.equal(s.guidance.maxChars, 60);
        assert.equal(s.enabled, true);
    });
});

describe('getChatData —— 聊天私有数据', () => {
    test('chatMetadata 为空时返回空白结构，字段齐全', () => {
        const data = getChatData(fakeCtx());
        assert.equal(data.dataVersion, DATA_VERSION);
        assert.deepEqual(data.spoken, []);
        assert.deepEqual(data.guidedTurns, []);
        assert.equal(data.turnCounter, 0);
        assert.equal(data.lastAt, 0);
        assert.ok(data.createdAt > 0);
        assert.ok(data.updatedAt > 0);
    });

    test('已有数据被合并进来（缺的字段才补默认）', () => {
        const ctx = fakeCtx();
        ctx.chatMetadata[CHAT_KEY] = { spoken: ['甲'], turnCounter: 3, lastAt: 123, createdAt: 1 };
        const data = getChatData(ctx);
        assert.deepEqual(data.spoken, ['甲']);
        assert.equal(data.turnCounter, 3);
        assert.equal(data.lastAt, 123);
        assert.equal(data.createdAt, 1, '已有的时间戳不该被空白结构覆盖');
    });

    test('数组字段被清洗：spoken 只留字符串，guidedTurns 只留数字', () => {
        const ctx = fakeCtx();
        ctx.chatMetadata[CHAT_KEY] = {
            spoken: ['甲', 5, null, '乙', {}, true],
            guidedTurns: [1, '2', 'x', NaN, 3.5],
        };
        const data = getChatData(ctx);
        assert.deepEqual(data.spoken, ['甲', '乙']);
        assert.deepEqual(data.guidedTurns, [1, 2, 3.5], '数字型字符串也认，非数字丢掉');
    });

    test('数字字段被强制成数字', () => {
        const ctx = fakeCtx();
        ctx.chatMetadata[CHAT_KEY] = { turnCounter: '3', lastAt: '99' };
        const data = getChatData(ctx);
        assert.equal(data.turnCounter, 3);
        assert.equal(data.lastAt, 99);

        const broken = fakeCtx();
        broken.chatMetadata[CHAT_KEY] = { turnCounter: '不是数字', lastAt: null };
        assert.equal(getChatData(broken).turnCounter, 0);
        assert.equal(getChatData(broken).lastAt, 0);
    });

    test('多余字段保留（前向兼容）', () => {
        const ctx = fakeCtx();
        ctx.chatMetadata[CHAT_KEY] = { 未来字段: 'x' };
        assert.equal(getChatData(ctx).未来字段, 'x');
    });

    test('永不返回 null：各种脏 ctx 都给一份空白结构', () => {
        for (const bad of [null, undefined, {}, { chatMetadata: null }, { chatMetadata: 'x' }, { chatMetadata: 42 }]) {
            const data = getChatData(bad);
            assert.ok(data && typeof data === 'object', `输入 ${JSON.stringify(bad)}`);
            assert.deepEqual(data.spoken, []);
            assert.deepEqual(data.guidedTurns, []);
            assert.equal(data.turnCounter, 0);
        }
    });

    test('chatMetadata[CHAT_KEY] 是垃圾值时退回空白结构', () => {
        for (const junk of ['字符串', 42, null, []]) {
            const ctx = fakeCtx();
            ctx.chatMetadata[CHAT_KEY] = junk;
            const data = getChatData(ctx);
            assert.deepEqual(data.spoken, [], `垃圾值 ${JSON.stringify(junk)}`);
            assert.equal(data.dataVersion, DATA_VERSION);
        }
    });
});

describe('saveChatData —— 落盘', () => {
    test('写进 ctx.chatMetadata 且优先调用 saveMetadata', async () => {
        const { ctx, calls } = trackedCtx();
        const data = blankChatData();
        const r = await saveChatData(ctx, data);
        assert.equal(r.ok, true);
        assert.equal(ctx.chatMetadata[CHAT_KEY], data, '数据必须写进 chatMetadata');
        assert.equal(calls.metadata, 1);
        assert.equal(calls.chat, 0, 'saveMetadata 成功就不该再调 saveChat');
    });

    test('updatedAt 会被刷新成当前时间', async () => {
        const { ctx } = trackedCtx();
        const data = blankChatData();
        data.updatedAt = 1;
        await saveChatData(ctx, data);
        assert.ok(data.updatedAt > 1);
    });

    test('saveMetadata 抛异常 → 回落 saveChat', async () => {
        const { ctx, calls } = trackedCtx();
        ctx.saveMetadata = async () => { throw new Error('元数据写不了'); };
        const { value: r, lines } = await captureWarn(() => saveChatData(ctx, blankChatData()));
        assert.equal(r.ok, true);
        assert.equal(calls.chat, 1);
        assert.ok(lines.some((l) => l.includes('回落 saveChat')), `没有打警告：${lines.join(' | ')}`);
    });

    test('saveMetadata 在但 saveChat 成功时也算 ok', async () => {
        const ctx = { chatMetadata: {}, saveChat: async () => {} };
        const r = await saveChatData(ctx, blankChatData());
        assert.equal(r.ok, true);
    });

    test('两个落盘函数都没有 → ok:false（带可读原因）', async () => {
        const ctx = { chatMetadata: {} };
        const r = await saveChatData(ctx, blankChatData());
        assert.equal(r.ok, false);
        assert.match(r.error, /saveMetadata \/ saveChat/);
    });

    test('两个都抛 → ok:false 且带出 saveChat 的真实错误', async () => {
        const ctx = {
            chatMetadata: {},
            saveMetadata: async () => { throw new Error('元数据错误'); },
            saveChat: async () => { throw new Error('聊天错误'); },
        };
        const { value: r } = await captureWarn(() => saveChatData(ctx, blankChatData()));
        assert.equal(r.ok, false);
        assert.match(r.error, /聊天错误/);
    });

    test('saveChat 静默吞错时只能保证「调用没抛」—— 记录契约边界', async () => {
        const ctx = { chatMetadata: {}, saveChat: async () => { /* 宿主自己吞掉 */ } };
        const r = await saveChatData(ctx, blankChatData());
        assert.equal(r.ok, true, 'ok 表示「调用没有抛异常」，不代表宿主真的写盘了（见 store.js 头注释）');
    });

    test('chatMetadata 缺失时不崩（数据只留在内存里）', async () => {
        const ctx = { saveMetadata: async () => {} };
        const r = await saveChatData(ctx, blankChatData());
        assert.equal(r.ok, true);
    });

    test('silent 时不打任何警告', async () => {
        const ctx = { chatMetadata: {}, saveMetadata: async () => { throw new Error('x'); } };
        const { lines } = await captureWarn(() => saveChatData(ctx, blankChatData(), { silent: true }));
        assert.deepEqual(lines, []);
    });
});

describe('rememberSpoken —— 去重记忆', () => {
    test('追加并去掉首尾空白', () => {
        const data = blankChatData();
        rememberSpoken(data, ['  甲  ', '乙']);
        assert.deepEqual(data.spoken, ['甲', '乙']);
    });

    test('跳过空串 / 纯空白 / null / undefined', () => {
        const data = blankChatData();
        rememberSpoken(data, ['', '   ', null, undefined, '甲']);
        assert.deepEqual(data.spoken, ['甲']);
    });

    test('逐次追加而不是覆盖', () => {
        const data = blankChatData();
        rememberSpoken(data, ['甲']);
        rememberSpoken(data, ['乙']);
        assert.deepEqual(data.spoken, ['甲', '乙']);
    });

    test('spoken 字段坏掉时会被重建', () => {
        const data = { spoken: '不是数组' };
        rememberSpoken(data, ['甲']);
        assert.deepEqual(data.spoken, ['甲']);
    });

    test('一次写入 205 条 → 只留最近的 200 条（内容也要对）', () => {
        const data = blankChatData();
        rememberSpoken(data, Array.from({ length: 205 }, (_, i) => `第${i + 1}句`));
        assert.equal(data.spoken.length, 200);
        assert.equal(data.spoken[0], '第6句', '丢掉的是最早的 5 条');
        assert.equal(data.spoken[199], '第205句');
    });

    test('多次调用累计超限时同样只留最近 200 条', () => {
        const data = blankChatData();
        for (let i = 0; i < 250; i++) rememberSpoken(data, [`第${i}句`]);
        assert.equal(data.spoken.length, 200);
        assert.equal(data.spoken[0], '第50句');
        assert.equal(data.spoken[199], '第249句');
    });

    test('数字项被字符串化（调用方传的是过滤后的字符串数组，这里只是兜底）', () => {
        const data = blankChatData();
        rememberSpoken(data, [42]);
        assert.deepEqual(data.spoken, ['42']);
    });
});

describe('resetChatData —— 清空记忆', () => {
    test('清空字段并保持同一个对象引用', () => {
        const data = blankChatData();
        data.spoken.push('甲');
        data.guidedTurns.push(2);
        data.turnCounter = 9;
        data.lastAt = 123;

        const out = resetChatData(data);
        assert.equal(out, data, '必须是同一个引用（调用方随后 saveChatData 它）');
        assert.deepEqual(data.spoken, []);
        assert.deepEqual(data.guidedTurns, []);
        assert.equal(data.turnCounter, 0);
        assert.equal(data.lastAt, 0);
        assert.equal(data.dataVersion, DATA_VERSION);
    });

    test('清空后落盘再读出来确实是空的（换聊天 / 手动重置的真实流程）', async () => {
        const ctx = fakeCtx();
        const data = getChatData(ctx);
        rememberSpoken(data, ['旧的一句']);
        data.turnCounter = 5;
        await saveChatData(ctx, data);
        assert.deepEqual(getChatData(ctx).spoken, ['旧的一句']);

        resetChatData(data);
        await saveChatData(ctx, data);
        const reloaded = getChatData(ctx);
        assert.deepEqual(reloaded.spoken, []);
        assert.equal(reloaded.turnCounter, 0);
    });

    test('不认得的键会留下（只清自己认识的字段）—— 记录现状', () => {
        const data = blankChatData();
        data.未来字段 = 'x';
        resetChatData(data);
        assert.equal(data.未来字段, 'x');
    });
});

describe('blankChatData —— 空白结构', () => {
    test('字段齐全', () => {
        assert.deepEqual(Object.keys(blankChatData()).sort(), [
            'createdAt',
            'dataVersion',
            'guidedTurns',
            'hookPool',
            'lastAt',
            'spoken',
            'turnCounter',
            'updatedAt',
        ]);
    });

    test('每次都是新对象，数组字段也不共享', () => {
        const a = blankChatData();
        const b = blankChatData();
        assert.notEqual(a, b);
        assert.notEqual(a.spoken, b.spoken);
        assert.notEqual(a.guidedTurns, b.guidedTurns);
        a.spoken.push('甲');
        assert.deepEqual(b.spoken, []);
    });
});

describe('saveSettings —— 落盘设置', () => {
    test('优先 saveSettingsDebounced', async () => {
        const { ctx, calls } = trackedCtx();
        const r = await saveSettings(ctx);
        assert.equal(r.ok, true);
        assert.equal(calls.debounced, 1);
        assert.equal(calls.settings, 0);
    });

    test('没有 saveSettingsDebounced 时回落 saveSettings', async () => {
        const { ctx, calls } = trackedCtx();
        delete ctx.saveSettingsDebounced;
        const r = await saveSettings(ctx);
        assert.equal(r.ok, true);
        assert.equal(calls.settings, 1);
    });

    test('两个都没有 → ok:false（带可读原因）', async () => {
        const r = await saveSettings({});
        assert.equal(r.ok, false);
        assert.match(r.error, /saveSettings/);
    });

    test('抛异常 → 返回 ok:false + error，绝不往外抛', async () => {
        const ctx = { saveSettingsDebounced: async () => { throw new Error('磁盘满了'); } };
        const { value: r } = await captureWarn(() => saveSettings(ctx, { silent: true }));
        assert.equal(r.ok, false);
        assert.match(r.error, /磁盘满了/);
    });

    test('默认不静默：失败时打一条警告', async () => {
        const ctx = { saveSettingsDebounced: async () => { throw new Error('磁盘满了'); } };
        const { lines } = await captureWarn(() => saveSettings(ctx));
        assert.ok(lines.some((l) => l.includes('保存设置失败')), `没有打警告：${lines.join(' | ')}`);
    });

    test('debounced 存在但抛错时不再回落 saveSettings（存在即用，不存在才回落）', async () => {
        const { ctx, calls } = trackedCtx();
        ctx.saveSettingsDebounced = async () => { throw new Error('甲'); };
        const { value: r } = await captureWarn(() => saveSettings(ctx, { silent: true }));
        assert.equal(r.ok, false);
        assert.equal(calls.settings, 0);
    });

    test('ctx 为 null → ok:false，不崩', async () => {
        const r = await saveSettings(null);
        assert.equal(r.ok, false);
        assert.ok(r.error);
    });
});

describe('人设提示词必须能真正保存下来（用户实测反馈的 bug）', () => {
    test('用户写进 persona.prompts 的条目，保存后重读必须还在', () => {
        // ── 这是一个真实事故的回归测试
        //
        // 用户在人设提示词编辑器里写好了设定，改完就没了。报障原话是
        // 「你这个人设提示词没设置保存啊」。
        //
        // 根因不在 UI，而在 `deepDefaults` 的 `coerce()`：它对「模板是空数组」
        // 的情况做了一件想当然的事 ——
        //     if (!template.length) return value.filter((v) => typeof v === 'string');
        // 也就是「空模板 = 只留字符串」。这个假设对 tags 那种字符串数组成立，
        // 但 `persona.prompts` 是**对象数组**、且默认值恰好是 `[]` ——
        // 于是用户写的每一条都在 `getSettings()` 补全时被静默滤掉。
        //
        // 教训：**空数组只说明「默认没有内容」，不说明元素类型是字符串。**
        const ctx = fakeCtx();

        // 第一次读：拿到默认设置
        const s1 = getSettings(ctx);
        assert.deepEqual(s1.persona.prompts, [], '默认应该是空数组（表示用内置人设）');

        // 用户编辑：写入两条自定义提示词
        s1.persona.prompts = [
            { id: 'p1', role: 'system', content: '你是住在契约者脑海里的精灵。', enabled: true },
            { id: 'p2', role: 'assistant', content: '哼，知道了。', enabled: false },
        ];

        // 第二次读：模拟「重开面板 / 刷新页面」后重新走一遍补全
        const s2 = getSettings(ctx);

        assert.equal(s2.persona.prompts.length, 2, `用户写的内容被吃掉了：${JSON.stringify(s2.persona.prompts)}`);
        assert.equal(s2.persona.prompts[0].content, '你是住在契约者脑海里的精灵。');
        assert.equal(s2.persona.prompts[0].role, 'system');
        assert.equal(s2.persona.prompts[1].role, 'assistant');
        assert.equal(s2.persona.prompts[1].enabled, false, '停用状态也要保住');
    });

    test('坏条目由 normalizePersonaPrompts 逐条清洗，而不是整份被清空', () => {
        const ctx = fakeCtx();
        const s = getSettings(ctx);
        s.persona.prompts = /** @type {any} */ ([
            { id: 'ok', role: 'system', content: '正常的一条', enabled: true },
            { id: 'empty', role: 'system', content: '   ', enabled: true },
            null,
            { id: 'badrole', role: '不存在的角色', content: '角色名非法', enabled: true },
            'string-instead-of-object',
        ]);

        const re = getSettings(ctx);
        const ids = re.persona.prompts.map((p) => p.id);
        assert.deepEqual(ids, ['ok', 'badrole'], `清洗结果不对：${JSON.stringify(ids)}`);
        assert.equal(re.persona.prompts[1].role, 'system', '非法角色该兜底成 system，而不是丢掉整条');
        assert.equal(re.persona.prompts[0].content, '正常的一条');
    });

    test('prompts 为空数组时仍然表示「用内置人设」（不能自作主张塞默认值）', () => {
        const ctx = fakeCtx();
        getSettings(ctx).persona.prompts = [];
        const re = getSettings(ctx);
        assert.deepEqual(re.persona.prompts, [], '空数组必须保持为空 —— 它和「有默认值」是两种不同状态');
    });

    test('prompts 不是数组（手改坏配置）→ 退回空数组，不崩', () => {
        const ctx = fakeCtx();
        const s = getSettings(ctx);
        for (const bad of ['字符串', 42, { a: 1 }, null]) {
            s.persona.prompts = /** @type {any} */ (bad);
            const re = getSettings(ctx);
            assert.deepEqual(re.persona.prompts, [], `坏输入 ${JSON.stringify(bad)} 应该退回空数组`);
        }
    });
});

describe('exportAll / importAll —— 配置往返', () => {
    test('导出结构：ext + 时间戳 + 设置 + 聊天数据', () => {
        const ctx = fakeCtx();
        const dump = exportAll(ctx);
        assert.equal(dump.ext, EXT_ID);
        assert.ok(!Number.isNaN(Date.parse(dump.exportedAt)), `时间戳不可解析：${dump.exportedAt}`);
        assert.deepEqual(dump.settings, getSettings(ctx));

        // ⚠️ 时间戳字段要排除掉再比较。
        // `getChatData` 在数据缺失时会现造一份 `blankChatData()`，而它的
        // `createdAt` / `updatedAt` 取的是 `Date.now()` —— 两次调用差 1 毫秒
        // 就会让 deepEqual 随机失败。这个测试原本就是这么挂的：
        // 表现成「偶发失败，重跑就好」，排查时很浪费时间。
        const strip = (/** @type {any} */ d) => {
            const { createdAt, updatedAt, ...rest } = d ?? {};
            return rest;
        };
        assert.deepEqual(strip(dump.chatData), strip(getChatData(ctx)));
        // 时间戳本身仍然要是个合理的时间
        assert.ok(Number.isFinite(dump.chatData.createdAt) && dump.chatData.createdAt > 0);
    });

    test('导出是深拷贝（改导出结果不会碰到运行中的数据）', () => {
        const ctx = fakeCtx();
        const dump = exportAll(ctx);
        dump.settings.cadence.everyN = 999;
        dump.chatData.spoken.push('污染');
        assert.equal(getSettings(ctx).cadence.everyN, 2);
        assert.deepEqual(getChatData(ctx).spoken, []);
    });

    test('往返一致：导出 → 导入到新 ctx → 设置与记忆都对得上', async () => {
        const source = fakeCtx();
        const s = getSettings(source);
        s.cadence.everyN = 7;
        s.worldbook.tags = ['引导', '自定标签'];
        s.ui.avatarPos = { x: 300, y: 400 };
        s.persona.overridePrompt = '你是贝翠丝';
        const data = getChatData(source);
        rememberSpoken(data, ['说过的一句']);
        data.turnCounter = 4;
        await saveChatData(source, data);

        const dump = exportAll(source);

        const target = fakeCtx();
        const r = importAll(target, dump);
        assert.equal(r.ok, true);
        assert.deepEqual(getSettings(target), dump.settings);
        assert.deepEqual(getChatData(target).spoken, ['说过的一句']);
        assert.equal(getChatData(target).turnCounter, 4);
    });

    test('坏 payload（null / undefined / 字符串 / 数字 / 布尔）→ ok:false，不抛', () => {
        for (const bad of [null, undefined, '配置文件', 42, true]) {
            const ctx = fakeCtx();
            const r = importAll(ctx, bad);
            assert.equal(r.ok, false, `输入 ${JSON.stringify(bad)}`);
            assert.ok(r.error);
        }
    });

    test('空对象 payload：不抛、也不改动任何东西', () => {
        const ctx = fakeCtx();
        const before = JSON.stringify(getSettings(ctx));
        const r = importAll(ctx, {});
        // 空对象被当成「没有要导入的段落」而返回 ok:true，但一个字段都没改 ——
        // 这里断言真正重要的那部分：导入空内容不会破坏现有配置。
        assert.equal(r.ok, true);
        assert.equal(JSON.stringify(getSettings(ctx)), before);
    });

    test('导入时越界值与非法枚举被归一化', () => {
        const ctx = fakeCtx();
        const r = importAll(ctx, {
            settings: { cadence: { everyN: 999, probability: 7 }, llm: { mode: '乱写的' }, guidance: { maxChars: -5 } },
        });
        assert.equal(r.ok, true);
        const s = getSettings(ctx);
        assert.equal(s.cadence.everyN, 20);
        assert.equal(s.cadence.probability, 1);
        assert.equal(s.llm.mode, 'profile');
        assert.equal(s.guidance.maxChars, 10);
    });

    test('导入时多余字段保留、缺失字段补默认', () => {
        const ctx = fakeCtx();
        importAll(ctx, { settings: { 未来字段: { a: 1 } } });
        const s = getSettings(ctx);
        assert.deepEqual(s.未来字段, { a: 1 });
        assert.equal(s.injection.maxChars, 600);
    });

    test('设置段类型全坏也不抛（cadence 是字符串、guidance 是数字、tags 不是数组）', () => {
        const ctx = fakeCtx();
        const r = importAll(ctx, { settings: { cadence: '坏掉了', guidance: 42, worldbook: { tags: '不是数组' } } });
        assert.equal(r.ok, true);
        const s = getSettings(ctx);
        assert.equal(s.cadence.everyN, 2);
        assert.equal(s.guidance.maxChars, 60);
        assert.deepEqual(s.worldbook.tags, [], '默认不按标签过滤');
    });

    test('导入的 chatData 会被读路径清洗（spoken 只留字符串、guidedTurns 只留数字）', () => {
        const ctx = fakeCtx();
        const r = importAll(ctx, { chatData: { spoken: ['甲', 5, {}], guidedTurns: [1, 'x'], turnCounter: '2' } });
        assert.equal(r.ok, true);
        // 注意：importAll 是直接把 payload.chatData 铺进 chatMetadata 的（没有当场清洗），
        // 但对外可见的读路径 getChatData 会清洗，所以这里断言的是用户能看到的结果。
        const data = getChatData(ctx);
        assert.deepEqual(data.spoken, ['甲']);
        assert.deepEqual(data.guidedTurns, [1]);
        assert.equal(data.turnCounter, 2);
    });

    test('拿不到 extensionSettings 的宿主 → ok:false 而不是崩', () => {
        const r = importAll(Object.freeze({}), { settings: {} });
        assert.equal(r.ok, false);
        assert.match(r.error, /extensionSettings/);
    });
});
