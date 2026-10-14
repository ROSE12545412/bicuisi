import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { GuideController } from '../src/app.js';
import { LlmClient } from '../src/llm/client.js';
import { defaultSettings } from '../src/config.js';
import { getCharacterPool, setCharacterPool } from '../src/core/store.js';

function setup() {
    const settings = defaultSettings();
    settings.worldbook.bookNames = ['Selected'];
    settings.worldbook.scanBatchChars = 512;
    settings.worldbook.scanBatchEntries = 1;
    const entries = {
        1: { comment: 'first', content: 'FIRST-FULL ' + '未来事件'.repeat(220) + ' FIRST-END' },
        2: { comment: 'second', content: 'SECOND-FULL 人物登场 SECOND-END' },
    };
    const ctx = { characterId: 0, characters: [{ name: 'Alice', avatar: 'alice.png' }],
        chatId: 'a', extensionSettings: {}, chatMetadata: {}, chat: [], loadWorldInfo: async () => ({ entries }) };
    const app = new GuideController(ctx, settings);
    app.channelStatus = () => ({ ready: true });
    let saves = 0;
    app.persistSettings = async () => { saves++; return { ok: true }; };
    return { app, ctx, settings, saves: () => saves };
}

async function mock(fn, body) {
    const original = LlmClient.prototype.complete;
    LlmClient.prototype.complete = fn;
    try { await body(); } finally { LlmClient.prototype.complete = original; }
}
const readReply = { ok: true, text: '{"picks":[{"index":1,"reason":"future"}]}' };
const extractReply = { ok: true, text: '{"index":[{"index":1,"brief":"future event","phase":"later","events":["event"],"characters":["Alice"]}]}' };

describe('Human-confirmed full scan', () => {
    test('reading creates transient review only; confirms edited zero-based selection using full originals', async () => {
        const { app, ctx, saves } = setup();
        setCharacterPool(ctx, [{ label: 'OLD', content: 'protected' }], ['Selected']);
        const old = getCharacterPool(ctx);
        const calls = [], progress = [];
        await mock(async req => { calls.push(req); return req.user.includes('确认后剧情提取') ? extractReply : readReply; }, async () => {
            const review = await app.buildHookPool({ force: true, onProgress: p => progress.push(p) });
            assert.equal(review.ok, true, review.error);
            assert.equal(review.needsConfirmation, true);
            assert.deepEqual(review.selectedIndices, [0, 1]);
            assert.ok(review.candidates[0].content.endsWith('FIRST-END'));
            assert.equal(saves(), 0);
            assert.equal(getCharacterPool(ctx), old);
            assert.ok(calls.every(r => !r.system.includes('剧情索引提取')));
            const confirmed = await app.confirmHookPoolSelection([1], { reviewId: review.reviewId, onProgress: p => progress.push(p) });
            assert.equal(confirmed.ok, true, confirmed.error);
            assert.deepEqual(confirmed.hooks.map(h => h.uid), [2]);
            const extracted = calls.filter(r => r.system.includes('剧情索引提取'));
            assert.equal(extracted.length, 1);
            assert.ok(extracted[0].user.includes('SECOND-FULL 人物登场 SECOND-END'));
            assert.ok(!extracted[0].user.includes('FIRST-FULL'));
            assert.equal(saves(), 1);
            assert.equal(app.getHookPoolReview(), null);
            for (const stage of ['reading', 'extracting']) {
                const events = progress.filter(p => p.stage === stage);
                assert.equal(events[0].percent, 0);
                assert.equal(events.at(-1).percent, 100);
                assert.ok(events.every(p => p.percent === p.completedCalls / p.totalCalls * 100));
            }
        });
    });
    test('automatic ensure reuses pending draft and never confirms', async () => {
        const { app, saves } = setup();
        let calls = 0;
        await mock(async () => { calls++; return readReply; }, async () => {
            const first = await app.ensureHookPool({ silent: true });
            assert.equal(first.ok, false);
            assert.equal(first.needsConfirmation, true);
            const count = calls;
            const second = await app.ensureHookPool({ silent: true });
            assert.equal(second.reviewId, first.reviewId);
            assert.equal(calls, count);
            assert.equal(saves(), 0);
            assert.ok(app.getHookPoolReview());
        });
    });
    test('identity or book drift before confirmation prevents extraction', async () => {
        for (const drift of [s => { s.ctx.chatId = 'other'; }, s => { s.settings.worldbook.bookNames = ['Other']; },
            s => { setCharacterPool(s.ctx, [{ label: 'manual' }], ['Selected'], { editedAt: 123 }); }]) {
            const s = setup();
            let calls = 0;
            await mock(async () => { calls++; return readReply; }, async () => {
                const review = await s.app.buildHookPool({ force: true });
                const before = calls;
                drift(s);
                assert.equal((await s.app.confirmHookPoolSelection([0], { reviewId: review.reviewId })).ok, false);
                assert.equal(calls, before);
                assert.equal(s.saves(), 0);
            });
        }
    });
    test('extracts long selected originals completely across bounded batches', async () => {
        const { app } = setup();
        const extracted = [];
        await mock(async req => {
            if (req.user.includes('确认后剧情提取')) { extracted.push(req.user); return extractReply; }
            return readReply;
        }, async () => {
            const review = await app.buildHookPool({ force: true });
            const result = await app.confirmHookPoolSelection([0], { reviewId: review.reviewId });
            assert.equal(result.ok, true, result.error);
            assert.ok(extracted.length > 1);
            assert.ok(extracted[0].includes('FIRST-FULL'));
            assert.ok(extracted.at(-1).includes('FIRST-END'));
            assert.ok(extracted.every(text => !text.includes('SECOND-FULL')));
        });
    });
    test('failed extraction, malformed JSON, drift and false persistence retain old pool', async () => {
        for (const failure of ['api', 'json', 'identity', 'books', 'persist']) {
            const { app, ctx, settings } = setup();
            setCharacterPool(ctx, [{ label: 'OLD' }], ['Selected']);
            const old = getCharacterPool(ctx);
            await mock(async req => {
                if (!req.user.includes('确认后剧情提取')) return readReply;
                if (failure === 'api') return { ok: false, error: 'network failure' };
                if (failure === 'json') return { ok: true, text: extractReply.text.slice(0, -1) };
                if (failure === 'identity') ctx.chatId = 'other';
                if (failure === 'books') settings.worldbook.bookNames = ['Other'];
                return extractReply;
            }, async () => {
                const review = await app.buildHookPool({ force: true });
                if (failure === 'persist') app.persistSettings = async () => false;
                const result = await app.confirmHookPoolSelection([1], { reviewId: review.reviewId });
                assert.equal(result.ok, false, failure);
                assert.equal(getCharacterPool(ctx), old, failure);
            });
        }
    });
    test('concurrent reading shares one scan and confirmation cannot publish twice', async () => {
        const { app, saves } = setup();
        let calls = 0;
        await mock(async req => { calls++; return req.user.includes('确认后剧情提取') ? extractReply : readReply; }, async () => {
            const [a, b] = await Promise.all([app.buildHookPool({ force: true }), app.buildHookPool({ force: true })]);
            assert.equal(a.reviewId, b.reviewId);
            const reads = calls;
            assert.equal(reads, a.coverage.batches);
            const results = await Promise.all([app.confirmHookPoolSelection([1], { reviewId: a.reviewId }), app.confirmHookPoolSelection([1], { reviewId: a.reviewId })]);
            assert.equal(results.filter(r => r.ok).length, 1);
            assert.equal(saves(), 1);
        });
    });
});
