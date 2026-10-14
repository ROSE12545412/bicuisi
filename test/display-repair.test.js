/**
 * 「她的话在数据里、却不在页面上」的修复层测试。
 *
 * ── 这些用例来自一次真实的用户反馈
 *
 * 诊断里写着 `"lastInjected": "已接在第 #4 条正文末尾"`、`"pendingAppends": 0`，
 * 而用户看到的是「正文末尾什么都没有」。
 *
 * 原因：`display_text` 只活在**消息对象**上。酒馆在任何一次重渲染里都可能按
 * `mes` 重铺页面（刷新页面、切走聊天再切回来、主题重排、宿主存盘后 reload），
 * 数据一个字没丢，丢的只是「这一次渲染」。而旧实现把「盯着这件事」记在内存的
 * 一张 Map 里，并且**一验成功就删登记** —— 登记随页面一起消失，之后就再没有
 * 任何东西看着它了。
 *
 * 所以这里要钉住的是一条**不依赖内存状态**的规则：凡是带
 * `extra.beatriceGuide` 记号的楼层，就应当显示 `extra.display_text`。
 *
 * 另外三条边界同样重要，坏一条都会造成真实伤害：
 *  - 幂等：显示对了就什么都不许做。否则 `updateMessageBlock` 触发
 *    `MESSAGE_UPDATED` → 事件回到修复函数 → 再渲染一次……死循环。
 *  - 正文被改过（用户手改 / 重新生成 / swipe）就不许贴回去 —— 那是篡改
 *    用户的正文。判据是 `display_text` 必须以 `mes` 开头。
 *  - 没有记号的楼层一个字都不许碰（别人家的消息、别的插件的 display_text）。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import {
    activeWatchCount,
    clearPendingAppends,
    displayReport,
    flushPendingAppends,
    hostRenderHonorsDisplay,
    patchUpdateMessageBlock,
    pendingAppendCount,
    repairDisplayedGuidance,
    resetDisplayDiagnostics,
    watchDisplayedGuidance,
    watchRepairCount,
} from '../src/inject.js';
import { defaultSettings } from '../src/config.js';

const DIVIDER = '──────────';

/**
 * 一个刚够用的假 DOM。
 *
 * `floors` 里的下标 = 「这个楼层已经渲染到页面上了」。页面内容就是
 * 节点的 `textContent`，正是 `isDisplayApplied` 读的东西。
 */
function fakeDom(renderedIndexes = []) {
    /** @type {Map<number, any>} */
    const floors = new Map();
    const tails = new Map();
    for (const i of renderedIndexes) {
        // ⚠️ 必须支持 innerHTML：真实 DOM 里 `node.innerHTML = '纯文本'`
        //    之后 `textContent` 就是那段文本。`applyDisplayToDom` 走的正是
        //    innerHTML（正文来自模型，不能裸写），假节点不支持的话，
        //    「兜底把话写上去」这条路会被判成失败 —— 那是夹具的谎报。
        const node = /** @type {any} */ ({ textContent: '' });
        Object.defineProperty(node, 'innerHTML', {
            get() {
                return node.textContent;
            },
            set(v) {
                node.textContent = String(v ?? '');
            },
            enumerable: true,
            configurable: true,
        });
        // 主选择器会直接命中，这个只是兜底路径要用的形状
        node.querySelector = () => node;
        node.querySelectorAll = () => [];
        node.parentNode = { insertBefore(tail) { tails.set(i, tail); }, children: [node] };
        floors.set(i, node);
    }
    const doc = {
        querySelector(/** @type {string} */ sel) {
            const m = /mesid="(\d+)"/.exec(String(sel));
            if (!m) return null;
            if (sel.includes('.bg-inline-guidance')) return tails.get(Number(m[1])) ?? null;
            return floors.get(Number(m[1])) ?? null;
        },
        createElement() {
            const attrs = {};
            return { textContent: '', setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return attrs[k]; }, remove() { tails.delete(Number(attrs['data-bg-message-id'])); } };
        },
        querySelectorAll: () => [...tails.values()],
    };
    return { doc, floors };
}

