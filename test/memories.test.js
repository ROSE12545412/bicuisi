import assert from 'node:assert/strict';
import { test, describe } from './run.js';
import { recordGuidance, getMemoryState, toggleMemoryBookmark, syncDiaryFromFacts, removeDiaryMemory, getMemoryPrompt, clearMemoryCollection, buildCausalRecap } from '../src/memories.js';

const context = () => ({ chatId: 'one', characterId: 0, characters: [{ avatar: 'betty.png', name: 'Betty' }],
    chatMetadata: {}, chat: [{ mes: 'Alice opened the door.', name: 'Betty', swipe_id: 0 }] });
const fact = (id = 'door', index = 0, quote = 'Alice opened the door.') => ({ id, actor: 'Alice', action: 'opened the door', result: 'door open', status: 'confirmed', knowledge: [], evidence: [{ index, quote }] });
const record = ctx => recordGuidance(ctx, { index: 0, realm: 'beatrice', guidance: 'Look by the door.', commentary: '笨蛋，仔细看看呀。', sources: [{ book: 'secret-book', uid: 2, label: 'secret-label', content: 'SECRET future' }] });

describe('Evidence-bound memories', () => {
    test('records explicit bookmarks, detached view and historical mode', () => {
        const ctx = context(), row = record(ctx);
        assert.ok(row); assert.equal(row.bookmarked, false);
        assert.equal(record(ctx).id, row.id);
        assert.equal(toggleMemoryBookmark(ctx, row.id), true);
        const view = getMemoryState(ctx);
        assert.deepEqual(view.bookmarks, [row.id]);
        view.reminders[0].guidance = 'tampered';
        assert.equal(getMemoryState(ctx).reminders[0].guidance, 'Look by the door.');
        ctx.realm = 'void';
        assert.equal(getMemoryState(ctx).reminders[0].mode, 'beatrice');
        assert.equal(toggleMemoryBookmark(ctx, row.id), false);
    });
    test('exact edit, swipe and delete invalidate guidance and diary', () => {
        for (const change of [ctx => { ctx.chat[0].mes += ' Another sentence.'; }, ctx => { ctx.chat[0].swipe_id = 1; }, ctx => { ctx.chat = []; }]) {
            const ctx = context(); record(ctx); syncDiaryFromFacts(ctx, [fact()]); change(ctx);
            assert.equal(getMemoryState(ctx).reminders.length, 0); assert.equal(getMemoryState(ctx).diary.length, 0);
        }
    });
    test('identical-content replacement branch invalidates through exact message object identity', () => {
        const ctx = context(); record(ctx); syncDiaryFromFacts(ctx, [fact()]);
        ctx.chat[0] = { ...ctx.chat[0] };
        assert.equal(getMemoryState(ctx).reminders.length, 0); assert.equal(getMemoryState(ctx).diary.length, 0);
    });
    test('earlier prefix edits invalidate dependent memories, normal appends do not', () => {
        const ctx = context(); ctx.chat.push({ mes: 'Alice sat down.', name: 'Betty' });
        recordGuidance(ctx, { index: 1, guidance: 'Stay alert.' });
        syncDiaryFromFacts(ctx, [fact('sit', 1, 'Alice sat down.')]);
        ctx.chat.push({ mes: 'A new reply.', name: 'Betty' });
        assert.equal(getMemoryState(ctx).diary.length, 1);
        ctx.chat[0].mes = 'Different start.';
        assert.equal(getMemoryState(ctx).diary.length, 0); assert.equal(getMemoryState(ctx).reminders.length, 0);
    });
    test('persisted provenance survives JSON reload but not changed owner/card', () => {
        const ctx = context(); record(ctx); syncDiaryFromFacts(ctx, [fact()]);
        const reload = JSON.parse(JSON.stringify(ctx));
        assert.equal(getMemoryState(reload).diary.length, 1);
        reload.characters[0].avatar = 'another.png';
        assert.equal(getMemoryState(reload).diary.length, 0);
        ctx.chatId = 'two'; assert.equal(getMemoryState(ctx).reminders.length, 0);
    });
    test('rejects user attempts, unknown, contradictions, injected/system and forged quotes', () => {
        for (const mutate of [f => { f.status = 'unknown'; }, f => { f.status = 'contradicted'; }, f => { f.evidence[0].quote = 'false'; }]) {
            const ctx = context(), f = fact(); mutate(f); assert.equal(syncDiaryFromFacts(ctx, [f]).diary.length, 0);
        }
        for (const flags of [{ is_user: true }, { is_system: true }, { extra: { beatriceGuide: { injected: true } } }]) {
            const ctx = context(); Object.assign(ctx.chat[0], flags);
            assert.equal(syncDiaryFromFacts(ctx, [fact()]).diary.length, 0); assert.equal(record(ctx), null);
        }
        const ctx = context(); ctx.chat[0].mes = 'Alice might have opened the door.';
        assert.equal(syncDiaryFromFacts(ctx, [fact('maybe', 0, ctx.chat[0].mes)]).diary.length, 0);
    });
    test('contradicted later upsert removes old confirmed memory', () => {
        const ctx = context(); syncDiaryFromFacts(ctx, [fact()]);
        assert.equal(syncDiaryFromFacts(ctx, [{ ...fact(), status: 'contradicted' }]).diary.length, 0);
    });
    test('forget suppresses future resync of same proven id/source, including reload', () => {
        const ctx = context(), diary = syncDiaryFromFacts(ctx, [fact()]).diary[0];
        assert.equal(removeDiaryMemory(ctx, diary.id), true);
        assert.equal(syncDiaryFromFacts(ctx, [fact()]).diary.length, 0);
        const reloaded = JSON.parse(JSON.stringify(ctx));
        assert.equal(syncDiaryFromFacts(reloaded, [fact()]).diary.length, 0);
        ctx.chat.push({ mes: 'Alice opened the door.', name: 'Betty' });
        assert.equal(syncDiaryFromFacts(ctx, [fact('door', 1)]).diary.length, 1);
    });
    test('prompt is bounded last-six events only, excludes sources bookmarks void commentary', () => {
        const ctx = context(); const row = record(ctx); toggleMemoryBookmark(ctx, row.id);
        recordGuidance(ctx, { index: 0, realm: 'void', commentary: 'HITOGAMI SECRET' });
        const facts = Array.from({ length: 10 }, (_, i) => ({ ...fact(`f${i}`), action: `action${i}` }));
        syncDiaryFromFacts(ctx, facts);
        const prompt = getMemoryPrompt(ctx);
        assert.ok(prompt.includes('action9')); assert.ok(!prompt.includes('action3'));
        for (const secret of ['SECRET', 'HITOGAMI', 'Look by', 'secret-book', 'quote', 'index']) assert.ok(!prompt.includes(secret));
        assert.ok(getMemoryPrompt(ctx, { maxChars: 160 }).length <= 160);
        assert.equal(getMemoryPrompt(ctx, { maxChars: 0 }), '');
    });
    test('caps reminders and diary, supports explicit scoped clears', () => {
        const ctx = context();
        for (let i = 0; i < 125; i++) recordGuidance(ctx, { index: 0, guidance: `guidance ${i}` });
        assert.equal(getMemoryState(ctx).reminders.length, 120);
        const id = getMemoryState(ctx).reminders[0].id; toggleMemoryBookmark(ctx, id);
        syncDiaryFromFacts(ctx, Array.from({ length: 85 }, (_, i) => fact(`fact${i}`)));
        assert.equal(getMemoryState(ctx).diary.length, 80);
        assert.equal(clearMemoryCollection(ctx, 'bad'), false);
        assert.equal(clearMemoryCollection(ctx, 'bookmarks'), true);
        assert.equal(getMemoryState(ctx).bookmarks.length, 0); assert.equal(getMemoryState(ctx).diary.length, 80);
        assert.equal(clearMemoryCollection(ctx, 'diary'), true);
        assert.equal(syncDiaryFromFacts(ctx, Array.from({ length: 85 }, (_, i) => fact(`fact${i}`))).diary.length, 0);
        clearMemoryCollection(ctx, 'all'); assert.equal(getMemoryState(ctx).reminders.length, 0);
    });
    test('corrupt imported containers and rows fail closed without pollution', () => {
        for (const value of [null, [], 'broken', { version: 1, reminders: [null], diary: [null] }]) {
            const ctx = context(); ctx.chatMetadata['beatrice-guide'] = { memories: value };
            assert.equal(getMemoryState(ctx).diary.length, 0);
        }
        const ctx = context(); record(ctx); syncDiaryFromFacts(ctx, [fact()]);
        ctx.chatMetadata['beatrice-guide'].memories.diary[0].prefix = [null];
        assert.equal(getMemoryState(ctx).diary.length, 0);
        assert.equal(getMemoryState(null).reminders.length, 0);
        assert.equal(recordGuidance(null, { index: 0, guidance: 'x' }), null);
        assert.equal({}.polluted, undefined);
    });
});

