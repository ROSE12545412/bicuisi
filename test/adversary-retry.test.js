import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { observeAdversary, getAdversaryState } from '../src/adversary.js';

const settings = () => ({ realm: 'void', adversary: { enabled: true, allowDeath: false }, llm: { mode: 'profile', profileId: 'retry' }, guidance: { enabled: true, maxChars: 400 }, commentary: { enabled: true, maxChars: 400 } });
const payload = (proposals = []) => ({ guidance: 'Look toward the gate.', commentary: 'The choice is yours.', emotion: 'smug', proposals });
const plan = () => ({ type: 'plan', plotId: 'private-plot', plan: { objective: 'private objective', traceObjective: 'A new scratch appears', apprentice: { name: 'Ash', introduce: false, evidence: [{ index: 0, quote: 'Ash waits at the gate.' }] }, conditions: [{ id: 'secret', event: 'gate closes', counter: 'mechanism removed' }] } });
function fixture(reply = payload()) {
    const f = { requests: [], reply, s: settings() };
    f.ctx = { chatId: 'retry', name2: 'Card', chatMetadata: {}, chat: [{ mes: 'Ash waits at the gate.', is_user: false }], ConnectionManagerRequestService: { async sendRequest(...args) {
        f.requests.push(args);
        if (f.reply instanceof Error) throw f.reply;
        return typeof f.reply === 'string' ? f.reply : JSON.stringify(f.reply);
    } } };
    return f;
}
const stored = f => f.ctx.chatMetadata['beatrice-guide'].adversary;
const publicFields = out => ({ guidance: out.guidance, commentary: out.commentary, emotion: out.emotion });

test('adversary transport failure then same-floor retry commits no partial progress', async () => {
    const f = fixture(new Error('transport failed'));
    const failed = await observeAdversary(f.ctx, f.s);
    assert.equal(failed.ok, false);
    assert.equal(stored(f).lastTargetIndex, -1);
    assert.deepEqual(stored(f).plots, []);
    assert.deepEqual(stored(f).snapshots, []);
    assert.deepEqual(stored(f).publicCache, []);
    f.reply = payload([plan()]);
    const retry = await observeAdversary(f.ctx, f.s);
    assert.equal(retry.ok, true);
    assert.equal(retry.duplicate, false);
    assert.equal(stored(f).lastTargetIndex, 0);
    assert.equal(stored(f).plots.length, 1);
    assert.equal(stored(f).snapshots.length, 1);
    assert.equal(stored(f).publicCache.length, 1);
    assert.equal(f.requests.length, 2);
});

test('adversary completed duplicate returns exact public cache without requests or reducer progress', async () => {
    const f = fixture(payload([plan()]));
    const first = await observeAdversary(f.ctx, f.s);
    getAdversaryState(f.ctx); // Existing reconciliation normalizes legacy absent causal history.
    const before = JSON.stringify(stored(f));
    const repeat = await observeAdversary(f.ctx, f.s);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.publicCacheAvailable, true);
    assert.deepEqual(publicFields(repeat), publicFields(first));
    assert.deepEqual(repeat.meta, {});
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.stringify(stored(f)), before);
    assert.deepEqual(Object.keys(stored(f).publicCache[0]).sort(), ['commentary', 'emotion', 'guidance', 'targetIndex', 'version']);
    assert.ok(!JSON.stringify(stored(f).publicCache).includes('private'));
});

test('adversary empty proposals are completed and cached including empty public channels', async () => {
    const f = fixture({ ...payload(), guidance: '', commentary: '' });
    const first = await observeAdversary(f.ctx, f.s);
    assert.equal(first.ok, true);
    assert.equal(first.ledger.lastTargetIndex, 0);
    assert.deepEqual(first.ledger.plots, []);
    const repeat = await observeAdversary(f.ctx, f.s);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.publicCacheAvailable, true);
    assert.deepEqual(publicFields(repeat), publicFields(first));
    assert.equal(f.requests.length, 1);
});

test('adversary edit and swipe invalidate exact-prefix cached success', async () => {
    for (const mutation of [ctx => { ctx.chat[0].mes = 'Ash leaves.'; }, ctx => { ctx.chat[0].swipe_id = 1; }]) {
        const f = fixture();
        await observeAdversary(f.ctx, f.s);
        mutation(f.ctx);
        const reconciled = getAdversaryState(f.ctx);
        assert.equal(reconciled.lastTargetIndex, -1);
        assert.deepEqual(reconciled.publicCache, []);
        f.reply = { ...payload(), guidance: 'New branch speech.' };
        const branch = await observeAdversary(f.ctx, f.s);
        assert.equal(branch.ok, true);
        assert.equal(branch.duplicate, false);
        assert.equal(branch.guidance, 'New branch speech.');
        assert.equal(f.requests.length, 2);
    }
});

