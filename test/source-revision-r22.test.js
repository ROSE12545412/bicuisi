import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import { test, describe } from './_harness.js';
import { capturePoolSourceRevision, validatePoolSourceRevision, collectCandidates } from '../src/worldbook.js';
import { getCharacterPool, setCharacterPool, importAll, getChatData, isCharacterPoolFresh } from '../src/core/store.js';
import { CHAT_KEY, SETTINGS_KEY, defaultSettings } from '../src/config.js';
import { RULE_BOOK } from '../src/realm-worldbook.js';

// Node 18 does not expose WebCrypto globally in all execution modes.
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
function setup() {
    const books = { A: { entries: { 1: { comment: 'title', content: 'head'.repeat(300) + 'middle'.repeat(300) + 'tail' },
        2: { comment: 'empty', content: '', disable: true } } }, B: { entries: {} } };
    const calls = [];
    const ctx = { characterId: 0, characters: [{ avatar: 'a.png' }], extensionSettings: {}, chatMetadata: {},
        loadWorldInfo: async name => { calls.push(name); return books[name]; } };
    return { books, ctx, calls };
}
async function poolFor(ctx, names = ['A']) {
    const captured = await capturePoolSourceRevision(ctx, names);
    assert.equal(captured.ok, true, captured.error);
    return { at: Date.now(), books: names, hooks: [{ book: 'A', uid: 1, label: 'indexed', content: 'custom' }], sourceRevision: captured.revision };
}

describe('R22 full selected-worldbook source revision', () => {
    test('compact SHA-256 is deterministic, order independent, and excludes only the dedicated rule book', async () => {
        const { ctx, books, calls } = setup();
        const first = await poolFor(ctx, ['B', RULE_BOOK, 'A', 'A']);
        assert.deepEqual(first.sourceRevision.books.map(r => r.name), ['A', 'B']);
        assert.ok(first.sourceRevision.books.every(r => /^[a-f0-9]{64}$/.test(r.digest)));
        assert.ok(JSON.stringify(first.sourceRevision).length < 350);
        books.A.entries = { 2: books.A.entries[2], 1: books.A.entries[1] };
        const second = await capturePoolSourceRevision(ctx, ['A', 'B']);
        assert.deepEqual(first.sourceRevision, second.revision);
        assert.ok(!calls.includes(RULE_BOOK));
        assert.equal((await validatePoolSourceRevision(ctx, first)).ok, true);
    });
    for (const [name, mutate] of [
        ['middle content beyond old truncation limits', b => { b.A.entries[1].content = b.A.entries[1].content.replace('middle', 'MIDDLE'); }],
        ['new unindexed entry', b => { b.A.entries[3] = { content: 'new future plot' }; }],
        ['removed entry', b => { delete b.A.entries[2]; }],
        ['title', b => { b.A.entries[1].comment = 'renamed'; }],
        ['disabled empty entry metadata', b => { b.A.entries[2].disable = false; }],
        ['uid', b => { b.A.entries[99] = b.A.entries[1]; delete b.A.entries[1]; }],
        ['nonnumeric uid', b => { b.A.entries.other = b.A.entries[1]; delete b.A.entries[1]; }],
        ['retrieval keys', b => { b.A.entries[1].keys = ['different']; }],
        ['empty selected book addition', b => { b.B.entries[1] = { content: 'later addition' }; }],
    ]) test('same names invalidate on ' + name, async () => {
        const { ctx, books } = setup();
        const pool = await poolFor(ctx, ['A', 'B']);
        mutate(books);
        const result = await validatePoolSourceRevision(ctx, pool);
        assert.equal(result.ok, false);
        assert.equal(result.changed, true);
        assert.ok(result.error);
    });
    test('collection baseline covers original whole books and rejects edits after extraction began', async () => {
        const { ctx, books } = setup();
        const got = await collectCandidates(ctx, { worldbook: { bookNames: ['A', RULE_BOOK] } });
        assert.equal(got.errors.length, 0);
        assert.equal(got.candidates.length, 1);
        assert.equal(got.sourceRevision.books[0].entries, 2);
        books.A.entries[2].content = 'new future event';
        const result = await validatePoolSourceRevision(ctx, { books: got.books, sourceRevision: got.sourceRevision });
        assert.equal(result.changed, true);
    });
    test('old saved custom pools remain unverified and unmodified without reading live books', async () => {
        const { ctx, calls } = setup();
        const saved = setCharacterPool(ctx, [{ label: 'custom', content: 'mine' }], ['A'], { savedAt: 1 });
        const pool = saved.pool;
        assert.deepEqual(await validatePoolSourceRevision(ctx, pool), { ok: true, changed: false, error: '', unverified: true });
        assert.deepEqual(calls, []);
        assert.equal(getCharacterPool(ctx), pool);
        assert.equal(pool.sourceRevision, undefined);
        assert.equal(isCharacterPoolFresh(ctx, defaultSettings(), ['A']), true);
    });
    test('read/hash/abort failures are errors, not changes or successful empty baselines', async () => {
        const { ctx, books } = setup();
        const pool = await poolFor(ctx);
        delete books.A;
        const failed = await validatePoolSourceRevision(ctx, pool);
        assert.equal(failed.ok, false); assert.equal(failed.changed, false); assert.ok(failed.error);
        const signal = AbortSignal.abort();
        assert.equal((await capturePoolSourceRevision(ctx, ['A'], { signal })).ok, false);
        assert.equal((await validatePoolSourceRevision(ctx, pool, { signal })).ok, false);
        assert.equal((await validatePoolSourceRevision(ctx, { ...pool, sourceRevision: {} })).ok, false);
        const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
        try { assert.equal((await capturePoolSourceRevision(ctx, [])).ok, false); }
        finally { Object.defineProperty(globalThis, 'crypto', original); }
    });
    test('migration, pool extras, and imported legacy chat preserve source metadata safely', async () => {
        const { ctx } = setup();
        const pool = await poolFor(ctx);
        ctx.chatMetadata[CHAT_KEY] = { hookPool: { ...pool, savedAt: 123, source: 'manual' } };
        const migrated = getCharacterPool(ctx);
        assert.deepEqual(migrated.sourceRevision, pool.sourceRevision);
        assert.equal(migrated.savedAt, 123);
        const payload = JSON.parse('{"settings":{"__proto__":{"polluted":true},"worldbook":{"constructor":{"prototype":{"polluted":true}}}},"chatData":{"__proto__":{"polluted":true},"hookPool":null}}');
        payload.chatData.hookPool = pool;
        assert.equal(importAll(ctx, payload).ok, true);
        assert.equal({}.polluted, undefined);
        assert.equal(Object.hasOwn(ctx.extensionSettings[SETTINGS_KEY], '__proto__'), false);
        assert.equal(Object.hasOwn(ctx.extensionSettings[SETTINGS_KEY].worldbook, 'constructor'), false);
        assert.deepEqual(getChatData(ctx).hookPool.sourceRevision, pool.sourceRevision);
        for (const malformed of [[], { settings: [] }, { chatData: 'bad' }, { settings: null }]) {
            assert.equal(importAll(ctx, malformed).ok, false);
        }
    });
});
