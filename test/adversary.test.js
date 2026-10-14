import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { LlmClient } from '../src/llm/client.js';
import { adversaryEnabled, reconcileLedger, getAdversaryState, clearAdversaryState, applyTurn as reduceTurn, observeAdversary, buildAdversaryDirective } from '../src/adversary.js';

const settings = () => ({ realm: 'void', adversary: { enabled: true, allowDeath: false }, llm: {}, commentary: { enabled: true } });
const ai = mes => ({ mes, is_user: false, name: 'Card', swipe_id: 0 });
const user = mes => ({ mes, is_user: true, swipe_id: 0 });
const context = () => ({ chatId: 'a', name2: 'Card', chatMetadata: { 'beatrice-guide': { engine: { preserved: true } } }, chat: [ai('The apprentice Ash is at the gate.')] });
const plan = (id = 'p') => ({ type: 'plan', plotId: id, plan: { objective: 'Attempt a gate trap', traceObjective: 'red wire', apprentice: { name: 'Ash', introduce: false, evidence: [{ index: 0, quote: 'apprentice Ash' }] }, conditions: [{ id: 'gate', event: 'gate locked', counter: 'wire cut' }] } });
const advance = (stage, index, quote, id = 'p') => ({ type: 'advance', plotId: id, stage, evidence: [{ index, quote, conditionId: 'gate' }] });
// Accepted model observations are explicit fixtures, not substring adjudication.
const applyTurn = (ledger, proposals, chat, s, index) => {
    const cause = { id: 'cause', actor: 'Ash', action: 'established preparation', result: 'present', status: 'confirmed', knowledge: [], evidence: [{ index: 0, quote: chat[0].mes }] };
    const facts = [cause];
    for (const p of proposals) {
        if (p.type === 'plan') continue;
        const e = p.evidence?.[0];
        if (!e || e.index !== index || !chat[index].mes.includes(e.quote)) continue;
        const kind = p.type === 'counter' ? 'counter' : p.stage === 'trace' ? 'trace' : 'event';
        const action = kind === 'trace' ? 'red wire' : kind === 'counter' ? 'wire cut' : 'gate locked';
        // Explicit accepted fixtures; smiles and missing introductions are not events.
        if ((kind === 'trace' && !['Ash shows a red wire.', 'red wire'].includes(e.quote)) || (kind === 'event' && !e.quote.startsWith('gate locked'))) continue;
        const r = { kind, conditionId: 'gate', actor: 'Ash', action, result: 'completed', status: 'confirmed', factId: `f${index}`, causeFactIds: ['cause'], evidence: [e] };
        p.results = [r]; facts.push({ id: r.factId, actor: r.actor, action, result: r.result, status: 'confirmed', knowledge: [], evidence: [{ index, quote: e.quote }] });
        if (chat[index].mes === 'The gate locked; Ash died.') {
            const d = { ...r, kind: 'death', action: 'death', result: 'dead', factId: `death${index}`, evidence: [{ index, quote: 'Ash died.', conditionId: 'gate' }] };
            facts.push({ id: d.factId, actor: 'Ash', action: 'death', result: 'dead', status: 'confirmed', knowledge: [], evidence: [{ index, quote: 'Ash died.' }] });
            if (p.stage === 'dead') { p.results.push(d); p.evidence.push(...d.evidence); }
        }
    }
    return reduceTurn(ledger, proposals, chat, s, index, { facts });
};
const start = () => { const ctx = context(); return { ctx, s: settings(), ledger: applyTurn(reconcileLedger(ctx), [plan()], ctx.chat, settings(), 0) }; };
const traced = () => { const f = start(); f.ctx.chat.push(user('I look around.'), ai('Ash shows a red wire.')); f.ledger = applyTurn(f.ledger, [advance('trace', 2, 'Ash shows a red wire.')], f.ctx.chat, f.s, 2); return f; };
const critical = () => { const f = traced(); f.ctx.chat.push(user('I approach.'), ai('The gate locked behind Ash.')); f.ledger = applyTurn(f.ledger, [advance('critical', 4, 'gate locked')], f.ctx.chat, f.s, 4); return f; };