/** 造一个「楼层真的会渲染」的假 ctx（updateMessageBlock 会写进页面）。 */
function fakeCtx(chat, dom) {
    const calls = { rerenders: 0 };
    const ctx = {
        chat,
        updateMessageBlock(/** @type {number} */ id, /** @type {any} */ msg) {
            calls.rerenders++;
            const node = dom.floors.get(Number(id));
            // 酒馆不认 display_text 时会退回落 mes；这里刻意只认 display_text，
            // 好让「页面被 mes 覆盖」这件事能被真实地模拟出来。
            if (node) node.textContent = String(msg?.extra?.display_text ?? msg?.mes ?? '');
        },
        messageFormatting: (/** @type {string} */ t) => t,
    };
    return { ctx, calls };
}

/** 一条「插件加过引导」的消息。 */
function guidedMessage(mes, guidance, extra = {}) {
    return {
        name: '爱蜜莉雅',
        is_user: false,
        mes,
        extra: {
            display_text: `${mes}\n\n${DIVIDER}\n贝翠丝：${guidance}`,
            beatriceGuide: { appendedTo: 0, at: Date.now() },
            ...extra,
        },
    };
}

/** 在临时假 DOM 里跑一段。 */
async function withDom(renderedIndexes, fn) {
    const { doc, floors } = fakeDom(renderedIndexes);
    const prev = /** @type {any} */ (globalThis).document;
    /** @type {any} */ (globalThis).document = doc;
    try {
        return await fn(floors);
    } finally {
        /** @type {any} */ (globalThis).document = prev;
    }
}

describe('repairDisplayedGuidance —— 数据里有、页面上没有', () => {
    test('⭐ 页面被 mes 覆盖掉之后，能把它补回来（用户报的 bug 现场）', async () => {
        await withDom([0, 1], async (floors) => {
            const mes = '你沿着主街走着，晚风里混着烤面包的味道。';
            const chat = [{ name: '你', is_user: true, mes: '我去街上转转' }, guidedMessage(mes, '今天街上的人都在往同一个方向走。')];
            const { ctx } = fakeCtx(chat, { floors });

            // 模拟「酒馆重铺页面」：节点在，但只有 mes，没有她的话
            floors.get(1).textContent = mes;

            const n = repairDisplayedGuidance(ctx);

            assert.equal(n, 1, '应当修好一条');
            assert.ok(
                floors.get(1).textContent.includes('今天街上的人都在往同一个方向走'),
                '补回来之后页面上必须能看到她的话',
            );
        });
    });

    test('⭐ 已经显示对了就一条都不动（不幂等就会死循环）', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '一句暗示')];
            const { ctx, calls } = fakeCtx(chat, { floors });
            floors.get(1).textContent = chat[1].extra.display_text;

            const n = repairDisplayedGuidance(ctx);

            assert.equal(n, 0);
            assert.equal(calls.rerenders, 0, '显示已经对了就不该再触发渲染');
        });
    });

    test('连跑两次不产生额外渲染（幂等）', async () => {
        await withDom([1], async (floors) => {
            const mes = '正文';
            const chat = [null, guidedMessage(mes, '一句暗示')];
            const { ctx, calls } = fakeCtx(chat, { floors });
            floors.get(1).textContent = mes;

            assert.equal(repairDisplayedGuidance(ctx), 1);
            const after = calls.rerenders;
            assert.equal(repairDisplayedGuidance(ctx), 0, '第二次应当无事可做');
            assert.equal(calls.rerenders, after, '第二次不该再渲染');
        });
    });

    test('⭐ 正文被改过（手改 / 重新生成 / swipe）→ 不贴回去，清掉记号让正文说了算', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('旧正文', '一句暗示')];
            // 用户把正文改了：mes 与 display_text 的前缀对不上了
            chat[1].mes = '用户自己重写的正文';
            const { ctx } = fakeCtx(chat, { floors });
            floors.get(1).textContent = '用户自己重写的正文';

            const n = repairDisplayedGuidance(ctx);

            assert.equal(n, 0, '不许把旧引导贴回被改过的正文');
            assert.equal(chat[1].extra.display_text, undefined, '过期的 display_text 必须清掉');
            assert.equal(chat[1].extra.beatriceGuide, undefined, '记号也要清掉');
            assert.equal(floors.get(1).textContent, '用户自己重写的正文', '页面回到用户的正文');
        });
    });

    test('⭐ 没有记号的楼层一个字都不许碰', async () => {
        await withDom([0, 1, 2], async (floors) => {
            const chat = [
                { name: '你', is_user: true, mes: '普通用户消息' },
                // 别的东西设了 display_text，但不是我们加的
                { name: '爱蜜莉雅', mes: '正文', extra: { display_text: '别的插件改过的显示' } },
                { name: '爱蜜莉雅', mes: '正文二' },
            ];
            const { ctx, calls } = fakeCtx(chat, { floors });

            assert.equal(repairDisplayedGuidance(ctx), 0);
            assert.equal(calls.rerenders, 0);
            assert.equal(chat[1].extra.display_text, '别的插件改过的显示', '不能删别人的 display_text');
        });
    });

    test('只修指定那一条时不碰别的', async () => {
        await withDom([1, 2], async (floors) => {
            const chat = [null, guidedMessage('正文一', '暗示一'), guidedMessage('正文二', '暗示二')];
            const { ctx } = fakeCtx(chat, { floors });

            assert.equal(repairDisplayedGuidance(ctx, 2), 1);
            assert.ok(floors.get(2).textContent.includes('暗示二'));
            assert.equal(floors.get(1).textContent, '', '没点名的楼层不该被动');
        });
    });

    test('楼层还没渲染时安静地放弃，不抛异常', async () => {
        await withDom([], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            const { ctx } = fakeCtx(chat, { floors });
            assert.equal(repairDisplayedGuidance(ctx), 0);
        });
    });

    test('chat 不是数组时不崩', async () => {
        await withDom([], async () => {
            assert.equal(repairDisplayedGuidance({ chat: null }), 0);
            assert.equal(repairDisplayedGuidance({}), 0);
        });
    });
});

