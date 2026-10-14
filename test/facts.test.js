import { test } from './_harness.js';
import assert from 'node:assert/strict';
import { observeFacts, getFactState, clearFactState, formatFactsForPrompt } from '../src/facts.js';

const ai = mes => ({ mes, is_user: false });
const user = mes => ({ mes, is_user: true });
const settings = () => ({ enabled: true, realm: 'good', llm: { mode: 'profile', profileId: 'facts' } });
const fact = (quote = 'Alice opened the door.', index = 1, overrides = {}) => ({ id: 'door', actor: 'Alice', action: 'open door', result: 'Door is open', status: 'confirmed', knowledge: [], evidence: [{ index, quote }], ...overrides });
function fixture(proposals = [fact()]) {
    const ctx = { chatId: 'one', characterId: 0, characters: [{ name: 'Alice', avatar: 'alice.png' }], chatMetadata: { untouched: 42, 'beatrice-guide': { adversary: { retained: true }, spoken: ['keep'] } }, chat: [user('I open it.'), ai('Alice opened the door.')] };
    let calls = 0, request;
    ctx.ConnectionManagerRequestService = { sendRequest: async (_id, messages) => { calls++; request = messages; return JSON.stringify({ proposals }); } };
    return { ctx, settings: settings(), calls: () => calls, request: () => request, respond: p => { ctx.ConnectionManagerRequestService.sendRequest = async (_id, messages) => { calls++; request = messages; return JSON.stringify({ proposals: p }); }; } };
}

test('one shared observation, cloned ledger, duplicate floor and untouched metadata', async () => {
    const f = fixture();
    const result = await observeFacts(f.ctx, f.settings);
    assert.equal(result.ok, true);
    assert.equal(result.ledger.facts[0].status, 'confirmed');
    result.ledger.facts[0].result = 'tampered';
    assert.equal(getFactState(f.ctx).facts[0].result, 'Door is open');
    f.settings.realm = 'void';
    assert.equal((await observeFacts(f.ctx, f.settings)).duplicate, true);
    assert.equal(f.calls(), 1);
    assert.equal(f.ctx.chatMetadata.untouched, 42);
    assert.deepEqual(f.ctx.chatMetadata['beatrice-guide'].adversary, { retained: true });
});

test('forged quotes, user-only assertions and invented knowledge are rejected', async () => {
    const f = fixture([fact('forged'), fact('I open it.', 0), fact(undefined, 1, { knowledge: [{ actor: 'Bob', basis: 'Bob saw it' }] })]);
    assert.equal((await observeFacts(f.ctx, f.settings)).ledger.facts.length, 0);
});

test('semantic negative context cannot be cherry-picked into positive confirmation', async () => {
    for (const prose of ['Alice did not die.', 'Alice almost died.', '如果 Alice 死亡，她可能会离开。', 'Alice might die.']) {
        const f = fixture([fact(prose.includes('die') ? 'die' : '死亡', 1, { id: 'death', result: 'death' })]);
        f.ctx.chat[1].mes = prose;
        assert.equal((await observeFacts(f.ctx, f.settings)).ledger.facts[0].status, 'unknown');
    }
});

test('new contrary evidence upserts same id; unrelated unknown persists', async () => {
    const f = fixture([fact(), fact(undefined, 1, { id: 'other', status: 'unknown' })]);
    await observeFacts(f.ctx, f.settings);
    f.ctx.chat.push(user('Close it.'), ai('Alice closed the door.'));
    f.respond([fact('Alice closed the door.', 3, { status: 'contradicted', result: 'Door is closed' })]);
    const result = await observeFacts(f.ctx, f.settings);
    assert.equal(result.ledger.facts.find(x => x.id === 'door').status, 'contradicted');
    assert.equal(result.ledger.facts.find(x => x.id === 'other').status, 'unknown');
});

test('latest prose is full and prompt contains no adversary or future worldbook payload', async () => {
    const f = fixture([]);
    f.ctx.chat[1].mes = '正文'.repeat(15000) + 'FULL_END';
    f.ctx.chatMetadata['beatrice-guide'].adversary = { secret: 'SECRET_PAYLOAD' };
    f.ctx.extensionSettings = { secret: 'WORLD_BOOK_SECRET' };
    await observeFacts(f.ctx, f.settings);
    const payload = JSON.parse(f.request()[1].content);
    assert.equal(payload.latestProse, f.ctx.chat[1].mes);
    assert.ok(!JSON.stringify(f.request()).includes('SECRET_PAYLOAD'));
    assert.ok(!JSON.stringify(f.request()).includes('WORLD_BOOK_SECRET'));
    assert.match(f.request()[0].content, /World existence is NOT character knowledge/);
});

