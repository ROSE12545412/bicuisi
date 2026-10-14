/**
 * 「线索池绑定角色卡」+「可查看可修改」的测试。
 *
 * ── 为什么需要这一组
 *
 * 用户提了两条要求：
 *   「应该在哪个卡建立的线索就绑定哪个卡，不能混乱」
 *   「最后建立的线索也应该可以查看修改，防止出错」
 *
 * 这两件事都有具体的失败模式，而且都是**静默**的：
 *   · 池子串到别的卡 → 引导用着另一个世界观的书，用户只觉得「她说话不对味」
 *   · AI 挑错条目 / 把名字改坏 → 用户只能整份重读，好的也一起丢
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import {
    characterKey,
    characterKeyInfo,
    characterName,
    clearCharacterPool,
    getCharacterPool,
    isCharacterPoolFresh,
    listCharacterPools,
    setCharacterPool,
} from '../src/core/store.js';
import { defaultSettings } from '../src/config.js';

/**
 * 造一个带角色卡的假 ctx。
 *
 * ⚠️ `extensionSettings` 必须**由调用方共享** —— 它在真实酒馆里是一个全局
 * 对象，所有角色卡共用一份。一开始这里每次都新建一个，于是「换卡不该串味」
 * 这种断言根本测不出来（两张卡各拿一份空设置，怎么测都是"没串"）。
 */
function makeCtx(opts = {}) {
    const {
        store = {},
        avatar = 'emilia.png',
        name = '爱蜜莉雅',
        chid = 0,
        chatMetadata = {},
    } = opts;

    /** @type {any[]} */
    const characters = [];
    characters[chid] = { avatar, name, data: { extensions: { world: '我的世界书' } } };

    return {
        characterId: chid,
        characters,
        chatMetadata,
        extensionSettings: store, // ← 共享同一份
        powerUserSettings: { world_info: { globalSelect: [] } },
    };
}

const HOOKS = [
    { book: '我的世界书', uid: 4, label: '旧城区的传言', content: '夜里有人搬箱子。', kind: '线索', why: 'x' },
    { book: '我的世界书', uid: 5, label: '卖花女人的眼神', content: '她看了你三次。', kind: '人物', why: 'y' },
];

