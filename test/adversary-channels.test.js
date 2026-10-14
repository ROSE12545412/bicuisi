import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { ADVERSARY_SCHEMA, observeAdversary, getAdversaryState } from '../src/adversary.js';

const settings = () => ({ realm: 'void', adversary: { enabled: true, allowDeath: false }, llm: { mode: 'profile', profileId: 'test' }, guidance: { enabled: true, maxChars: 60 }, commentary: { enabled: true, maxChars: 70 } });
const plan = () => ({ type: 'plan', plotId: 'private-id', stage: 'planned', results: [], evidence: [], plan: { objective: 'PRIVATE-TRAP-OBJECTIVE', traceObjective: 'A fresh scratch appears on the gate', apprentice: { name: 'Ash', introduce: false, evidence: [{ index: 0, quote: 'Ash waits at the gate.', conditionId: '' }] }, conditions: [{ id: 'private-condition', event: 'gate closes', counter: 'mechanism removed' }] } });
const payload = () => ({ guidance: 'The gate offers shelter; why not look there?', commentary: 'Of course, the choice is yours.', emotion: 'smug', proposals: [plan()] });
function fixture(reply = payload()) {
    const requests = [];
    const ctx = { chatId: 'channels', name2: 'Card', chatMetadata: {}, chat: [{ mes: 'Ash waits at the gate.', is_user: false }], ConnectionManagerRequestService: { async sendRequest(...args) { requests.push(args); return JSON.stringify(reply); } } };
    return { ctx, requests, s: settings() };
}

test('adversary strict schema separates required public speech from private proposals', () => {
    assert.equal(ADVERSARY_SCHEMA.strict, true);
    assert.equal(ADVERSARY_SCHEMA.value.additionalProperties, false);
    assert.deepEqual(ADVERSARY_SCHEMA.value.required, ['guidance', 'commentary', 'emotion', 'proposals']);
    assert.equal(ADVERSARY_SCHEMA.value.properties.guidance.type, 'string');
    assert.equal(ADVERSARY_SCHEMA.value.properties.commentary.type, 'string');
    assert.equal(ADVERSARY_SCHEMA.value.properties.proposals.type, 'array');
});

test('mocked transport returns independent model speech, keeps plans private and reports actual calls', async () => {
    const f = fixture(), original = JSON.stringify(f.ctx.chat);
    const out = await observeAdversary(f.ctx, f.s);
    assert.equal(out.ok, true);
    assert.equal(out.guidance, payload().guidance);
    assert.equal(out.commentary, payload().commentary);
    assert.equal(out.emotion, 'smug');
    assert.equal(out.duplicate, false);
    assert.equal(out.meta.attempts, 1);
    assert.equal(out.meta.mode, 'profile');
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.stringify(f.ctx.chat), original);
    assert.ok(!JSON.stringify([out.guidance, out.commentary]).includes('PRIVATE-TRAP-OBJECTIVE'));
    assert.ok(!JSON.stringify([out.guidance, out.commentary]).includes('private-id'));
    assert.equal(out.proposals, undefined);
    assert.equal(out.ledger.plots[0].plan.objective, 'PRIVATE-TRAP-OBJECTIVE');
    assert.equal(out.ledger.plots[0].stage, 'planned');
    assert.equal(out.ledger.snapshots.length, 1);
    const system = f.requests[0][1].at(-2).content;
    for (const rule of ['Three independent channels', 'partial truths', 'misleading lure', 'rationalize', 'cannot change canon', 'erase evidence', 'control user choices', 'not Beatrice', 'chain of thought']) assert.ok(system.includes(rule), rule);
    const repeat = await observeAdversary(f.ctx, f.s);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.publicCacheAvailable, true);
    assert.equal(repeat.guidance, out.guidance);
    assert.equal(repeat.duplicate, true);
    assert.deepEqual(repeat.meta, {});
    assert.equal(f.requests.length, 1);
});

test('public channels are independently bounded, sanitized and disabled without disabling private observation', async () => {
    const f = fixture({ ...payload(), guidance: '\u0000' + 'G'.repeat(100), commentary: '\n' + 'C'.repeat(100), emotion: 'unsupported' });
    f.s.guidance.maxChars = 18; f.s.commentary.maxChars = 23;
    const out = await observeAdversary(f.ctx, f.s);
    assert.equal(out.guidance, 'G'.repeat(18));
    assert.equal(out.commentary, 'C'.repeat(23));
    assert.equal(out.emotion, 'calm');
    for (const channel of ['guidance', 'commentary']) {
        const disabled = fixture(); disabled.s[channel].enabled = false;
        const result = await observeAdversary(disabled.ctx, disabled.s);
        assert.equal(result[channel], '');
        assert.ok(result[channel === 'guidance' ? 'commentary' : 'guidance']);
        assert.equal(result.ledger.plots.length, 1);
    }
});

test('invalid public field types and envelope extras fail closed without snapshots or private plans', async () => {
    for (const patch of [{ guidance: null }, { guidance: {} }, { guidance: [] }, { guidance: 7 }, { commentary: null }, { emotion: {} }, { proposals: {} }, { secretPlan: 'unexpected' }]) {
        const f = fixture({ ...payload(), ...patch });
        const out = await observeAdversary(f.ctx, f.s);
        assert.equal(out.ok, false, JSON.stringify(patch));
        assert.equal(out.error, 'Invalid proposal envelope');
        assert.equal(out.guidance, ''); assert.equal(out.commentary, '');
        assert.equal(out.meta.attempts, 1);
        assert.equal(getAdversaryState(f.ctx).plots.length, 0);
        assert.equal(getAdversaryState(f.ctx).snapshots.length, 0);
    }
});

test('legacy missing-guidance envelopes retain plans but never publish old private commentary', async () => {
    const old = payload(); delete old.guidance; old.commentary = 'PRIVATE-TRAP-OBJECTIVE';
    const f = fixture(old);
    const out = await observeAdversary(f.ctx, f.s);
    assert.equal(out.ok, true);
    assert.equal(out.guidance, '');
    assert.ok(!out.commentary.includes('PRIVATE'));
    assert.equal(out.ledger.plots.length, 1);
});

test('fictional public persuasion is not evidence for a stage jump and applies only in enabled void mode', async () => {
    const jump = { ...payload(), proposals: [{ type: 'advance', plotId: 'missing', stage: 'dead', evidence: [], results: [] }] };
    const f = fixture(jump);
    const out = await observeAdversary(f.ctx, f.s);
    assert.equal(out.ok, true);
    assert.equal(out.ledger.plots.length, 0);
    assert.ok(out.ledger.audit.some(a => a.reason.includes('unknown or terminal')));
    const beatrice = fixture(); beatrice.s.realm = 'beatrice';
    const disabled = await observeAdversary(beatrice.ctx, beatrice.s);
    assert.equal(disabled.ok, false); assert.equal(disabled.guidance, ''); assert.equal(disabled.commentary, '');
    assert.equal(beatrice.requests.length, 0);
});
