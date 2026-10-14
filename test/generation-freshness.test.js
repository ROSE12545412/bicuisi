import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';

function setup() {
    const ctx = { name2: 'card', chatId: 'A', chat: [{ mes: 'old body' }], chatMetadata: {} };
    const app = new GuideController(ctx, defaultSettings());
    app.syncAdversaryDirector = () => {};
    app.ensureHookPool = async () => ({ ok: true, hooks: [], books: [] });
    app.log = () => {};
    app.debug = () => {};
    return { app, ctx };
}

test('dual start hooks capture source once even after streaming begins', async () => {
    const { app, ctx } = setup();
    app.onGenerationStart();
    const epoch = app._requestEpoch, source = app._generationSource;
    ctx.chat.push({ mes: 'streaming body' });
    app.onGenerationStart();
    assert.equal(app._generationBaseline, 0);
    assert.equal(app._generationSource, source);
    assert.equal(app._requestEpoch, epoch);
    assert.equal(await app.waitForFreshAiMessage(0, 0), 1);
});

for (const [name, change] of [
    ['text', ctx => { ctx.chat[0].mes = 'regenerated'; }],
    ['swipe', ctx => { ctx.chat[0].swipe_id = 1; }],
    ['replacement', ctx => { ctx.chat[0] = { mes: 'old body' }; }],
]) test(`same-floor changed ${name} is fresh without timeout`, async () => {
    const { app, ctx } = setup(); app.onGenerationStart(); change(ctx);
    assert.equal(await app.waitForFreshAiMessage(0, 0), 0);
});

test('unchanged source is not accepted and no old-body fallback exists', async () => {
    const { app } = setup(); app.onGenerationStart();
    assert.equal(await app.waitForFreshAiMessage(0, 0), -1);
    app.waitForFreshAiMessage = async () => -1;
    app.shouldGuide = () => { throw new Error('must not judge old body'); };
    const got = await app.runPostGeneration();
    assert.equal(got.ok, false);
    assert.match(got.error, /等不到刚生成的正文/);
});

test('new genuine generation cancels old singleflight and processes latest target', async () => {
    const { app, ctx } = setup(); let release;
    app.onGenerationStart(); app._generationActive = false;
    const old = app._singleFlight(token => new Promise(resolve => {
        release = () => resolve(app.lifecycleValid(token) ? { ok: true } : app.staleOutcome());
    }));
    await Promise.resolve();
    const oldAbort = app.abort;
    app.onGenerationStart();
    assert.equal(oldAbort.signal.aborted, true);
    assert.equal(app.inflight, null);
    ctx.chat.push({ mes: 'latest body' });
    app.shouldGuide = () => ({ go: false, reason: 'latest target checked' });
    const next = app.runPostGeneration();
    release();
    assert.equal((await old).aborted, true);
    assert.match((await next).error, /latest target checked/);
});

test('chat change clears source and stop releases dual-start dedupe', () => {
    const { app } = setup(); app.onGenerationStart();
    app.onGenerationStopped(); assert.equal(app._generationActive, false);
    const epoch = app._requestEpoch; app.onGenerationStart();
    assert.ok(app._requestEpoch > epoch);
    app.onChatChanged();
    assert.equal(app._generationActive, false);
    assert.equal(app._generationBaseline, undefined);
    assert.equal(app._generationSource, null);
});
