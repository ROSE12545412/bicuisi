import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { applyTurn, observeAdversary } from '../src/adversary.js';
import { observeFacts, getFactState } from '../src/facts.js';
import { LlmClient } from '../src/llm/client.js';

const ai = mes => ({ mes, is_user: false });
const user = mes => ({ mes, is_user: true });
const settings = { enabled: true, realm: 'void', llm: {}, adversary: { enabled: true, allowDeath: true } };
const plan = { type: 'plan', plotId: 'p', plan: { objective: 'trap Ash', traceObjective: 'red wire', apprentice: { name: 'Ash', introduce: false, evidence: [{ index: 0, quote: 'Ash prepared the gate trap.' }] }, conditions: [{ id: 'g', event: 'gate locked', counter: 'wire cut' }] } };
const fact = (id, actor, action, result, index, quote, status = 'confirmed') => ({ id, actor, action, result, status, knowledge: [], evidence: [{ index, quote }] });
function fixture(stage = 'trace') {
    const chat = [ai('Ash prepared the gate trap.'), user('Look'), ai('A red wire glints beside Ash.'), user('Approach'), ai('The gate locked behind Ash.')];
    let ledger = applyTurn({ plots: [], audit: [], snapshots: [], lastTargetIndex: -1 }, [plan], chat, settings, 0);
    ledger.plots[0].stage = stage; ledger.plots[0].traceIndex = 2;
    ledger.plots[0].criticalIndex = stage === 'critical' ? 4 : null;
    ledger.lastTargetIndex = stage === 'critical' ? 4 : 2;
    return { ledger, chat, facts: [fact('cause', 'Ash', 'prepare trap', 'ready', 0, chat[0].mes)] };
}
function proposal(f, kind, index, quote, opts = {}) {
    const action = kind === 'counter' ? 'wire cut' : kind === 'trace' ? 'red wire' : kind === 'death' ? 'death' : 'gate locked';
    const r = { kind, conditionId: 'g', actor: 'Ash', action, result: kind === 'death' ? 'dead' : 'completed', status: 'confirmed', factId: `f-${kind}`, causeFactIds: ['cause'], evidence: [{ index, quote, conditionId: 'g' }], ...opts };
    f.facts.push(fact(r.factId, r.actor, r.action, r.result, index, quote, r.status));
    return { type: kind === 'counter' ? 'counter' : 'advance', plotId: 'p', stage: kind === 'trace' ? 'trace' : 'critical', evidence: r.evidence, results: [r] };
}
const reduce = (f, p, index) => applyTurn(f.ledger, p, f.chat, settings, index, { facts: f.facts });

