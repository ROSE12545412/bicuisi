import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { buildFullContentBatches } from '../src/worldbook.js';
import { GuideController } from '../src/app.js';
import { LlmClient } from '../src/llm/client.js';
import { defaultSettings } from '../src/config.js';
import { getCharacterPool, setCharacterPool } from '../src/core/store.js';

function setup(indexed = true) {
    const settings = defaultSettings();
    settings.worldbook.bookNames = ['Selected'];
    settings.worldbook.buildIndex = indexed;
    settings.worldbook.scanMaxChars = settings.worldbook.scanBatchChars = 512;
    settings.worldbook.scanMaxEntries = settings.worldbook.scanBatchEntries = 1;
    const entries = {
        1: { comment: '杂项', content: '静态说明'.repeat(180) + '末尾未来事件：明晚船长艾拉登场。', disable: true },
        2: { comment: '数值', content: '力量10防御20', constant: true },
        3: { comment: '[禁止引导] 后续', content: '后续未来事件：王都政变。' },
    };
    const ctx = { characterId: 0, characters: [{ name: 'Alice', avatar: 'alice.png' }], chatId: 'a',
        extensionSettings: {}, chatMetadata: {}, chat: [], loadWorldInfo: async () => ({ entries }) };
    const app = new GuideController(ctx, settings);
    app.channelStatus = () => ({ ready: true });
    app.persistSettings = async () => ({ ok: true });
    return { app, ctx, entries };
}