test('adversary snapshot rollback restores earlier output and discards changed suffix', async () => {
    const f = fixture(payload([plan()]));
    const first = await observeAdversary(f.ctx, f.s);
    f.ctx.chat.push({ mes: 'I approach.', is_user: true }, { mes: 'The gate opens.', is_user: false });
    f.reply = { ...payload(), guidance: 'Later floor speech.' };
    await observeAdversary(f.ctx, f.s);
    f.ctx.chat[2].mes = 'The gate stays shut.';
    const rolled = getAdversaryState(f.ctx);
    assert.equal(rolled.lastTargetIndex, 0);
    assert.equal(rolled.snapshots.length, 1);
    assert.deepEqual(rolled.publicCache.map(c => c.targetIndex), [0]);
    const repeat = await observeAdversary(f.ctx, f.s, { targetIndex: 0 });
    assert.equal(repeat.duplicate, true);
    assert.deepEqual(publicFields(repeat), publicFields(first));
    assert.equal(f.requests.length, 2);
    const changed = await observeAdversary(f.ctx, f.s, { targetIndex: 2 });
    assert.equal(changed.duplicate, false);
    assert.equal(f.requests.length, 3);
});

test('adversary legacy processed ledgers never rerun proposals when public cache is absent', async () => {
    const f = fixture(payload([plan()]));
    await observeAdversary(f.ctx, f.s);
    delete stored(f).publicCache;
    stored(f).snapshots.forEach(s => { delete s.state.publicCache; });
    const repeat = await observeAdversary(f.ctx, f.s);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.publicCacheAvailable, false);
    assert.deepEqual(publicFields(repeat), { guidance: '', commentary: '', emotion: 'calm' });
    assert.equal(repeat.ledger.plots.length, 1);
    assert.equal(f.requests.length, 1);
});

test('adversary corrupted imported public cache fails closed without losing completed marker', async () => {
    for (const patch of [{ version: 99 }, { targetIndex: -1 }, { targetIndex: 2 }, { guidance: {} }, { commentary: 'X'.repeat(401) }, { guidance: '\u0000secret' }, { emotion: 'invalid' }]) {
        const f = fixture();
        await observeAdversary(f.ctx, f.s);
        Object.assign(stored(f).publicCache[0], patch);
        Object.assign(stored(f).snapshots[0].state.publicCache[0], patch);
        const repeat = await observeAdversary(f.ctx, f.s);
        assert.equal(repeat.ok, true);
        assert.equal(repeat.duplicate, true);
        assert.equal(repeat.publicCacheAvailable, false, JSON.stringify(patch));
        assert.equal(repeat.ledger.lastTargetIndex, 0);
        assert.equal(f.requests.length, 1);
        assert.deepEqual(repeat.ledger.publicCache, []);
    }
});

test('adversary public cache and every snapshot cache are bounded and sanitized', async () => {
    const f = fixture({ ...payload(), guidance: '\n' + 'G'.repeat(1000), commentary: '\u0000' + 'C'.repeat(1000) });
    for (let i = 0; i < 30; i++) {
        if (i) f.ctx.chat.push({ mes: `User ${i}`, is_user: true }, { mes: `AI ${i}`, is_user: false });
        assert.equal((await observeAdversary(f.ctx, f.s)).ok, true);
    }
    const ledger = getAdversaryState(f.ctx);
    assert.equal(ledger.publicCache.length, 24);
    assert.equal(ledger.snapshots.length, 24);
    assert.ok(ledger.snapshots.every(s => s.state.publicCache.length <= 24));
    assert.ok(ledger.publicCache.every(c => c.guidance === 'G'.repeat(400) && c.commentary === 'C'.repeat(400)));
    const old = await observeAdversary(f.ctx, f.s, { targetIndex: 0 });
    assert.equal(old.ok, true);
    assert.equal(old.duplicate, true);
    assert.equal(old.publicCacheAvailable, false);
    assert.equal(f.requests.length, 30);
});

test('adversary duplicate cache does not bypass disabled, aborted, stale or invalid-target guards', async () => {
    const f = fixture();
    await observeAdversary(f.ctx, f.s);
    const signal = new AbortController(); signal.abort();
    assert.equal((await observeAdversary(f.ctx, f.s, { signal: signal.signal })).ok, false);
    assert.equal((await observeAdversary(f.ctx, f.s, { validate: () => false })).ok, false);
    assert.equal((await observeAdversary(f.ctx, f.s, { targetIndex: 99 })).ok, false);
    f.s.adversary.enabled = false;
    assert.equal((await observeAdversary(f.ctx, f.s)).ok, false);
    assert.equal(f.requests.length, 1);
});

test('adversary invalid envelope and stale response never create successful cache', async () => {
    for (const reply of ['not JSON', { ...payload(), guidance: null }]) {
        const f = fixture(reply);
        assert.equal((await observeAdversary(f.ctx, f.s)).ok, false);
        assert.equal(stored(f).lastTargetIndex, -1);
        assert.deepEqual(stored(f).publicCache, []);
        f.reply = payload();
        assert.equal((await observeAdversary(f.ctx, f.s)).ok, true);
    }
    const f = fixture();
    f.ctx.ConnectionManagerRequestService.sendRequest = async () => {
        f.ctx.chat[0].mes = 'Changed during transport.';
        return JSON.stringify(payload());
    };
    assert.equal((await observeAdversary(f.ctx, f.s)).ok, false);
    assert.equal(stored(f).lastTargetIndex, -1);
    assert.deepEqual(stored(f).publicCache, []);
});