describe('r22 semantic adversary boundary', () => {
    test('no automatic counter invalidation: mention, negation and even confirmed prose without proposal leave plan intact', () => {
        for (const mes of ['The attempt failed: no wire cut occurred.', 'Ash discussed a wire cut.', 'The wire cut successfully.']) {
            const f = fixture(); f.chat[4] = ai(mes);
            assert.equal(reduce(f, [], 4).plots[0].stage, 'trace');
        }
    });
    test('substring-only event proposal no longer advances; uncertain linked assessments reject', () => {
        const f = fixture();
        const legacy = { type: 'advance', plotId: 'p', stage: 'critical', evidence: [{ index: 4, quote: 'gate locked', conditionId: 'g' }] };
        assert.equal(reduce(f, [legacy], 4).plots[0].stage, 'trace');
        for (const mes of ['It was not true that the gate locked.', 'No gate locked; nobody died.', 'If the gate locked, Ash would die.', 'Ash almost died when the gate locked.', '据说门锁闭合，Ash可能死亡。']) {
            const g = fixture(); g.chat[4] = ai(mes);
            const p = proposal(g, 'event', 4, mes);
            assert.equal(reduce(g, [p], 4).plots[0].stage, 'trace', mes);
        }
        const g = fixture(); const p = proposal(g, 'event', 4, g.chat[4].mes, { status: 'unknown' });
        assert.equal(reduce(g, [p], 4).plots[0].stage, 'trace');
    });
    test('actual completion uses semantic fact/action links, not literal plan substring; unrelated history does not veto crisis', () => {
        const f = fixture(); f.chat[4] = ai('The barrier sealed shut behind Ash. His father died years ago.');
        const p = proposal(f, 'event', 4, 'The barrier sealed shut behind Ash.');
        assert.equal(reduce(f, [p], 4).plots[0].stage, 'critical');
    });
    test('counter requires confirmed target semantics, exact quote, saved condition and prior causality', () => {
        const f = fixture(); f.chat[4] = ai('Ash severed the wire and disabled the trap.');
        const p = proposal(f, 'counter', 4, f.chat[4].mes);
        assert.equal(reduce(f, [p], 4).plots[0].stage, 'failed');
        for (const mutate of [p => { p.results[0].causeFactIds = []; }, p => { p.results[0].factId = 'invented'; }, p => { p.results[0].conditionId = 'invented'; }, p => { p.results[0].actor = 'Other'; }, p => { p.results[0].result = 'invented success'; }, p => { p.results[0].evidence[0].quote = 'fabricated'; }]) {
            const g = fixture(); g.chat[4] = ai('Ash severed the wire and disabled the trap.');
            const q = proposal(g, 'counter', 4, g.chat[4].mes); mutate(q);
            assert.equal(reduce(g, [q], 4).plots[0].stage, 'trace');
        }
        const g = fixture(); g.chat[4] = ai('The attempt failed: no wire cut occurred.');
        assert.equal(reduce(g, [proposal(g, 'counter', 4, 'wire cut')], 4).plots[0].stage, 'trace');
    });
    test('death requires explicit victim death result and target factual quote, not unrelated history or negation', () => {
        for (const mes of ['The gate locked. Ash died.', 'The gate locked. Ash did not die.', 'The gate locked. Ash remembered his father died years ago.']) {
            const f = fixture('critical'); f.chat.push(user('Escape'), ai(mes));
            const p = proposal(f, 'event', 6, 'The gate locked.'); p.stage = 'dead';
            assert.equal(reduce(f, [p], 6).plots[0].stage, 'critical'); // no victim result
            const deathQuote = mes.slice('The gate locked. '.length);
            const d = proposal(f, 'death', 6, deathQuote);
            p.results.push(...d.results); p.evidence = [...p.evidence, ...d.evidence];
            assert.equal(reduce(f, [p], 6).plots[0].stage, mes === 'The gate locked. Ash died.' ? 'dead' : 'critical');
        }
    });
    test('new events must be on target AI, not earlier floors, user assertions or new same-floor causes', () => {
        for (const index of [3, 2]) {
            const f = fixture(); const p = proposal(f, 'event', index, f.chat[index].mes);
            assert.equal(reduce(f, [p], 4).plots[0].stage, 'trace');
        }
        const f = fixture(); const p = proposal(f, 'event', 4, f.chat[4].mes);
        p.results[0].causeFactIds = [p.results[0].factId];
        assert.equal(reduce(f, [p], 4).plots[0].stage, 'trace');
    });
});