describe('线索池绑定角色卡（用户要求「不能混乱」）', () => {
    test('⭐ 换个角色卡就读不到别人的池子', () => {
        // 这是最关键的断言。原设计里池子存在 chatMetadata（跟聊天走），
        // 只要书单碰巧一致就会串味。
        const store = {};
        const emilia = makeCtx({ store });
        setCharacterPool(emilia, HOOKS, ['我的世界书']);
        assert.equal(getCharacterPool(emilia)?.hooks.length, 2, '本卡的池子应该读得到');

        const rem = makeCtx({ store, chid: 1, avatar: 'rem.png', name: '雷姆' });
        assert.equal(getCharacterPool(rem), null, '❌ 串到别的卡了');
    });

    test('⭐ 同一张卡换聊天线 → 池子还在（这就是「跟卡走」）', () => {
        const store = {};
        const chatA = makeCtx({ store, chatMetadata: { chat_id: 'a' } });
        setCharacterPool(chatA, HOOKS, ['我的世界书']);

        const chatB = makeCtx({ store, chatMetadata: { chat_id: 'b' } });
        assert.equal(getCharacterPool(chatB)?.hooks.length, 2, '同一张卡换了聊天线，池子应该还在');
        assert.equal(isCharacterPoolFresh(chatB, defaultSettings(), ['我的世界书']), true);
    });

    test('角色标识优先用 avatar（最稳），没有才退回卡名', () => {
        assert.equal(characterKey(makeCtx({ avatar: 'emilia.png' })), 'avatar:emilia.png');
        assert.equal(characterKey(makeCtx({ avatar: '', name: '爱蜜莉雅', chid: 2 })), 'name:爱蜜莉雅#2');
        assert.equal(characterKey({ characterId: 0, characters: [{}] }), 'index:#0');
        assert.equal(characterKey({}), '');
        assert.equal(characterKey(null), '');
    });

    test('拿不到卡标识时 setCharacterPool 明确报错，而不是静默丢弃', () => {
        const res = setCharacterPool({}, HOOKS, ['书']);
        assert.equal(res.ok, false);
        assert.match(res.error, /角色卡标识/);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 用户实测报过：`建立失败：拿不到角色卡标识（可能还没选卡）`
    //
    // 他明明选着卡。原来那句「可能还没选卡」是**猜的** —— 猜错就把用户支到
    // 错的方向（去反复确认自己有没有选卡）。真正的原因是不同酒馆实现里
    // `getContext()` 的形状不一致：TauriTavern 就不保证给出
    // `characters[characterId]`。
    //
    // 所以下面这组钉两件事：① 有别的来源就用别的来源 ② 真没有时报错要说清试过什么
    // ─────────────────────────────────────────────────────────────────────

    test('⭐⭐ ctx 里没有 characters，但知道角色名 → 照样能建池（TauriTavern 实测形状）', () => {
        const store = {};
        // 典型症状：characterId 有、characters 没透出来
        const ctx = {
            characterId: 3,
            name2: '爱蜜莉雅',
            chatMetadata: {},
            extensionSettings: store,
        };

        const info = characterKeyInfo(ctx);
        assert.equal(info.key, 'name:爱蜜莉雅', `应该退到用角色名，实际：${JSON.stringify(info)}`);
        assert.match(info.source, /name2/, `要记下 key 是从哪来的，实际：${info.source}`);

        const res = setCharacterPool(ctx, HOOKS, ['我的世界书']);
        assert.equal(res.ok, true, `这条退路必须让功能可用，实际：${res.error}`);
        assert.equal(getCharacterPool(ctx, 'name:爱蜜莉雅')?.hooks.length, HOOKS.length, '池子要真的存进去了');
    });

    test('characterId 越界（卡被删了/列表换了）→ 退到角色名，而不是整条功能不可用', () => {
        const ctx = {
            characterId: 9,
            characters: [{ avatar: 'a.png', name: 'A' }], // 只有 1 张，下标 9 不存在
            name2: '爱蜜莉雅',
            extensionSettings: {},
        };
        assert.equal(characterKey(ctx), 'name:爱蜜莉雅');
    });

    test('⭐ 酒馆把 characters 挂在全局上（没透进 ctx）→ 也能认出来', () => {
        const g = /** @type {any} */ (globalThis);
        const savedChars = g.characters;
        const savedChid = g.this_chid;
        try {
            g.characters = [{ avatar: 'global-card.png', name: '全局卡' }];
            g.this_chid = 0;

            const ctx = { characterId: 0, name2: '全局卡', extensionSettings: {} }; // 故意不给 characters
            const info = characterKeyInfo(ctx);
            assert.equal(info.key, 'avatar:global-card.png', `应该用全局那张卡，实际：${JSON.stringify(info)}`);
            assert.match(info.source, /globalThis/, '要标明来源是全局');
        } finally {
            if (savedChars === undefined) delete g.characters; else g.characters = savedChars;
            if (savedChid === undefined) delete g.this_chid; else g.this_chid = savedChid;
        }
    });

    test('群聊（没有单一角色卡）→ 按群绑定，不共用别人的池子', () => {
        const ctx = { groupId: 'grp-7', extensionSettings: {} };
        assert.equal(characterKey(ctx), 'group:grp-7');
    });

    test('⭐⭐ 真拿不到时报错要说清「试过什么」，不能只写「可能还没选卡」', () => {
        const ctx = { characterId: -1, characters: [], extensionSettings: {} };
        const info = characterKeyInfo(ctx);
        assert.equal(info.key, '', '这个 ctx 确实认不出来');

        const res = setCharacterPool(ctx, HOOKS, ['书']);
        assert.equal(res.ok, false);
        assert.match(res.error, /试过/, `报错要带上探测过程，实际：${res.error}`);
        assert.doesNotMatch(res.error, /可能还没选卡/, '不能再把猜测当结论写给用户');
    });

    test('characterName 认不出下标时也退到 name2（否则界面会显示「归属：空」）', () => {
        assert.equal(characterName({ characterId: 9, characters: [], name2: '爱蜜莉雅' }), '爱蜜莉雅');
        assert.equal(characterName({ characterId: 0, characters: [{ name: '爱蜜莉雅' }] }), '爱蜜莉雅');
    });

    test('⭐ 池子里记着自己属于哪张卡（再核一道，防手工改坏）', () => {
        const ctx = makeCtx();
        const res = setCharacterPool(ctx, HOOKS, ['我的世界书']);
        assert.equal(res.pool.character, 'avatar:emilia.png');
        // 伪造一个「标着别的卡」的池子 → 判定为不可用
        ctx.extensionSettings.characterHookPools['avatar:emilia.png'].character = 'avatar:rem.png';
        assert.equal(isCharacterPoolFresh(ctx, defaultSettings(), ['我的世界书']), false);
    });

    test('clearCharacterPool 只清当前卡', () => {
        const store = {};
        const emilia = makeCtx({ store });
        const rem = makeCtx({ store, chid: 1, avatar: 'rem.png', name: '雷姆' });
        setCharacterPool(emilia, HOOKS, ['我的世界书']);
        setCharacterPool(rem, HOOKS, ['我的世界书']);

        clearCharacterPool(emilia);
        assert.equal(getCharacterPool(emilia), null, '当前卡被清了');
        assert.ok(getCharacterPool(rem), '别的卡不该被牵连');
    });

    test('listCharacterPools 能列出所有建过池子的卡（排查串味用）', () => {
        const store = {};
        const emilia = makeCtx({ store });
        setCharacterPool(emilia, HOOKS, ['我的世界书']);
        const rem = makeCtx({ store, chid: 1, avatar: 'rem.png', name: '雷姆' });
        setCharacterPool(rem, [HOOKS[0]], ['另一本书']);

        const all = listCharacterPools(rem);
        assert.equal(all.length, 2, `应该有两张卡，实际 ${JSON.stringify(all)}`);
        const mine = all.find((p) => p.current);
        assert.equal(mine?.key, 'avatar:rem.png', 'current 要标在当前的卡上');
    });

    test('characterName 拿不到时返回空串而不是崩', () => {
        assert.equal(characterName({}), '');
        assert.equal(characterName(null), '');
        assert.equal(characterName(makeCtx({ name: '爱蜜莉雅' })), '爱蜜莉雅');
    });
});

describe('⚠️ 占位串不能当卡名（否则所有卡共用一个池子）', () => {
    // 用户诊断里真实出现过：`identity.key = "name:SillyTavern System"`。
    // 那是酒馆自己的占位名（装好还没进过聊天时就是它），拿它当卡名意味着
    // **换一张卡玩，池子还是同一个** —— 世界观完全不同，引导直接串味。

    /** 只给 name2 与一段聊天记录的 ctx（模拟 TauriTavern 实测形状）。 */
    function bare(name2, chat) {
        return { name2, chat };
    }

    test('⭐ ctx.name2 是占位串时，要从聊天记录里认出真正的卡名', () => {
        const ctx = bare('SillyTavern System', [
            { name: '你', is_user: true, mes: '你好' },
            { name: '雷姆', is_user: false, mes: '…… who are you' },
        ]);
        const info = characterKeyInfo(ctx);
        assert.equal(info.key, 'name:雷姆', `认错了：${JSON.stringify(info)}`);
        assert.equal(info.source, 'chat里的角色名');
    });

    test('⭐ 占位串不能落进 key 里（换卡必须换池子）', () => {
        const a = characterKeyInfo(bare('SillyTavern System', [{ name: '爱蜜莉雅', is_user: false, mes: 'x' }]));
        const b = characterKeyInfo(bare('SillyTavern System', [{ name: '雷姆', is_user: false, mes: 'x' }]));
        assert.notEqual(a.key, b.key, '两张不同的卡绝不能算出同一个 key');
        assert.ok(!a.key.includes('SillyTavern System'), `占位串混进 key 了：${a.key}`);
    });

    test('聊天记录里取**最近**那位（用户中途换过卡时不能认成旧卡）', () => {
        const ctx = bare('SillyTavern System', [
            { name: '爱蜜莉雅', is_user: false, mes: '早' },
            { name: '你', is_user: true, mes: '早' },
            { name: '雷姆', is_user: false, mes: '早' },
        ]);
        assert.equal(characterKeyInfo(ctx).key, 'name:雷姆');
    });

    test('我们自己注入的小字条不算角色名（它的 name 就是「贝翠丝」）', () => {
        const ctx = bare('SillyTavern System', [
            { name: '雷姆', is_user: false, mes: '早' },
            {
                name: '贝翠丝',
                is_user: false,
                is_system: true,
                mes: '小字条',
                extra: { beatriceGuide: { injected: true } },
            },
        ]);
        assert.equal(characterKeyInfo(ctx).key, 'name:雷姆', '别把自己塞的小字条当成卡');
    });

    test('聊天里只有用户消息 → 认不出来，如实报告（不编一个名字出来）', () => {
        const info = characterKeyInfo(bare('SillyTavern System', [{ name: '你', is_user: true, mes: '你好' }]));
        assert.equal(info.key, '');
        assert.match(info.diag, /占位串/, `诊断要说明白为什么没认出来：${info.diag}`);
    });

    test('name2 是真名字时仍然优先用它（聊天记录是退路，不是首选）', () => {
        const ctx = bare('爱蜜莉雅', [{ name: '雷姆', is_user: false, mes: 'x' }]);
        const info = characterKeyInfo(ctx);
        assert.equal(info.key, 'name:爱蜜莉雅');
        assert.equal(info.source, 'ctx.name2');
    });

    test('characterName 也不该把占位串显示给用户', () => {
        assert.equal(characterName(bare('SillyTavern System', [{ name: '雷姆', is_user: false, mes: 'x' }])), '雷姆');
        assert.equal(characterName(bare('SillyTavern System', [])), '', '认不出就空着，别显示占位串');
    });
});

describe('编辑过的池子：有效期从修改时间算起', () => {
    test('⭐ 用户刚改完，不该被自动重读立刻冲掉', () => {
        const ctx = makeCtx();
        const s = defaultSettings();
        s.worldbook.poolTtlMs = 1000;

        setCharacterPool(ctx, HOOKS, ['我的世界书'], { at: Date.now() - 10000 });
        assert.equal(isCharacterPoolFresh(ctx, s, ['我的世界书']), false, '没编辑过就是过期');

        const pool = getCharacterPool(ctx);
        setCharacterPool(ctx, pool.hooks, pool.books, { at: pool.at, editedAt: Date.now() });
        assert.equal(isCharacterPoolFresh(ctx, s, ['我的世界书']), true, '刚编辑完就判过期等于用户白改');
    });

    test('编辑过之后仍然受「书单变化」约束（不是永久豁免）', () => {
        const ctx = makeCtx();
        setCharacterPool(ctx, HOOKS, ['我的世界书'], { editedAt: Date.now() });
        assert.equal(isCharacterPoolFresh(ctx, defaultSettings(), ['我的世界书']), true);
        assert.equal(isCharacterPoolFresh(ctx, defaultSettings(), ['换了一本书']), false, '换书必须重读');
    });

    test('空池子不算可用（免得拿个空池子去引导）', () => {
        const ctx = makeCtx();
        setCharacterPool(ctx, [], ['我的世界书']);
        assert.equal(getCharacterPool(ctx), null);
        assert.equal(isCharacterPoolFresh(ctx, defaultSettings(), ['我的世界书']), false);
    });
});

describe('老数据迁移（池子原来存在 chatMetadata 里）', () => {
    test('⭐ 读的时候自动从 chatMetadata 搬到卡级存储，用户不用重新通读', () => {
        const ctx = makeCtx();
        ctx.chatMetadata['beatrice-guide'] = {
            hookPool: { at: Date.now(), books: ['我的世界书'], hooks: HOOKS },
        };

        const got = getCharacterPool(ctx);

        assert.equal(got?.hooks.length, 2, '旧池子应该被读到');
        assert.equal(got.migratedFrom, 'chatMetadata');
        assert.ok(ctx.extensionSettings.characterHookPools['avatar:emilia.png'], '应该已经迁移到卡级存储');
        assert.equal(ctx.chatMetadata['beatrice-guide'].hookPool, null, '老位置应该被清掉');
    });

    test('新位置有池子时优先用它，不去看老位置', () => {
        const ctx = makeCtx();
        setCharacterPool(ctx, HOOKS, ['我的世界书']);
        ctx.chatMetadata['beatrice-guide'] = {
            hookPool: { at: Date.now(), books: ['旧书'], hooks: [HOOKS[0]] },
        };
        const got = getCharacterPool(ctx);
        assert.deepEqual(got.books, ['我的世界书'], '应该用新位置的');
    });
});

describe('线索池的查看与修改（用户要求「防止出错」）', () => {
    /** 造一个能跑 GuideController 的 ctx。 */
    async function makeApp() {
        const { GuideController } = await import('../src/app.js');
        const store = {};
        const ctx = makeCtx({ store });
        ctx.saveSettingsDebounced = async () => {};
        ctx.saveMetadata = async () => {};
        const app = new GuideController(ctx, defaultSettings());
        setCharacterPool(ctx, HOOKS.map((h) => ({ ...h })), ['我的世界书'], { source: 'ai' });
        return { app, ctx, store };
    }

    test('readHookPool 给出界面需要的全部信息（谁的卡、几条、能不能用）', async () => {
        const { app } = await makeApp();
        const info = app.readHookPool();
        assert.equal(info.ok, true);
        assert.equal(info.hooks.length, 2);
        assert.equal(info.character, '爱蜜莉雅', '要说清是哪张卡的');
        assert.equal(info.source, 'ai');
        assert.equal(info.fresh, true);
        assert.deepEqual(info.books, ['我的世界书']);
    });

    test('⭐ 改标题 / 改正文 / 换分类，都只动那一条', async () => {
        const { app, ctx } = await makeApp();

        assert.equal((await app.updateHook(0, { label: '改过的标题' })).ok, true);
        assert.equal((await app.updateHook(1, { content: '改过的正文' })).ok, true);
        assert.equal((await app.updateHook(1, { kind: '征兆' })).ok, true);

        const after = app.readHookPool().hooks;
        assert.equal(after[0].label, '改过的标题');
        assert.equal(after[0].content, HOOKS[0].content, '不该动到别的字段');
        assert.equal(after[1].content, '改过的正文');
        assert.equal(after[1].kind, '征兆');
        assert.equal(after.length, 2, '条数不该变');
        // 确实落到存储里了
        assert.equal(getCharacterPool(ctx).hooks[1].content, '改过的正文');
    });

    test('越界下标 → 明确报错，而不是悄悄改错一条', async () => {
        const { app } = await makeApp();
        for (const bad of [-1, 5, 1.5, NaN]) {
            const r = await app.updateHook(bad, { label: 'x' });
            assert.equal(r.ok, false, `下标 ${bad} 应该被拒绝`);
            assert.match(r.error, /没有第/);
        }
    });

    test('删掉一条', async () => {
        const { app } = await makeApp();
        assert.equal((await app.removeHook(0)).ok, true);
        const after = app.readHookPool().hooks;
        assert.equal(after.length, 1);
        assert.equal(after[0].label, HOOKS[1].label, '删的应该是第一条');
    });

    test('自己补一条（AI 漏掉时的兜底）', async () => {
        const { app } = await makeApp();
        assert.equal((await app.addHook({ label: '我补的', content: '内容' })).ok, true);
        const after = app.readHookPool().hooks;
        assert.equal(after.length, 3);
        assert.equal(after[2].label, '我补的');
        assert.equal(after[2].why, '手动指定');
    });

    test('标题和正文都空 → 拒绝（避免界面上出现空白行）', async () => {
        const { app } = await makeApp();
        const r = await app.addHook({ label: '  ', content: '' });
        assert.equal(r.ok, false);
        assert.match(r.error, /至少要填一个/);
    });

    test('空条目在写回时被丢掉，不留空白行', async () => {
        const { app } = await makeApp();
        await app.writeHookPool([...HOOKS, { label: '  ', content: '' }]);
        assert.equal(app.readHookPool().hooks.length, 2, '空条目该被过滤掉');
    });

    test('⭐ 全部删光 = 清空池子', async () => {
        const { app, ctx } = await makeApp();
        const r = await app.writeHookPool([]);
        assert.equal(r.ok, true);
        assert.equal(r.count, 0);
        assert.equal(getCharacterPool(ctx), null, '池子应该被清掉');
    });

    test('⭐ 改过之后有效期从修改时间算起（不会被自动重读立刻冲掉）', async () => {
        const { app, ctx } = await makeApp();
        const s = defaultSettings();
        s.worldbook.poolTtlMs = 1000;

        // 把池子做旧：10 秒前建立
        setCharacterPool(ctx, HOOKS, ['我的世界书'], { at: Date.now() - 10000 });
        assert.equal(isCharacterPoolFresh(ctx, s, ['我的世界书']), false);

        await app.updateHook(0, { label: '修好了' });
        assert.equal(
            isCharacterPoolFresh(ctx, s, ['我的世界书']),
            true,
            '刚改完就判过期 = 用户白改',
        );
        assert.equal(app.readHookPool().edited, true, '要记下「被手工改过」');
    });
});