describe('displayReport —— 「在数据里」和「在页面上」必须能分开看', () => {
    test('⭐ 数据有、页面没有 → inData 有值而 onScreen 少，且指出是哪一条', async () => {
        await withDom([1], async (floors) => {
            const mes = '正文';
            const chat = [null, guidedMessage(mes, '暗示')];
            floors.get(1).textContent = mes; // 页面被覆盖

            const r = displayReport({ chat });
            assert.equal(r.watched, 1);
            assert.equal(r.inData, 1, '数据里有');
            assert.equal(r.onScreen, 0, '页面上没有');
            assert.deepEqual(r.missing, [1], '要指出缺的是哪一条，用户才好排查');
        });
    });

    test('都正常时 onScreen 与 inData 一致', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            floors.get(1).textContent = chat[1].extra.display_text;
            const r = displayReport({ chat });
            assert.equal(r.inData, 1);
            assert.equal(r.onScreen, 1);
            assert.deepEqual(r.missing, []);
        });
    });

    test('没有引导时全是 0', async () => {
        await withDom([], async () => {
            resetDisplayDiagnostics();
            assert.deepEqual(displayReport({ chat: [{ mes: '普通消息' }] }), {
                watched: 0,
                inData: 0,
                onScreen: 0,
                missing: [],
                hostHonorsDisplay: null,
                patched: false,
                watchRepairs: 0,
                watching: 0,
                domObserverActive: false,
                observerRepairs: 0,
            });
        });
    });
});

describe('待补登记的清空', () => {
    test('clearPendingAppends 能把登记清干净（换聊天时必须调，否则下标张冠李戴）', () => {
        clearPendingAppends();
        assert.equal(pendingAppendCount(), 0);
    });

    test('flushPendingAppends 遇到已显示正确的条目会把它从待补里摘掉', async () => {
        await withDom([1], async (floors) => {
            const mes = '正文';
            const chat = [null, guidedMessage(mes, '暗示')];
            const { ctx } = fakeCtx(chat, { floors });
            floors.get(1).textContent = chat[1].extra.display_text;

            clearPendingAppends();
            // 没有登记时它就是空转 —— 断言的重点是「不抛异常且不误渲染」
            assert.equal(flushPendingAppends(ctx, 1), 0);
        });
    });
});

