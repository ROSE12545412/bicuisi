import assert from 'node:assert/strict';
import { test, describe } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';

// Keep the real controller, observer, memory reconciliation and delivery code.
// Only the remote completion and empty worldbook pool are deterministic fixtures.
function setup(realm = 'beatrice') {
    const settings = defaultSettings(); settings.realm = realm; settings.adversary.enabled = false;
    const saves = [], bubbles = [];
    const ctx = { name2: 'Betty', chatId: 'A', characterId: 0,
        characters: [{ name: 'Betty', avatar: 'betty.png' }],
        chat: [{ mes: 'Alice opened the door.', name: 'Betty', swipe_id: 0 }],
        chatMetadata: {}, extensionSettings: {},
        saveMetadata: async () => { saves.push(JSON.parse(JSON.stringify(ctx.chatMetadata))); },
        saveChat: async () => {} };
    const app = new GuideController(ctx, settings); app.log = () => {};
    app.currentHookPool = () => ({ hooks: [], books: [] });
    app.ui = { say: text => bubbles.push(text), setTyping: () => {} };
    return { app, ctx, settings, saves, bubbles };
}
const proposal = (overrides = {}) => ({ id: 'door', actor: 'Alice', action: 'opened the door', result: 'door open',
    status: 'confirmed', knowledge: [], evidence: [{ index: 0, quote: 'Alice opened the door.' }], ...overrides });
const completion = value => ({ ok: true, text: JSON.stringify(value) });
const guide = { guidance: 'Look by the door.', commentary: '笨蛋，仔细看看呀。', emotion: 'calm', sourceAssessment: [] };
function outcome(app, extra = {}) {
    const token = app.captureLifecycle();
    return { ok: true, lifecycle: token, origin: token.origin, realm: token.realm,
        targetMessageId: 0, targetSnapshot: app.captureTarget(0), result: { ...guide }, ...extra };
}
async function withCompletion(fn, body) {
    const old = LlmClient.prototype.complete; LlmClient.prototype.complete = fn;
    try { return await body(); } finally { LlmClient.prototype.complete = old; }
}
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

