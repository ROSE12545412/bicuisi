import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';

function setup() {
    const settings = defaultSettings(); settings.cadence.mode = 'always'; settings.cadence.cooldownMs = 0;
    const ctx = { name2: 'card', chatId: 'A', chat: [{ mes: 'original prose' }], chatMetadata: {}, extensionSettings: {}, saveMetadata: async () => {}, saveChat: async () => {} };
    const app = new GuideController(ctx, settings); app.log = () => {}; app._generationBaseline = -1;
    app.ensureHookPool = async () => ({ ok: true, hooks: [], books: [] });
    app.currentHookPool = () => ({ hooks: [], books: [] });
    app.observeCurrentFacts = async () => ({ ok: true });
    return { app, ctx, settings };
}
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const reply = { ok: true, text: '{"guidance":"safe guidance","commentary":"","emotion":"calm"}' };
function outcome(app, id = 0) {
    const token = app.captureLifecycle();
    return { ok: true, lifecycle: token, origin: token.origin, realm: token.realm, targetMessageId: id,
        targetSnapshot: app.captureTarget(id), result: { guidance: 'safe guidance', commentary: '', emotion: 'calm' } };
}

test('r22 ordinary manual and post-generation share a real whole-phase singleflight', async () => {
    const { app } = setup(); const old = LlmClient.prototype.complete; const calls = [];
    LlmClient.prototype.complete = opts => new Promise(resolve => calls.push({ opts, resolve }));
    try {
        const one = app.askNow(), two = app.askNow(), three = app.runPostGeneration();
        assert.equal(one, two); assert.equal(one, three); assert.equal(app.inflight, one);
        await tick(); assert.equal(calls.length, 1); calls[0].resolve(reply);
        await one; assert.equal(app.inflight, null);
    } finally { LlmClient.prototype.complete = old; }
});

test('r22 stop invalidates delayed successful host responses and external install', async () => {
    const { app, ctx } = setup(); const old = LlmClient.prototype.complete; let resolve;
    LlmClient.prototype.complete = () => new Promise(r => { resolve = r; });
    try {
        const pending = app.askNow(); await tick(); app.cancelInflight(); resolve(reply);
        const got = await pending; assert.equal(got.ok, false);
        assert.equal((await app._install(got, 'manual')).ok, false); assert.equal(ctx.chat[0].extra, undefined);
        const o = outcome(app); app.cancelInflight(); assert.equal((await app._install(o, 'late')).ok, false);
    } finally { LlmClient.prototype.complete = old; }
});

test('r22 exact explicit target never moves to a later AI floor and display mutations are allowed', async () => {
    const { app, ctx } = setup(); const o = outcome(app);
    ctx.chat.push({ mes: 'later prose' }); ctx.chat[0].extra = { display_text: 'normal third party display' };
    try { assert.equal((await app._install(o, 'target')).ok, true); assert.match(ctx.chat[0].extra.display_text, /safe guidance/); assert.equal(ctx.chat[1].extra, undefined); }
    finally { app._watchStop?.(); }
});

for (const [name, mutate] of [
    ['same-floor edit', ctx => { ctx.chat[0].mes = 'edited'; }],
    ['swipe', ctx => { ctx.chat[0].swipe_id = 1; }],
    ['object replacement', ctx => { ctx.chat[0] = { mes: 'original prose' }; }],
]) test(`r22 rejects ${name} before install`, async () => {
    const { app, ctx } = setup(); const o = outcome(app); mutate(ctx);
    assert.equal((await app._install(o, 'stale')).ok, false); assert.equal(ctx.chat[0].extra, undefined);
});

test('r22 legacy install rechecks replacement context after awaited target poll', async () => {
    const { app, ctx } = setup(); let live = ctx; app.setContextLoader(() => ({ ...live }));
    let release; app.waitForFreshAiMessage = () => new Promise(r => { release = r; });
    const o = outcome(app); delete o.targetSnapshot; delete o.targetMessageId;
    const pending = app._install(o, 'legacy'); await tick();
    live = { ...ctx, chatId: 'B', chat: [{ mes: 'B prose' }], chatMetadata: {} }; release(0);
    assert.equal((await pending).ok, false); assert.equal(live.chat[0].extra, undefined);
});