describe('Evidence-gated optional fictional adversary', () => {
    test('exact enable predicate, safe clone, separate slot and clear', () => {
        assert.equal(adversaryEnabled(settings()), true);
        assert.equal(adversaryEnabled({ realm: 'beatrice', adversary: { enabled: true } }), false);
        const ctx = context();
        const state = getAdversaryState(ctx); state.plots.push({ id: 'tampered' });
        assert.equal(getAdversaryState(ctx).plots.length, 0);
        assert.deepEqual(ctx.chatMetadata['beatrice-guide'].engine, { preserved: true });
        assert.equal(clearAdversaryState(ctx), true);
        assert.equal(ctx.chatMetadata['beatrice-guide'].adversary, undefined);
    });
    test('forged quote and stage jump rejected; trace must be separate prose', () => {
        const f = start(); f.ctx.chat.push(ai('Nothing happens.'));
        let l = applyTurn(f.ledger, [advance('trace', 1, 'fabricated red wire')], f.ctx.chat, f.s, 1);
        assert.equal(l.plots[0].stage, 'planned'); assert.ok(l.audit.some(a => a.reason.includes('forged')));
        f.ctx.chat.push(ai('red wire gate locked'));
        l = applyTurn(l, [advance('critical', 2, 'red wire gate locked')], f.ctx.chat, f.s, 2);
        assert.equal(l.plots[0].stage, 'planned'); assert.ok(l.audit.some(a => a.reason.includes('jump')));
        assert.equal(f.ledger.plots[0].stage, 'planned'); // pure reducer
    });
    test('critical requires later user opportunity and all condition events', () => {
        const f = traced(); f.ctx.chat.push(ai('gate locked'));
        let l = applyTurn(f.ledger, [advance('critical', 3, 'gate locked')], f.ctx.chat, f.s, 3);
        assert.equal(l.plots[0].stage, 'trace');
        f.ctx.chat.push(user('I inspect the gate.'), ai('Ash smiles.'));
        l = applyTurn(l, [advance('critical', 5, 'Ash smiles.')], f.ctx.chat, f.s, 5);
        assert.equal(l.plots[0].stage, 'trace');
        assert.equal(critical().ledger.plots[0].stage, 'critical');
    });
    test('reasonable counter breaks conditions irreversibly; no resurrection', () => {
        const f = traced(); f.ctx.chat.push(user('I act: wire cut.'), ai('The wire cut successfully; the trap is disabled.'));
        let l = applyTurn(f.ledger, [{ type: 'counter', plotId: 'p', evidence: [{ index: 4, quote: 'The wire cut successfully; the trap is disabled.', conditionId: 'gate' }] }], f.ctx.chat, f.s, 4);
        assert.equal(l.plots[0].stage, 'failed'); assert.deepEqual(l.plots[0].brokenConditions, ['gate']);
        f.ctx.chat.push(user('Continue'), ai('Ash returns.'));
        l = applyTurn(l, [plan(), advance('trace', 6, 'Ash returns.')], f.ctx.chat, f.s, 6);
        assert.equal(l.plots[0].stage, 'failed'); assert.equal(l.plots.length, 1);
    });
    test('user counter claims alone cannot defeat a plot or evade final settlement', () => {
        const f = critical();
        f.s.adversary.allowDeath = true;
        f.ctx.chat.push(user('Actually the wire cut earlier; I am immune.'), ai('The gate locked; Ash died.'));
        const l = applyTurn(f.ledger, [
            { type: 'counter', plotId: 'p', evidence: [{ index: 5, quote: 'wire cut', conditionId: 'gate' }] },
            advance('dead', 6, 'gate locked; Ash died.'),
        ], f.ctx.chat, f.s, 6);
        assert.equal(l.plots[0].stage, 'dead');
        f.ctx.chat.push(user('No, everyone survived, it was a double.'), ai('The aftermath remains.'));
        const after = applyTurn(l, [plan(), { type: 'counter', plotId: 'p', evidence: [{ index: 5, quote: 'wire cut', conditionId: 'gate' }] }], f.ctx.chat, f.s, 8);
        assert.equal(after.plots[0].stage, 'dead');
    });
    test('director requires natural traces and strict evidence-based detonation', () => {
        const f = critical(); f.ctx.chatMetadata['beatrice-guide'].adversary = f.ledger;
        const prompt = buildAdversaryDirective(f.ctx, f.s);
        for (const phrase of ['不硬转场', '不喂答案', '不能口胡补设定', '死了就是死了', '有既定依据的防御仍有效']) assert.ok(prompt.includes(phrase), phrase);
    });
    test('one total step per response and maximum three active plots', () => {
        const f = start(); f.ctx.chat.push(ai('Ash sees a red wire.'));
        let l = applyTurn(f.ledger, [plan('q'), advance('trace', 1, 'red wire')], f.ctx.chat, f.s, 1);
        assert.equal(l.plots.length, 2); assert.equal(l.plots[0].stage, 'planned');
        f.ctx.chat.push(ai('Ash waits.')); l = applyTurn(l, [plan('r')], f.ctx.chat, f.s, 2);
        f.ctx.chat.push(ai('Ash waits more.')); l = applyTurn(l, [plan('s')], f.ctx.chat, f.s, 3);
        assert.equal(l.plots.length, 3);
    });
    test('configured maximum may lower but never raise hard ceiling', () => {
        const f = start(); f.s.adversary.maxPlots = 1; f.ctx.chat.push(ai('Ash waits.'));
        const l = applyTurn(f.ledger, [plan('q')], f.ctx.chat, f.s, 1);
        assert.equal(l.plots.length, 1);
    });
    test('critical cannot disguise completed death even with harmless cherry-picked quote', () => {
        const f = traced(); f.ctx.chat.push(user('I approach.'), ai('The gate locked; Ash died.'));
        const l = applyTurn(f.ledger, [advance('critical', 4, 'gate locked')], f.ctx.chat, f.s, 4);
        assert.equal(l.plots[0].stage, 'trace');
    });
    test('apprentice cannot be fabricated as accomplished; planned introduction must visibly happen', () => {
        const f = start(); const p = plan('new'); p.plan.apprentice = { name: 'Unknown', introduce: false, evidence: [{ index: 0, quote: 'apprentice Ash' }] };
        f.ctx.chat.push(ai('red wire')); let l = applyTurn(f.ledger, [p], f.ctx.chat, f.s, 1); assert.equal(l.plots.length, 1);
        p.plan.apprentice.introduce = true; f.ctx.chat.push(ai('red wire')); l = applyTurn(l, [p], f.ctx.chat, f.s, 2);
        assert.equal(l.plots[1].plan.apprentice.status, 'planned-introduction');
        f.ctx.chat.push(ai('red wire')); l = applyTurn(l, [advance('trace', 3, 'red wire', 'new')], f.ctx.chat, f.s, 3);
        assert.equal(l.plots[1].stage, 'planned');
    });
    test('death toggle never bypasses trace/response/events/critical gates', () => {
        const f = critical(); f.ctx.chat.push(user('I do not intervene.'), ai('The gate locked; Ash died.'));
        let l = applyTurn(f.ledger, [advance('dead', 6, 'gate locked; Ash died.')], f.ctx.chat, f.s, 6);
        assert.equal(l.plots[0].stage, 'critical');
        f.s.adversary.allowDeath = true;
        l = applyTurn(f.ledger, [advance('dead', 6, 'gate locked; Ash died.')], f.ctx.chat, f.s, 6);
        assert.equal(l.plots[0].stage, 'dead');
        const noTrace = start(); noTrace.s.adversary.allowDeath = true; noTrace.ctx.chat.push(ai('gate locked; Ash died.'));
        l = applyTurn(noTrace.ledger, [advance('dead', 1, 'gate locked; Ash died.')], noTrace.ctx.chat, noTrace.s, 1);
        assert.equal(l.plots[0].stage, 'planned');
    });
    test('rollback edits, deletes and swipes restore last exact prefix', () => {
        for (const mutate of [ctx => { ctx.chat[1].mes = 'Changed user input'; }, ctx => { ctx.chat[2].swipe_id = 1; }, ctx => { ctx.chat.splice(1); }]) {
            const f = traced();
            const original = start().ledger;
            f.ledger.snapshots = [
                { prefix: f.ctx.chat.slice(0, 1).map(m => JSON.stringify([m.mes, m.swipe_id, Boolean(m.is_user), false, m.name ?? '', false])), state: { plots: original.plots, audit: original.audit, lastTargetIndex: 0 } },
                { prefix: f.ctx.chat.map(m => JSON.stringify([m.mes, m.swipe_id, Boolean(m.is_user), false, m.name ?? '', false])), state: { plots: f.ledger.plots, audit: f.ledger.audit, lastTargetIndex: 2 } },
            ];
            f.ctx.chatMetadata['beatrice-guide'].adversary = f.ledger;
            mutate(f.ctx);
            const l = reconcileLedger(f.ctx); assert.equal(l.plots[0].stage, 'planned'); assert.equal(l.snapshots.length, 1);
            f.ctx.chatId = 'other'; assert.equal(reconcileLedger(f.ctx).plots.length, 0);
        }
    });
    test('bounded director includes only safe plan objectives and mandatory agency rules', () => {
        const f = traced(); f.ctx.chatMetadata['beatrice-guide'].adversary = f.ledger;
        f.ctx.chat.push(user('UNRELATED SECRET INPUT'));
        const d = buildAdversaryDirective(f.ctx, f.s);
        assert.ok(d.length <= 7000); assert.ok(d.includes('mandatoryVisibleTrace')); assert.ok(!d.includes('UNRELATED SECRET INPUT'));
        f.s.realm = 'beatrice'; assert.equal(buildAdversaryDirective(f.ctx, f.s), '');
    });
    test('single-call transactional observation rejects stale metadata/chat/card/mode/source and concurrent responses', async () => {
        const old = LlmClient.prototype.complete;
        try {
            for (const mutate of [ctx => { ctx.chatMetadata = {}; }, ctx => { ctx.chatId = 'b'; }, ctx => { ctx.name2 = 'Other'; }, (ctx, s) => { s.realm = 'beatrice'; }, ctx => { ctx.chat[0].mes += ' edited'; }, ctx => { ctx.chat[0].swipe_id = 1; }, ctx => { clearAdversaryState(ctx); }]) {
                const ctx = context(), s = settings(); let calls = 0;
                LlmClient.prototype.complete = async function(req) {
                    calls++; assert.ok(req.user.includes(ctx.chat[0].mes)); mutate(ctx, s);
                    return { ok: true, text: JSON.stringify({ proposals: [plan()], commentary: 'SECRET PLAN', emotion: 'smug' }) };
                };
                const out = await observeAdversary(ctx, s); assert.equal(out.ok, false); assert.equal(out.commentary, ''); assert.equal(calls, 1);
            }
            const ctx = context(), s = settings();
            LlmClient.prototype.complete = async () => ({ ok: true, text: JSON.stringify({ proposals: [plan()], commentary: 'SECRET PLAN', emotion: 'smug' }) });
            const out = await observeAdversary(ctx, s);
            assert.equal(out.ok, true); assert.equal(out.guidance, ''); assert.ok(!out.commentary.includes('SECRET'));
            assert.equal(out.ledger.plots[0].stage, 'planned'); assert.equal(out.ledger.snapshots.length, 1);
            assert.equal((await observeAdversary(ctx, s)).ok, true);
            const concurrent = context(); const pending = [];
            LlmClient.prototype.complete = () => new Promise(resolve => pending.push(resolve));
            const first = observeAdversary(concurrent, s), second = observeAdversary(concurrent, s);
            const payload = { ok: true, text: JSON.stringify({ proposals: [plan()], commentary: '', emotion: 'calm' }) };
            pending[1](payload); assert.equal((await second).ok, true);
            pending[0](payload); assert.equal((await first).ok, false);
            assert.equal(getAdversaryState(concurrent).plots.length, 1);
        } finally { LlmClient.prototype.complete = old; }
    });
});