describe('r23 actual GuideController memories integration', () => {
    test('delivered append records detached assessed original sources and locator snapshots exactly once', async () => {
        const { app, ctx, saves, bubbles } = setup();
        const accepted = { book: 'door-book', uid: 7, label: 'Door', content: 'ORIGINAL_SOURCE', sourceType: 'worldbook-original' };
        const rejected = { book: 'door-book', uid: 8, label: 'Rejected', content: 'REJECTED_SOURCE' };
        const note = { book: '', uid: 'note', label: 'Note', content: 'USER_NOTE', sourceType: 'user-note' };
        const located = { ok: true, reason: 'Current door event', picked: [accepted] };
        const got = outcome(app, { hooks: [accepted, rejected, note], located,
            sourceAssessment: [{ book: 'door-book', uid: '7', status: 'applicable' }, { book: 'door-book', uid: 8, status: 'unknown' }] });
        try {
            assert.equal(app.memoryState().reminders.length, 0);
            const pending = app._install(got, 'integration');
            assert.equal(app._install(got, 'duplicate'), pending);
            const installed = await pending;
            assert.equal(installed.ok, true); assert.equal(installed.injected.ok, true);
            assert.match(ctx.chat[0].extra.display_text, /Look by the door/);
            assert.equal(ctx.chat[0].mes, 'Alice opened the door.', 'delivery must not rewrite evidence prose');
            assert.deepEqual(bubbles, [guide.commentary]);
            let row = app.memoryState().reminders[0];
            assert.equal(row.index, 0); assert.equal(row.mode, 'beatrice'); assert.equal(row.bookmarked, false);
            assert.deepEqual(row.sources, [accepted, note]); assert.deepEqual(row.located, located);
            assert.equal(saves.length, 1); assert.equal(saves[0]['beatrice-guide'].memories.reminders.length, 1);
            accepted.content = 'MUTATED_SOURCE'; note.label = 'MUTATED_NOTE'; located.reason = 'MUTATED_LOCATOR';
            row.sources[0].content = 'MUTATED_VIEW'; row.located.picked[0].label = 'MUTATED_VIEW';
            row = app.memoryState().reminders[0];
            assert.equal(row.sources[0].content, 'ORIGINAL_SOURCE'); assert.equal(row.sources[1].label, 'Note');
            assert.equal(row.located.reason, 'Current door event'); assert.equal(row.located.picked[0].label, 'Door');
            await app._install(installed, 'already installed');
            assert.equal(app.memoryState().reminders.length, 1); assert.equal(saves.length, 1);
        } finally { app._watchStop?.(); }
    });

    test('failed generation never becomes a reminder or a spoken bubble', async () => {
        const { app, bubbles, saves } = setup();
        assert.equal((await app._install(outcome(app, { ok: false, error: 'remote failed' }), 'failure')).ok, false);
        assert.equal(app.memoryState().reminders.length, 0); assert.deepEqual(bubbles, []); assert.deepEqual(saves, []);
    });

    test('real observation creates and persists diary before composition, while askNow alone does not record delivery', async () => {
        const { app, saves } = setup(); const calls = [];
        await withCompletion(async opts => {
            calls.push(opts);
            if (opts.system?.startsWith('Observe neutral events')) {
                assert.ok(!JSON.stringify(opts).includes('【共同经历日记】'));
                return completion({ proposals: [proposal(), proposal({ id: 'uncertain', status: 'unknown' })] });
            }
            const diary = app.memoryState().diary;
            assert.equal(diary.length, 1); assert.equal(diary[0].factId, 'door');
            assert.ok(JSON.stringify(opts.messages).includes('【共同经历日记】'));
            assert.ok(JSON.stringify(opts.messages).includes('opened the door'));
            return completion(guide);
        }, async () => {
            const got = await app.askNow(); assert.equal(got.ok, true);
            assert.equal(calls.length, 2); assert.equal(app.factState().facts.length, 2);
            const state = app.memoryState(); assert.equal(state.diary.length, 1); assert.equal(state.reminders.length, 0);
            assert.deepEqual(state.diary[0].evidence, [{ index: 0, quote: 'Alice opened the door.' }]);
            assert.equal(saves.length, 1); assert.equal(saves[0]['beatrice-guide'].memories.diary[0].factId, 'door');
            await app.askNow(); assert.equal(calls.length, 3, 'same prose uses observer dedup but still composes');
            assert.equal(app.memoryState().diary.length, 1);
        });
    });

    test('memory diary prompt is Beatrice composition only, never neutral observation or void composition', async () => {
        for (const realm of ['beatrice', 'void']) {
            const { app, settings } = setup(realm); settings.injection.mode = 'off';
            const calls = [];
            await withCompletion(async opts => {
                calls.push(opts);
                return opts.system?.startsWith('Observe neutral events')
                    ? completion({ proposals: [proposal()] }) : completion(guide);
            }, async () => {
                const got = await app.askNow(); assert.equal(got.ok, true); assert.equal(calls.length, 2);
                assert.equal(app.memoryState().diary.length, 1, 'void still stores neutral events locally');
                assert.ok(!JSON.stringify(calls[0]).includes('【共同经历日记】'));
                assert.equal(JSON.stringify(calls[1].messages).includes('【共同经历日记】'), realm === 'beatrice');
                assert.ok(JSON.stringify(calls[1].messages).includes('opened the door'), 'neutral facts remain available in both realms');
                await app._install(got, 'delivery');
                settings.realm = realm === 'beatrice' ? 'void' : 'beatrice';
                assert.equal(app.memoryState().reminders[0].mode, realm, 'stored realm is historical');
            });
        }
    });

    test('bookmark, forget and scoped-clear controller APIs persist through a new controller JSON reload', async () => {
        const { app, ctx, settings, saves } = setup(); settings.injection.mode = 'off';
        await withCompletion(async opts => opts.system?.startsWith('Observe neutral events')
            ? completion({ proposals: [proposal()] }) : completion(guide), async () => {
            await app._install(await app.askNow(), 'delivery');
            const { reminders: [row], diary: [event] } = app.memoryState();
            assert.equal(await app.toggleBookmark(row.id), true);
            assert.equal(saves.at(-1)['beatrice-guide'].memories.reminders[0].bookmarked, true);
            const reloadCtx = { ...ctx, chat: JSON.parse(JSON.stringify(ctx.chat)), chatMetadata: JSON.parse(JSON.stringify(saves.at(-1))) };
            const reloaded = new GuideController(reloadCtx, settings);
            assert.deepEqual(reloaded.memoryState().bookmarks, [row.id]);
            assert.equal(await app.toggleBookmark(row.id), false);
            assert.equal(saves.at(-1)['beatrice-guide'].memories.reminders[0].bookmarked, false);
            assert.equal(await app.forgetDiary(event.id), true);
            assert.equal(app.memoryState().diary.length, 0, 'fact reconciliation must respect explicit forgetting');
            reloadCtx.chatMetadata = JSON.parse(JSON.stringify(saves.at(-1)));
            assert.equal(reloaded.memoryState().diary.length, 0);
            assert.equal(await app.toggleBookmark(row.id), true);
            assert.equal(await app.clearMemories('bookmarks'), true);
            assert.deepEqual(app.memoryState().bookmarks, []); assert.equal(app.memoryState().reminders.length, 1);
            const before = saves.length;
            assert.equal(await app.clearMemories('invalid'), false); assert.equal(saves.length, before);
            assert.equal(await app.clearMemories('all'), true);
            assert.equal(saves.at(-1)['beatrice-guide'].memories.reminders.length, 0);
            assert.equal(app.memoryState().diary.length, 0);
        });
    });

    for (const [name, mutate] of [
        ['edited prose', ({ ctx }) => { ctx.chat[0].mes = 'Different prose.'; }],
        ['swiped target', ({ ctx }) => { ctx.chat[0].swipe_id = 1; }],
        ['identical branch replacement', ({ ctx }) => { ctx.chat[0] = { ...ctx.chat[0] }; }],
        ['changed chat', ({ ctx }) => { ctx.chatId = 'B'; }],
        ['changed character', ({ ctx }) => { ctx.characters[0].avatar = 'other.png'; }],
        ['changed realm', ({ settings }) => { settings.realm = 'void'; }],
        ['cancelled lifecycle', ({ app }) => app.cancelInflight()],
    ]) test(`stale ${name} cannot deliver, persist or record a reminder`, async () => {
        const fixture = setup(), got = outcome(fixture.app); mutate(fixture);
        assert.equal((await fixture.app._install(got, 'stale')).ok, false);
        assert.equal(fixture.app.memoryState().reminders.length, 0);
        assert.deepEqual(fixture.saves, []); assert.deepEqual(fixture.bubbles, []);
        assert.equal(fixture.ctx.chat[0].extra, undefined);
    });

    test('delayed observation across a context switch writes no diary or reminder to either chat', async () => {
        const { app, ctx, saves } = setup(); let release; const calls = [];
        const other = { ...ctx, chatId: 'B', chat: [{ mes: 'Bob sat down.' }], chatMetadata: {} };
        await withCompletion(opts => { calls.push(opts); return new Promise(resolve => { release = resolve; }); }, async () => {
            const pending = app.askNow(); await tick(); assert.equal(calls.length, 1);
            app.ctx = other; release(completion({ proposals: [proposal()] }));
            const got = await pending; assert.equal(got.ok, false); assert.equal(got.aborted, true);
            assert.equal((await app._install(got, 'late')).ok, false);
            assert.equal(app.memoryState().diary.length, 0); assert.equal(app.memoryState().reminders.length, 0);
            assert.equal(new GuideController(ctx, app.settings).memoryState().diary.length, 0);
            assert.deepEqual(saves, []); assert.equal(calls.length, 1, 'stale observation cannot proceed into composition');
        });
    });

    test('bookmark save rejection after chat switch never falls back into the new chat', async () => {
        const { app, ctx, settings } = setup(); settings.injection.mode = 'off';
        await app._install(outcome(app), 'delivery');
        const id = app.memoryState().reminders[0].id; let reject, oldFallback = 0, newSaves = 0;
        ctx.saveMetadata = () => new Promise((_, fail) => { reject = fail; });
        ctx.saveChat = async () => { oldFallback++; };
        const pending = app.toggleBookmark(id); await tick(); assert.equal(typeof reject, 'function');
        const other = { ...ctx, chatId: 'B', chat: [{ mes: 'Bob sat down.' }], chatMetadata: {},
            saveMetadata: async () => { newSaves++; }, saveChat: async () => { newSaves++; } };
        app.ctx = other; reject(new Error('host save failed')); await pending;
        assert.equal(oldFallback, 0); assert.equal(newSaves, 0); assert.deepEqual(other.chatMetadata, {});
        assert.deepEqual(app.memoryState().bookmarks, []);
        assert.deepEqual(new GuideController(ctx, settings).memoryState().bookmarks, [id], 'only original in-memory bookmark may change');
    });
});