test('r22 successful post-generation remains externally installable without a duplicate write', async () => {
    const { app, ctx } = setup(); const old = LlmClient.prototype.complete; let saves = 0;
    ctx.saveChat = async () => { saves++; }; LlmClient.prototype.complete = async () => reply;
    try {
        const got = await app.runPostGeneration(); assert.equal(got.ok, true); assert.equal(got.installed, true);
        const installed = app._install(got, 'external'); assert.equal(installed, app._install(got, 'external-again'));
        assert.equal((await installed).ok, true); assert.equal(saves, 1);
    } finally { LlmClient.prototype.complete = old; app._watchStop?.(); }
});

test('r22 stale rejected metadata save never falls back to saveChat', async () => {
    const { app, ctx } = setup(); let reject, saves = 0;
    ctx.saveMetadata = () => new Promise((_, r) => { reject = r; }); ctx.saveChat = async () => { saves++; };
    const pending = app._install(outcome(app), 'save'); await tick(); app.cancelInflight(); reject(new Error('host save failed'));
    assert.equal((await pending).ok, false); assert.equal(saves, 0); app._watchStop?.();
});

test('r22 post-generation locks pool phase and stop prevents facts or compose', async () => {
    const { app, ctx } = setup(); let release, facts = 0;
    app.ensureHookPool = () => new Promise(r => { release = r; });
    app.observeCurrentFacts = async () => { facts++; return { ok: true }; };
    const first = app.runPostGeneration(); await tick();
    assert.equal(app.runPostGeneration(), first); assert.equal(app.askNow(), first);
    app.cancelInflight(); release({ ok: true, hooks: [], books: [] });
    assert.equal((await first).ok, false); assert.equal(facts, 0); assert.equal(ctx.chat[0].extra, undefined);
});

test('r22 fresh wrapper contexts remain valid but replacement metadata does not', () => {
    const { app, ctx } = setup(); let live = ctx; app.setContextLoader(() => ({ ...live }));
    const token = app.captureLifecycle(); assert.equal(app.lifecycleValid(token), true);
    live = { ...ctx, chatMetadata: {} }; assert.equal(app.lifecycleValid(token), false);
});

test('r22 index chat event and loader switch to fresh host settings', async () => {
    const handlers = new Map(); const previous = globalThis.SillyTavern;
    const mk = id => { const settings = defaultSettings(); settings.ui.showAvatar = false;
        return { chatId: id, name2: 'card', chat: [], chatMetadata: {}, extensionSettings: { beatriceGuide: settings },
            eventTypes: { CHAT_CHANGED: 'change', SETTINGS_UPDATED: 'settings' }, eventSource: { on: (name, fn) => handlers.set(name, fn) }, saveMetadata: async () => {} }; };
    let live = mk('A'); globalThis.SillyTavern = { getContext: () => ({ ...live }) };
    try {
        const { boot, runtime } = await import('../index.js'); await boot();
        live = mk('B'); live.extensionSettings.beatriceGuide.enabled = false; handlers.get('change')();
        assert.equal(runtime.app.ctx.chatId, 'B'); assert.equal(runtime.app.settings.enabled, false);
        live.extensionSettings.beatriceGuide.enabled = true; handlers.get('settings')();
        assert.equal(runtime.app.settings.enabled, true);
        runtime.app.realmWorldbookGuard?.dispose?.(); runtime.stopDisplayObserver?.();
    } finally { globalThis.SillyTavern = previous; }
});

test('r22 save await cannot continue into a new chat save or memory', async () => {
    const { app, ctx } = setup(); let release, saves = 0;
    ctx.saveMetadata = () => new Promise(r => { release = r; }); ctx.saveChat = async () => { saves++; };
    const pending = app._install(outcome(app), 'save'); await tick();
    app.ctx = { ...ctx, chatId: 'B', chat: [{ mes: 'B prose' }], chatMetadata: {} }; release();
    assert.equal((await pending).ok, false); assert.equal(saves, 0); assert.deepEqual(app.ctx.chatMetadata, {}); app._watchStop?.();
});
