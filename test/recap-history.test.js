import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { applyTurn, normalizeCausalHistory, reconcileLedger } from '../src/adversary.js';
import { buildCausalRecap } from '../src/memories.js';
const ai = mes => ({ mes, name: 'Card' });
const user = mes => ({ mes, is_user: true });
const settings = { adversary: { allowDeath: false } };
const fixture = () => {
    const chat = [ai('Ash prepared the gate.'), user('I look.'), ai('A red wire glowed.'), user('I cut it.'), ai('The wire was cut and the trap ended.')];
    const plan = { objective: 'trap', traceObjective: 'visible wire', apprentice: { name: 'Ash' }, conditions: [{ id: 'c', event: 'gate locked', counter: 'cut wire' }] };
    const ledger = { version: 1, plots: [{ id: 'p', stage: 'planned', plan, createdIndex: 0, traceIndex: null, criticalIndex: null, evidence: [], brokenConditions: [] }], audit: [], lastTargetIndex: 0, snapshots: [] };
    const cause = { id: 'prep', status: 'confirmed', actor: 'Ash', action: 'prepare', result: 'ready', evidence: [{ index: 0, quote: chat[0].mes }] };
    const step = (l, index, kind, action, stage) => {
        const evidence = [{ index, quote: chat[index].mes }];
        const r = { kind, actor: 'Ash', action, result: 'done', status: 'confirmed', factId: `f${index}`, causeFactIds: ['prep'], conditionId: 'c', evidence };
        return applyTurn(l, [{ type: kind === 'counter' ? 'counter' : 'advance', plotId: 'p', stage, evidence, results: [r] }], chat, settings, index, { facts: [cause, { ...r, id: r.factId }] });
    };
    return { chat, ledger, step };
};
test('accepted trace and failed counter retain exact fact/cause/evidence and user opportunity', () => {
    const f = fixture(), traced = f.step(f.ledger, 2, 'trace', 'visible wire', 'trace');
    assert.equal(traced.plots[0].history[0].from, 'planned');
    const failed = f.step(traced, 4, 'counter', 'cut wire', 'failed');
    const h = failed.plots[0].history[1];
    assert.deepEqual(h.opportunities, [{ index: 3, quote: 'I cut it.' }]);
    assert.equal(h.results[0].factId, 'f4'); assert.equal(h.causes[0].factId, 'prep');
    const recap = buildCausalRecap(failed, { spoilers: true }).plots[0];
    assert.equal(recap.history.length, 2); assert.equal(recap.missing, '');
    assert.equal(recap.opportunity.confirmed, true);
    assert.ok(recap.result.evidence.some(e => e.quote === f.chat[4].mes));
    assert.equal(buildCausalRecap(traced, { spoilers: true }).plots.length, 0);
});
test('history normalization rejects corrupt entries and whitelists bounded records', () => {
    assert.deepEqual(normalizeCausalHistory([null, { index: -1, from: 'trace', to: 'failed', results: [] }]), []);
    const f = fixture(), traced = f.step(f.ledger, 2, 'trace', 'visible wire', 'trace');
    const h = traced.plots[0].history[0]; h.privateSecret = 'secret'; h.results[0].privateSecret = 'secret';
    const normalized = normalizeCausalHistory(Array(30).fill(h));
    assert.equal(normalized.length, 8); assert.ok(!JSON.stringify(normalized).includes('secret'));
});
test('snapshot rollback discards ended history and imports unsupported history fail closed', () => {
    const f = fixture(), traced = f.step(f.ledger, 2, 'trace', 'visible wire', 'trace'), failed = f.step(traced, 4, 'counter', 'cut wire', 'failed');
    const ctx = { chatId: 'test', name2: 'Card', chat: f.chat, chatMetadata: { 'beatrice-guide': {} } };
    const owner = reconcileLedger(ctx).owner;
    const fingerprint = m => JSON.stringify([m.mes, m.swipe_id ?? null, Boolean(m.is_user), Boolean(m.is_system), m.name ?? '', false]);
    failed.owner = owner;
    failed.snapshots = [{ prefix: f.chat.slice(0, 3).map(fingerprint), state: { plots: traced.plots, audit: [], lastTargetIndex: 2 } },
        { prefix: f.chat.map(fingerprint), state: { plots: failed.plots, audit: [], lastTargetIndex: 4 } }];
    ctx.chatMetadata['beatrice-guide'].adversary = failed;
    ctx.chat[4].mes = 'The trap remains.';
    const restored = reconcileLedger(ctx);
    assert.equal(restored.plots[0].stage, 'trace'); assert.equal(restored.plots[0].history.length, 1);
    assert.equal(buildCausalRecap(restored, { spoilers: true }).plots.length, 0);
});
