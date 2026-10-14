/**
 * 「异步结果回来时世界已经变了」的竞态测试。
 *
 * ── 为什么需要这一组
 *
 * 通读世界书、请求辅助 API 都要几秒到几十秒。用户在这期间完全可以
 * 切卡、切聊天、或者干脆自己去「线索池」栏把 AI 挑错的条目改掉。
 *
 * 原来的代码在**请求发出后**才用 `this.ctx` 写库 / 注入 —— 而 `this.ctx`
 * 是个活引用，指向的已经是**另一个**卡 / 另一个聊天了。后果都是静默的：
 *
 *   · A 卡的通读结果写进 B 卡的池子 → 她引用的世界观整本就是错的
 *   · 引导被接到另一个聊天的正文末尾 → 用户以为是模型写坏了
 *   · 后台重读覆盖掉用户刚手工修好的池子 → 「我改的东西自己变回去了」
 *
 * 这三件事都**不会报错**，只会在很久以后表现为「她说话不对味」。
 * 所以必须有断言钉住。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import {
    chatKey,
    identitySnapshot,
    identityStillValid,
    poolStamp,
    setCharacterPool,
} from '../src/core/store.js';

/** 造一个假 ctx。`store` 要由调用方共享（真实酒馆里 extensionSettings 是全局的）。 */
function makeCtx({ store = {}, avatar = 'emilia.png', name = '爱蜜莉雅', chatId = 'chat-1' } = {}) {
    return {
        characterId: 0,
        characters: [{ avatar, name, data: { extensions: { world: '我的世界书' } } }],
        chatMetadata: {},
        chatId,
        chat: [{ is_user: false, mes: '第一句话', send_date: '2026-10-12 10:00:00' }],
        extensionSettings: store,
        powerUserSettings: { world_info: { globalSelect: [] } },
    };
}

const HOOKS = [{ book: '书', uid: 1, label: '线索', content: '正文', kind: '线索', why: 'x' }];

describe('异步竞态：结果回来时世界已经变了', () => {
    test('⭐ 换了角色卡 → 指纹判定失效（不能把 A 的池子写进 B）', () => {
        const store = {};
        const before = identitySnapshot(makeCtx({ store, avatar: 'a.png' }));
        const after = identitySnapshot(makeCtx({ store, avatar: 'b.png' }));
        const v = identityStillValid(before, after);
        assert.equal(v.ok, false);
        assert.match(v.reason, /角色卡/);
    });

    test('⭐ 换了聊天 → 指纹判定失效（不能接到另一个聊天里）', () => {
        const store = {};
        const before = identitySnapshot(makeCtx({ store, chatId: 'chat-1' }));
        const after = identitySnapshot(makeCtx({ store, chatId: 'chat-2' }));
        const v = identityStillValid(before, after);
        assert.equal(v.ok, false);
        assert.match(v.reason, /聊天/);
    });

    test('⭐ 期间池子被手工改过 → 指纹判定失效（不能覆盖用户的修改）', () => {
        const store = {};
        const ctx = makeCtx({ store });
        const before = identitySnapshot(ctx);
        assert.equal(before.stamp, 0, '出发时还没有池子');

        // 用户在通读期间自己建/改了一个池子
        setCharacterPool(ctx, HOOKS, ['书'], { source: 'edited', editedAt: 123456 });

        const v = identityStillValid(before, identitySnapshot(ctx));
        assert.equal(v.ok, false);
        assert.match(v.reason, /线索池/);
    });

    test('⭐⭐ 出新消息不算「换了聊天」—— 否则每轮生成都会被自己拦掉', () => {
        // 这是最容易写错的一条：如果把「消息条数」算进聊天标识，
        // 正文一生成完条数就变了，插件会认为「换聊天了」而**永远不出声**。
        const store = {};
        const ctx = makeCtx({ store });
        const before = identitySnapshot(ctx);
        ctx.chat.push({ is_user: false, mes: '新生成的正文', send_date: '2026-10-12 10:01:00' });
        const after = identitySnapshot(ctx);
        assert.equal(after.chat, before.chat, '同一段对话的标识必须不变');
        assert.equal(identityStillValid(before, after).ok, true);
    });

    test('⭐⭐ 建池子本身不能把自己判成 drift（注入那条路必须传 stamp:false）', () => {
        // 人工确认会改变池子时间戳；注入路径不把时间戳变化误判为切卡/切聊天。
        // 写库前的默认检查仍必须拦住 drift；ensureHookPool 不再自动建池。
        const store = {};
        const ctx = makeCtx({ store });
        const before = identitySnapshot(ctx);
        setCharacterPool(ctx, HOOKS, ['书'], { source: 'ai' }); // 流程自己建的
        const after = identitySnapshot(ctx);

        assert.equal(identityStillValid(before, after).ok, false, '默认（写库前）应当拦住');
        assert.equal(
            identityStillValid(before, after, { stamp: false }).ok,
            true,
            '注入那条路不查 stamp，必须放行',
        );
    });

    test('什么都没变 → 放行', () => {
        const store = {};
        const ctx = makeCtx({ store });
        const before = identitySnapshot(ctx);
        assert.equal(identityStillValid(before, identitySnapshot(ctx)).ok, true);
    });

    test('拿不到聊天标识时一律放行（不能因为宿主不提供 chatId 就彻底不工作）', () => {
        const store = {};
        const a = { characterId: 0, characters: [{ avatar: 'a.png' }], extensionSettings: store };
        const b = { characterId: 0, characters: [{ avatar: 'a.png' }], extensionSettings: store };
        assert.equal(chatKey(a), '');
        assert.equal(identityStillValid(identitySnapshot(a), identitySnapshot(b)).ok, true);
    });

    test('chatId 变了就认得出，不依赖消息内容', () => {
        const store = {};
        const a = makeCtx({ store, chatId: 'a' });
        const b = makeCtx({ store, chatId: 'b' });
        assert.notEqual(chatKey(a), chatKey(b));
    });

    test('没有 chatId 时用第一条消息认聊天（换个聊天要能认出来）', () => {
        const store = {};
        const mk = (head) => ({
            characterId: 0,
            characters: [{ avatar: 'a.png' }],
            extensionSettings: store,
            chat: [{ send_date: head, mes: 'x' }],
        });
        assert.notEqual(chatKey(mk('2026-01-01')), chatKey(mk('2026-02-02')));
        assert.equal(chatKey(mk('2026-01-01')), chatKey(mk('2026-01-01')));
    });

    test('poolStamp：没有池子是 0，编辑过的时间戳优先于建立时间', () => {
        const store = {};
        const ctx = makeCtx({ store });
        assert.equal(poolStamp(ctx), 0);
        setCharacterPool(ctx, HOOKS, ['书'], { at: 1000 });
        assert.equal(poolStamp(ctx), 1000);
        setCharacterPool(ctx, HOOKS, ['书'], { at: 1000, editedAt: 2000 });
        assert.equal(poolStamp(ctx), 2000);
    });

    test('指纹函数不抛异常（ctx 残缺也不能崩）', () => {
        for (const bad of [null, undefined, {}, { characters: null }, { characterId: 'x' }]) {
            assert.doesNotThrow(() => identitySnapshot(bad));
            assert.doesNotThrow(() => chatKey(bad));
            assert.doesNotThrow(() => poolStamp(bad));
        }
        assert.equal(identityStillValid(null, undefined).ok, true);
    });
});