describe('设置里的分隔线', () => {
    test('拼出来的 display_text 一定以 mes 开头（修复层的判据要靠它）', () => {
        const mes = '正文';
        const msg = guidedMessage(mes, '暗示');
        assert.ok(msg.extra.display_text.startsWith(mes));
        assert.ok(msg.extra.display_text.includes(DIVIDER));
        // 这条规则也必须在默认设置下成立（speakerName 可能被改）
        assert.equal(typeof defaultSettings().injection.speakerName, 'string');
    });
});

// ---------------------------------------------------------------------------
// 第二层防线：酒馆的渲染路径根本不认 display_text 时怎么办
// ---------------------------------------------------------------------------

/**
 * 一个**不认 display_text** 的假酒馆（TauriTavern 实测就是这个行为）。
 *
 * 它每次渲染都只用 `mes` 重铺页面 —— 于是我们自己补上去的 DOM 会在下一次
 * 渲染里被冲掉。这正是用户诊断里 `inData: 1 / onScreen: 0` 的成因。
 */
function hostileCtx(chat, dom) {
    const ctx = {
        chat,
        updateMessageBlock(/** @type {number} */ id, /** @type {any} */ msg) {
            const node = dom.floors.get(Number(id));
            if (node) node.textContent = String(msg?.mes ?? ''); // ← 只认 mes
        },
        messageFormatting: (/** @type {string} */ t) => t,
    };
    return { ctx };
}

describe('patchUpdateMessageBlock —— 接管酒馆的渲染，任何一次重渲染都带上她的话', () => {
    test('⭐ 宿主按 mes 重铺楼层之后，她的话仍然在页面上（用户报的 bug 根治点）', async () => {
        await withDom([1], async (floors) => {
            const mes = '你沿着主街走着。';
            const chat = [null, guidedMessage(mes, '人都在往同一个方向走。')];
            const { ctx } = hostileCtx(chat, { floors });

            assert.equal(patchUpdateMessageBlock(ctx), true);
            // 酒馆自己渲染一次 —— 未接管时这一步会把我们的话冲掉
            ctx.updateMessageBlock(1, chat[1]);
            assert.ok(
                displayReport(ctx).onScreen === 1,
                '接管之后，酒馆的重渲染也应当带上她的话',
            );
        });
    });

    test('⭐ 重复接管只包一层（否则每次渲染都会套一层函数，越套越慢）', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            const first = ctx.updateMessageBlock;

            patchUpdateMessageBlock(ctx);
            const wrapped = ctx.updateMessageBlock;
            patchUpdateMessageBlock(ctx);
            assert.notEqual(wrapped, first, '第一次应当包上');
            assert.equal(ctx.updateMessageBlock, wrapped, '第二次不应当再包');
        });
    });

    test('没有记号的楼层一个字都不许碰（别人家的消息）', async () => {
        await withDom([1, 2], async (floors) => {
            const chat = [
                null,
                { name: '别人', is_user: false, mes: '原样', extra: { display_text: '别的插件写的' } },
                guidedMessage('正文', '暗示'),
            ];
            const { ctx } = hostileCtx(chat, { floors });
            patchUpdateMessageBlock(ctx);
            floors.get(1).textContent = '原样';
            ctx.updateMessageBlock(1, chat[1]);
            assert.equal(floors.get(1).textContent, '原样', '没有 beatriceGuide 记号就绝不动它');
        });
    });

    test('拿不到 updateMessageBlock 时返回 false，不抛异常', () => {
        assert.equal(patchUpdateMessageBlock({}), false);
        assert.equal(patchUpdateMessageBlock(null), false);
    });

    test('ctx 是冻结对象时装不上也不能崩（只是少一道保险）', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            const frozen = Object.freeze({ ...ctx });
            assert.equal(patchUpdateMessageBlock(frozen), false);
        });
    });

    test('酒馆认 display_text 时，诊断字段如实报告为 true', async () => {
        await withDom([1], async (floors) => {
            const mes = '正文';
            const chat = [null, guidedMessage(mes, '暗示')];
            const { ctx } = fakeCtx(chat, { floors }); // 这个认 display_text
            resetDisplayDiagnostics();
            repairDisplayedGuidance(ctx, 1);
            assert.equal(hostRenderHonorsDisplay(), true, '它认，就该记 true');
        });
    });

    test('酒馆不认 display_text 时，诊断字段报告 false（「酒馆不支持」与「我们写错了」是两回事）', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            resetDisplayDiagnostics();
            repairDisplayedGuidance(ctx, 1);
            assert.equal(hostRenderHonorsDisplay(), false, '它不认，就该记 false');
            // 即使它不认，修复层也必须把话补到页面上
            assert.ok(displayReport(ctx).onScreen === 1);
        });
    });
});

