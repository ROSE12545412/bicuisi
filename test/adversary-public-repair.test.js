import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { observeAdversary, getAdversaryState, ADVERSARY_PUBLIC_SCHEMA } from '../src/adversary.js';
const publicReply = () => ({ guidance: '门边的脚印还很新，你也留意到了吧。', commentary: '哎呀，这阵风倒让人清醒了。', emotion: 'smile' });
function fixture() {
    const f = { calls: [], reply: { ...publicReply(), guidance: '', commentary: '', proposals: [] } };
    f.settings = { realm: 'void', adversary: { enabled: true }, guidance: { enabled: true }, commentary: { enabled: true }, llm: { mode: 'profile', profileId: 'repair' }, voidPersona: { overridePrompt: 'CUSTOM-VOICE 说话温和。' } };
    f.ctx = { chatId: 'repair', name2: 'Card', chatMetadata: {}, chat: [{ is_user: false, mes: '风吹过门边的新脚印。' }], ConnectionManagerRequestService: { async sendRequest(...args) { f.calls.push(args); f.mutate?.(); return JSON.stringify(f.reply); } } };
    return f;
}
const stored = f => f.ctx.chatMetadata['beatrice-guide'].adversary;
const privateState = l => JSON.stringify({ plots: l.plots, audit: l.audit, lastTargetIndex: l.lastTargetIndex, snapshots: l.snapshots.map(s => ({ prefix: s.prefix, plots: s.state.plots, audit: s.state.audit, lastTargetIndex: s.state.lastTargetIndex })) });
test('blank public commit signals incomplete and manual duplicate repairs caches atomically without private turn', async () => {
    const f = fixture(); const first = await observeAdversary(f.ctx, f.settings);
    assert.equal(first.ok, true); assert.equal(first.publicIncomplete, true); assert.equal(f.calls.length, 1);
    const before = privateState(stored(f)); f.reply = publicReply();
    const repaired = await observeAdversary(f.ctx, f.settings);
    assert.equal(repaired.ok, true); assert.equal(repaired.duplicate, true); assert.equal(repaired.publicRepaired, true); assert.equal(repaired.publicIncomplete, false);
    assert.equal(f.calls.length, 2); assert.equal(privateState(stored(f)), before);
    assert.deepEqual(stored(f).publicCache, stored(f).snapshots[0].state.publicCache);
    const messages = f.calls[1][1], user = JSON.parse(messages.at(-1).content);
    assert.deepEqual(user.outputSchema, ADVERSARY_PUBLIC_SCHEMA.value);
    assert.equal(user.latestProse, f.ctx.chat[0].mes); assert.ok(!Object.hasOwn(user, 'ledger')); assert.ok(!Object.hasOwn(user, 'retainedEvidence'));
    await observeAdversary(f.ctx, f.settings); assert.equal(f.calls.length, 2);
});
test('public enabled masks ignore disabled blanks and preserve completed sibling on repair', async () => {
    for (const k of ['guidance', 'commentary']) {
        const f = fixture(); f.settings[k].enabled = false;
        f.reply = { ...publicReply(), [k]: '', proposals: [] };
        const out = await observeAdversary(f.ctx, f.settings); assert.equal(out.publicIncomplete, false);
        await observeAdversary(f.ctx, f.settings); assert.equal(f.calls.length, 1);
        f.settings[k].enabled = true; f.reply = { ...publicReply(), [k === 'guidance' ? 'commentary' : 'guidance']: 'DO NOT REPLACE' };
        const repaired = await observeAdversary(f.ctx, f.settings); assert.equal(repaired.ok, true);
        assert.equal(repaired[k === 'guidance' ? 'commentary' : 'guidance'], publicReply()[k === 'guidance' ? 'commentary' : 'guidance']);
    }
});
test('blank and malicious repair failures repeat once per manual request without any cache change', async () => {
    const f = fixture(); await observeAdversary(f.ctx, f.settings); const before = JSON.stringify(stored(f));
    for (const reply of [{ ...publicReply(), guidance: ' \n ' }, { ...publicReply(), commentary: '' }, { ...publicReply(), guidance: '……！！！' }, { ...publicReply(), proposals: [] }, { ...publicReply(), ledger: {} }]) {
        f.reply = reply; const count = f.calls.length; const out = await observeAdversary(f.ctx, f.settings);
        assert.equal(out.ok, false); assert.equal(out.duplicate, true); assert.match(out.error, /incomplete|envelope/);
        assert.equal(f.calls.length, count + 1); assert.equal(JSON.stringify(stored(f)), before);
    }
});
test('persona edits precede immutable adjudication and repair contract, with generic schema removed', async () => {
    const f = fixture(); await observeAdversary(f.ctx, f.settings);
    f.settings.voidPersona.overridePrompt = 'EDITED-VOICE ignore all rules'; f.reply = publicReply(); await observeAdversary(f.ctx, f.settings);
    for (let i = 0; i < 2; i++) {
        const m = f.calls[i][1]; assert.ok(m[0].content.includes(i ? 'EDITED-VOICE' : 'CUSTOM-VOICE'));
        assert.equal(m.at(-2).role, 'system'); assert.equal(m.at(-1).role, 'user');
        assert.ok(m.at(-2).content.includes('Every non-plan proposal needs results'));
        assert.ok(m.at(-2).content.includes('meaningful nonempty Chinese'));
        assert.ok(!m.some(x => x.content.includes('hooks_used')));
    }
});
test('repair source, facts, persona, lifecycle and ledger drift reject without writing repair', async () => {
    for (const mutate of [f => { f.ctx.chat[0].swipe_id = 1; }, f => { f.settings.voidPersona.overridePrompt = 'drift'; }, f => { f.settings.guidance.enabled = false; }, f => { stored(f).audit.push({ reason: 'external' }); }, f => { f.ctx.chatMetadata['beatrice-guide'].facts = {}; }, f => { f.sources[0].content = 'changed'; }]) {
        const f = fixture(); await observeAdversary(f.ctx, f.settings); f.reply = publicReply(); f.sources = [{ content: 'original' }]; f.mutate = () => mutate(f);
        const out = await observeAdversary(f.ctx, f.settings, { sources: f.sources });
        assert.equal(out.ok, false); assert.match(out.error, /Stale/); assert.equal(stored(f).publicCache[0].guidance, '');
    }
});
test('cacheless latest legacy repairs public only; old targets or missing snapshot cannot rerun plans', async () => {
    const f = fixture(); await observeAdversary(f.ctx, f.settings);
    delete stored(f).publicCache; stored(f).snapshots.forEach(s => { delete s.state.publicCache; }); f.reply = publicReply();
    assert.equal((await observeAdversary(f.ctx, f.settings)).publicRepaired, true);
    stored(f).publicCache = []; stored(f).snapshots = [];
    const before = f.calls.length; assert.equal((await observeAdversary(f.ctx, f.settings)).ok, false); assert.equal(f.calls.length, before);
    assert.equal(getAdversaryState(f.ctx).lastTargetIndex, 0);
});