test('exact prefix rollback catches user edits, swipes, deleted and edited AI', async () => {
    for (const mutate of [ctx => { ctx.chat[2].mes = 'changed'; }, ctx => { ctx.chat[3].swipe_id = 1; }, ctx => { ctx.chat.pop(); }, ctx => { ctx.chat[3].mes = 'edited'; }]) {
        const f = fixture();
        await observeFacts(f.ctx, f.settings);
        f.ctx.chat.push(user('Next'), ai('Alice closed the door.'));
        f.respond([fact('Alice closed the door.', 3, { result: 'closed' })]);
        await observeFacts(f.ctx, f.settings);
        mutate(f.ctx);
        const result = getFactState(f.ctx);
        assert.equal(result.lastTargetIndex, 1);
        assert.equal(result.facts[0].result, 'Door is open');
    }
    const f = fixture();
    await observeFacts(f.ctx, f.settings);
    f.ctx.chat[0].mes = 'old user edit';
    assert.equal(getFactState(f.ctx).facts.length, 0);
});

test('stale replies rejected across metadata/chat/card/realm/llm/clear/source changes', async () => {
    const mutations = [
        f => { f.ctx.chatMetadata = {}; }, f => { f.ctx.chatId = 'two'; },
        f => { f.ctx.chat = [...f.ctx.chat]; }, f => { f.ctx.characters[0].description = 'changed'; },
        f => { f.settings.realm = 'void'; }, f => { f.settings.llm.profileId = 'other'; },
        f => { f.settings.enabled = false; }, f => { clearFactState(f.ctx); },
        f => { f.ctx.chat[0].mes = 'edited'; }, f => { f.ctx.chat[1].swipe_id = 2; },
    ];
    for (const mutate of mutations) {
        const f = fixture();
        let finish;
        f.ctx.ConnectionManagerRequestService.sendRequest = () => new Promise(resolve => { finish = resolve; });
        const pending = observeFacts(f.ctx, f.settings);
        mutate(f);
        finish(JSON.stringify({ proposals: [fact()] }));
        assert.equal((await pending).ok, false);
        assert.equal(getFactState(f.ctx).facts.length, 0);
    }
});

test('cross-chat/card owner isolation and clear preserves unrelated fields', async () => {
    const f = fixture();
    await observeFacts(f.ctx, f.settings);
    f.ctx.chatId = 'two';
    assert.equal(getFactState(f.ctx).facts.length, 0);
    clearFactState(f.ctx);
    assert.deepEqual(f.ctx.chatMetadata['beatrice-guide'].spoken, ['keep']);
    assert.deepEqual(f.ctx.chatMetadata['beatrice-guide'].adversary, { retained: true });
});

test('facts, exact-prefix snapshots, audit and prompt bounded', async () => {
    const f = fixture();
    for (let i = 0; i < 27; i++) {
        const index = f.ctx.chat.length - 1;
        f.respond(Array.from({ length: 4 }, (_, j) => fact('Alice opened the door.', index, { id: `f-${i}-${j}`, result: 'result '.repeat(60) })));
        await observeFacts(f.ctx, f.settings);
        if (i < 26) f.ctx.chat.push(user('next'), ai('Alice opened the door.'));
    }
    const ledger = getFactState(f.ctx);
    assert.equal(ledger.facts.length, 80);
    assert.equal(ledger.snapshots.length, 24);
    assert.equal(ledger.audit.length, 80);
    assert.ok(ledger.snapshots.at(-1).prefix.length === f.ctx.chat.length);
    assert.ok(formatFactsForPrompt(f.ctx).length <= 12000);
    f.ctx.chat[0].mes = 'outside retained history';
    assert.equal(getFactState(f.ctx).facts.length, 0);
});

test('strict JSON and schema failures do not mark floor observed', async () => {
    const f = fixture();
    f.ctx.ConnectionManagerRequestService.sendRequest = async () => '```json\n{"proposals":[]}\n```';
    assert.equal((await observeFacts(f.ctx, f.settings)).ok, false);
    assert.equal(getFactState(f.ctx).lastTargetIndex, -1);
    f.ctx.ConnectionManagerRequestService.sendRequest = async () => '{"proposals":[],"extra":"bad"}';
    assert.equal((await observeFacts(f.ctx, f.settings)).ok, false);
});