describe('Explicit ended-plot causal recap', () => {
    const ended = stage => ({ id: stage, stage, plan: { objective: `ended-${stage}` }, traceIndex: 1, criticalIndex: 3,
        failedIndex: 5, evidence: [{ index: 1, quote: 'A footprint remained.' }, { index: 5, quote: 'The outcome occurred.' }], brokenConditions: ['c1'] });
    test('default locked result does not even read private ledger', () => {
        const state = { get plots() { throw Error('must not inspect'); } };
        assert.equal(buildCausalRecap(state).locked, true);
        assert.equal(buildCausalRecap(state, { spoilers: 'true' }).locked, true);
    });
    test('opt-in only enumerates actual terminal schema stages and never active audit/plan data', () => {
        const active = ['planned', 'trace', 'critical', 'completed'].map(stage => ({ id: 'ACTIVE_SECRET', stage, plan: { objective: 'ACTIVE_SECRET' } }));
        const result = buildCausalRecap({ plots: [...active, ...['failed', 'resolved', 'dead'].map(ended)], audit: [{ reason: 'ACTIVE_AUDIT_SECRET' }] }, { spoilers: true });
        assert.equal(result.locked, false); assert.equal(result.plots.length, 3);
        assert.ok(!JSON.stringify(result).includes('ACTIVE'));
        assert.deepEqual(result.plots[0].trace.evidence, [{ index: 1, quote: 'A footprint remained.' }]);
        assert.equal(result.plots[0].opportunity.confirmed, false);
        assert.ok(result.plots[0].missing.includes('causeFactIds'));
    });
    test('missing/corrupt evidence cannot invent opportunity or chain', () => {
        const result = buildCausalRecap({ plots: [{ ...ended('failed'), evidence: [null, { index: -1, quote: 'invalid' }] }] }, { spoilers: true });
        assert.deepEqual(result.plots[0].trace.evidence, []);
        assert.deepEqual(result.plots[0].result.evidence, []);
        assert.equal(result.plots[0].opportunity.confirmed, false);
        assert.deepEqual(buildCausalRecap(null, { spoilers: true }).plots, []);
    });
});