describe('Exhaustive plot scan', () => {
    test('bounded batches preserve every source character, including final facts and surrogate pairs', () => {
        const entries = [{ book: 'A', uid: 1, content: '😀abc'.repeat(500) + 'END-FACT' },
            ...Array.from({ length: 40 }, (_, uid) => ({ book: 'A', uid: uid + 2, content: 'tail-' + uid }))];
        const batches = buildFullContentBatches(entries, { maxCharsTotal: 512, maxEntries: 2 });
        assert.ok(batches.every(b => b.chars <= 512 && b.used.length <= 2));
        for (const [i, entry] of entries.entries()) {
            const parts = batches.flatMap(b => b.segments).filter(s => s.entryIndex === i);
            assert.equal(parts.map(p => entry.content.slice(p.start, p.end)).join(''), entry.content);
        }
        assert.ok(batches.some(b => b.text.includes('END-FACT')));
    });
    for (const indexed of [true, false]) test('both modes read all entries and keep selected-only future plots: ' + indexed, async () => {
        const { app, ctx } = setup(indexed);
        const original = LlmClient.prototype.complete;
        const sent = [];
        LlmClient.prototype.complete = async req => {
            sent.push(req.user);
            const extracting = req.user.includes('确认后剧情提取批次');
            const selected = extracting || req.user.includes('未来事件');
            return { ok: true, text: JSON.stringify({ index: selected ? [{ index: 1, brief: '未来剧情', phase: '明晚', events: ['未来事件'], characters: ['艾拉'] }] : [] }) };
        };
        try {
            const result = await app.buildHookPool({ force: true });
            assert.equal(result.ok, true, result.error);
            assert.equal(result.coverage.complete, true);
            assert.equal(result.coverage.entries, 3);
            assert.ok(sent.some(text => text.includes('末尾未来事件')));
            assert.equal(result.needsConfirmation, true);
            assert.deepEqual(result.hooks, [], 'scan must not expose published hooks');
            assert.equal(getCharacterPool(ctx), null, 'no pool may exist before human confirmation');
            assert.deepEqual(result.selectedIndices.map(i => result.candidates[i].uid), [1, 3]);
            const confirmed = await app.confirmHookPoolSelection(result.selectedIndices, { reviewId: result.reviewId });
            assert.equal(confirmed.ok, true, confirmed.error);
            assert.deepEqual(confirmed.hooks.map(h => h.uid), [1, 3]);
            assert.equal(getCharacterPool(ctx).hooks.length, 2);
        } finally { LlmClient.prototype.complete = original; }
    });
    test('failed selected-body extraction preserves the old pool and never publishes a partial replacement', async () => {
        const { app, ctx } = setup();
        setCharacterPool(ctx, [{ label: 'OLD', content: 'original' }], ['Selected']);
        const old = getCharacterPool(ctx);
        const original = LlmClient.prototype.complete;
        LlmClient.prototype.complete = async () => ({ ok: true, text: '{"index":[{"index":1,"brief":"future","phase":"后续"}]}' });
        try {
            const review = await app.buildHookPool({ force: true });
            assert.equal(review.ok, true, review.error);
            assert.equal(review.needsConfirmation, true);
            assert.deepEqual(getCharacterPool(ctx), old, 'scan must preserve the previous confirmed pool');
            LlmClient.prototype.complete = async () => ({ ok: false, error: 'selected extraction failed' });
            const failed = await app.confirmHookPoolSelection(review.selectedIndices, { reviewId: review.reviewId });
            assert.equal(failed.ok, false);
            assert.deepEqual(getCharacterPool(ctx), old);
        } finally { LlmClient.prototype.complete = original; }
    });
    test('required batch failure cannot publish a partial pool', async () => {
        const { app, ctx } = setup();
        setCharacterPool(ctx, [{ label: 'OLD', content: 'original' }], ['Selected']);
        const old = getCharacterPool(ctx);
        const original = LlmClient.prototype.complete;
        let calls = 0;
        LlmClient.prototype.complete = async () => ++calls === 1 ? { ok: true, text: '{"index":[{"index":1,"brief":"candidate","phase":"后续"}]}' } : { ok: false, error: 'batch failed' };
        try {
            const result = await app.buildHookPool({ force: true });
            assert.equal(result.ok, false);
            assert.equal(result.coverage.completedBatches, 1);
            assert.deepEqual(getCharacterPool(ctx), old);
        } finally { LlmClient.prototype.complete = original; }
    });
    test('malformed or invalid selected rows never replace previous pool', async () => {
        for (const text of ['garbled output', '{"index":[{"index":1,"brief":"truncated"}]', '{"index":[{"index":999,"brief":"wrong"}]}']) {
            const { app, ctx } = setup();
            setCharacterPool(ctx, [{ label: 'OLD' }], ['Selected']);
            const old = getCharacterPool(ctx);
            const original = LlmClient.prototype.complete;
            LlmClient.prototype.complete = async () => ({ ok: true, text });
            try {
                assert.equal((await app.buildHookPool({ force: true })).ok, false);
                assert.deepEqual(getCharacterPool(ctx), old);
            } finally { LlmClient.prototype.complete = original; }
        }
    });
    test('identity switches during a scan cannot publish or attach manual candidates', async () => {
        const { app, ctx } = setup();
        const original = LlmClient.prototype.complete;
        LlmClient.prototype.complete = async () => {
            ctx.chatId = 'changed';
            return { ok: true, text: '{"index":[{"index":1,"brief":"future"}]}' };
        };
        try {
            assert.equal((await app.buildHookPool({ force: true })).ok, false);
            assert.equal(getCharacterPool(ctx), null);
            assert.equal(app.lastScanCandidates, undefined);
        } finally { LlmClient.prototype.complete = original; }
    });
    test('explicit save reports persistence failure and preserves source metadata', async () => {
        const { app, ctx } = setup();
        setCharacterPool(ctx, [{ label: 'x' }], ['Selected'], { indexed: true, coverage: { complete: true } });
        app.persistSettings = async () => ({ ok: false, error: 'disk failure' });
        assert.equal((await app.saveHookPool()).ok, false);
        app.persistSettings = async () => ({ ok: true });
        const saved = await app.saveHookPool();
        assert.equal(saved.ok, true);
        assert.equal(saved.pool.indexed, true);
        assert.equal(saved.pool.coverage.complete, true);
        assert.ok(saved.pool.savedAt);
    });
});