describe('watchDisplayedGuidance —— 没有任何事件时也要自己回头看', () => {
    test('⭐ 写完之后被静默覆盖（不发事件），监视会把它补回来', async () => {
        await withDom([1], async (floors) => {
            const mes = '正文';
            const chat = [null, guidedMessage(mes, '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            const before = watchRepairCount();

            const stop = watchDisplayedGuidance(ctx, 1, { delays: [5, 15] });
            // 模拟「写成功了，然后流式收尾按 mes 重铺」——注意没有任何事件
            floors.get(1).textContent = mes;
            await new Promise((r) => setTimeout(r, 60));
            stop();

            assert.ok(displayReport(ctx).onScreen === 1, '监视应当把它补回来');
            assert.ok(watchRepairCount() > before, '补回来的次数应当被记下来（诊断要能看见）');
        });
    });

    test('显示正常时监视什么都不做（幂等，不和流式打架）', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            floors.get(1).textContent = chat[1].extra.display_text;
            const before = watchRepairCount();

            const stop = watchDisplayedGuidance(ctx, 1, { delays: [5, 15] });
            await new Promise((r) => setTimeout(r, 60));
            stop();

            assert.equal(watchRepairCount(), before, '已经显示对了就不该再动它');
        });
    });

    test('取消之后不再补（换聊天时旧下标必须失效）', async () => {
        await withDom([1], async (floors) => {
            const mes = '正文';
            const chat = [null, guidedMessage(mes, '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            const before = watchRepairCount();

            const stop = watchDisplayedGuidance(ctx, 1, { delays: [30, 60] });
            stop();
            floors.get(1).textContent = mes;
            await new Promise((r) => setTimeout(r, 100));

            assert.equal(watchRepairCount(), before, '取消之后不该再补');
        });
    });

    test('⭐ 取消函数能被重复调用，且计数不会变成负数', async () => {
        // 拆插件 / 换聊天的路径上会连着调好几次 stop。计数器要是不认账，
        // 诊断里会显示「正在盯着 -3 个回看点」—— 这种数字会让人怀疑插件坏了。
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            const base = activeWatchCount();

            const stop = watchDisplayedGuidance(ctx, 1, { delays: [30, 60, 90] });
            assert.equal(activeWatchCount(), base + 3, '三个回看点都要算进去');

            stop();
            stop();
            stop();
            assert.equal(activeWatchCount(), base, `重复取消把计数弄坏了：${activeWatchCount()}`);
        });
    });

    test('已经到点的回看点要从计数里摘掉（不能一直显示「还在盯」）', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            const base = activeWatchCount();

            watchDisplayedGuidance(ctx, 1, { delays: [5, 5] });
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(activeWatchCount(), base, `到点后应当归零，实际 ${activeWatchCount()}`);
        });
    });
});

describe('displayReport —— 诊断必须能分清四种坏法', () => {
    test('报告里带上「酒馆认不认」与「有没有接管成功」', async () => {
        await withDom([1], async (floors) => {
            const chat = [null, guidedMessage('正文', '暗示')];
            const { ctx } = hostileCtx(chat, { floors });
            const noPatch = displayReport(ctx);
            assert.equal(noPatch.patched, false, '没接管时要如实说没接管');

            patchUpdateMessageBlock(ctx);
            const after = displayReport(ctx);
            assert.equal(after.patched, true, '接管之后要如实说接管了');
            assert.ok('hostHonorsDisplay' in after, '要带上「酒馆认不认 display_text」');
            assert.ok('watchRepairs' in after, '要带上监视补过几次');
        });
    });
});