const context = mes => ({ chatId: 'facts-r22', name2: 'Ash', chatMetadata: {}, chat: [ai(mes)] });
async function observed(ctx, proposals) {
    const old = LlmClient.prototype.complete;
    LlmClient.prototype.complete = async () => ({ ok: true, text: JSON.stringify({ proposals }) });
    try { return await observeFacts(ctx, settings); } finally { LlmClient.prototype.complete = old; }
}
describe('r22 neutral facts provenance and negation scope', () => {
    test('unrelated sentence negation does not contaminate actual completion; cherry-picked negated predicate stays unknown', async () => {
        const ctx = context('Alice did not die. Alice opened the door.');
        const out = await observed(ctx, [fact('door', 'Alice', 'open door', 'open', 0, 'Alice opened the door.'), fact('death', 'Alice', 'death', 'dead', 0, 'die')]);
        assert.equal(out.ledger.facts.find(f => f.id === 'door').status, 'confirmed');
        assert.equal(out.ledger.facts.find(f => f.id === 'death').status, 'unknown');
        const chinese = context('Alice没有死亡。Alice打开了门。');
        assert.equal((await observed(chinese, [fact('door', 'Alice', 'open door', 'open', 0, 'Alice打开了门。')])).ledger.facts[0].status, 'confirmed');
    });
    test('null/corrupt snapshot schemas fail safely and snapshotless nonempty facts are discarded', async () => {
        for (const snapshot of [null, {}, { prefix: [], state: null }, { prefix: [], state: { facts: [null], audit: [], lastTargetIndex: -1 } }]) {
            const ctx = context('Alice opened the door.'); await observed(ctx, [fact('door', 'Alice', 'open door', 'open', 0, ctx.chat[0].mes)]);
            ctx.chatMetadata['beatrice-guide'].facts.snapshots = [snapshot];
            assert.doesNotThrow(() => getFactState(ctx)); assert.equal(getFactState(ctx).facts.length, 0);
        }
        const ctx = context('Alice opened the door.'); await observed(ctx, [fact('door', 'Alice', 'open door', 'open', 0, ctx.chat[0].mes)]);
        ctx.chatMetadata['beatrice-guide'].facts.snapshots = [];
        ctx.chat[0].mes = 'Alice stayed outside.'; assert.equal(getFactState(ctx).facts.length, 0);
    });
    test('exact-prefix source edit and clear/owner isolation cannot retain neutral fact links', async () => {
        const ctx = context('Alice opened the door.'); await observed(ctx, [fact('door', 'Alice', 'open door', 'open', 0, ctx.chat[0].mes)]);
        ctx.chat[0].mes = 'Alice opened'; assert.equal(getFactState(ctx).facts.length, 0);
        await observed(ctx, [fact('new', 'Alice', 'open', 'open', 0, ctx.chat[0].mes)]);
        ctx.chatId = 'other'; assert.equal(getFactState(ctx).facts.length, 0);
    });
    test('optional lifecycle validity rejects before mutation and after await, even if transport ignores abort', async () => {
        const old = LlmClient.prototype.complete;
        try {
            const ctx = context('Alice opened the door.');
            assert.equal((await observeFacts(ctx, settings, { validate: () => false })).ok, false);
            assert.deepEqual(ctx.chatMetadata, {});
            let current = true;
            LlmClient.prototype.complete = async () => { current = false; return { ok: true, text: JSON.stringify({ proposals: [fact('door', 'Alice', 'open door', 'open', 0, ctx.chat[0].mes)] }) }; };
            assert.equal((await observeFacts(ctx, settings, { validate: () => current })).ok, false);
            assert.equal(getFactState(ctx).facts.length, 0);
            assert.equal((await observeAdversary(ctx, settings, { validate: () => false })).ok, false);
        } finally { LlmClient.prototype.complete = old; }
    });
    test('inflight neutral facts changes invalidate adversary proposal commit', async () => {
        const old = LlmClient.prototype.complete;
        try {
            const ctx = context('Ash prepared the gate trap.');
            LlmClient.prototype.complete = async () => { ctx.chatMetadata['beatrice-guide'].facts = { changed: true }; return { ok: true, text: JSON.stringify({ proposals: [plan], commentary: '', emotion: 'calm' }) }; };
            assert.equal((await observeAdversary(ctx, settings)).ok, false);
            assert.equal(ctx.chatMetadata['beatrice-guide'].adversary.plots.length, 0);
        } finally { LlmClient.prototype.complete = old; }
    });
});
