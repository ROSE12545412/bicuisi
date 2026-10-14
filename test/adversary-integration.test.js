import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
import { setDirectorPrompt, directorStatus, ADVERSARY_PROMPT_KEY } from '../src/adversary-director.js';

function setup() {
    const settings = defaultSettings(); settings.realm = 'void'; settings.adversary.enabled = true;
    const calls = [];
    const ctx = { name2: 'actor', chatId: 'test', chatMetadata: {}, chat: [{ is_user: true, mes: '我走进大厅' }, { mes: '商人站在大厅，门锁损坏。' }], setExtensionPrompt: (...args) => calls.push(args), saveMetadata: async () => {} };
    const app = new GuideController(ctx, settings);
    const bubbles = []; app.ui = { say: (value) => bubbles.push(value) };
    return { app, ctx, settings, calls, bubbles };
}
const proposal = () => ({ proposals: [{ type: 'plan', plotId: 'p1', stage: 'planned', plan: { objective: '设置陷阱', traceObjective: '门把手留下新划痕', apprentice: { name: '商人', introduce: false, evidence: [{ index: 1, quote: '商人站在大厅', conditionId: '' }] }, conditions: [{ id: 'c1', event: '陷阱启动', counter: '拆除陷阱' }] }, evidence: [] }], commentary: 'SECRET SHOULD NOT LEAK', emotion: 'smile' });

test('director uses verified ST signature and unsupported host is explicit', () => {
    const { ctx, calls } = setup();
    assert.equal(setDirectorPrompt(ctx, 'data'), true);
    assert.deepEqual(calls[0], [ADVERSARY_PROMPT_KEY, 'data', 1, 0, false, 0]);
    assert.equal(directorStatus({}).supported, false);
    assert.equal(setDirectorPrompt({}, 'data'), false);
});

test('post-prose controller observes shared facts first, persists separate ledgers, leaves prose intact, clears prompt on return', async () => {
    const { app, ctx, settings, calls, bubbles } = setup();
    const old = LlmClient.prototype.complete; const requests = [];
    const fact = { id: 'damaged-lock', actor: '门锁', action: '损坏', result: '门锁损坏', status: 'confirmed', knowledge: [], evidence: [{ index: 1, quote: '门锁损坏。' }] };
    LlmClient.prototype.complete = async ({ system, user }) => {
        if (system.startsWith('Observe neutral events, relationships and information in completed roleplay prose.')) {
            requests.push('facts');
            const input = JSON.parse(user);
            assert.equal(input.targetIndex, 1);
            assert.equal(input.latestProse, ctx.chat[1].mes);
            return { ok: true, text: JSON.stringify({ proposals: [fact] }) };
        }
        if (system.includes('熟悉这部作品的读者')) {
            requests.push('retrieval');
            return { ok: true, text: '{"phase":"大厅","pick":[],"why":"缺少适用条件"}' };
        }
        requests.push('adversary');
        assert.match(user, /damaged-lock/, 'adversary must receive persisted shared facts');
        return { ok: true, text: JSON.stringify(proposal()) };
    };
    try {
        const original = JSON.stringify(ctx.chat);
        const outcome = await app.runPostGeneration();
        assert.equal(outcome.ok, true);
        assert.deepEqual(requests, ['facts', 'adversary']);
        assert.equal(JSON.stringify(ctx.chat), original);
        const persisted = ctx.chatMetadata['beatrice-guide'];
        assert.deepEqual(persisted.facts.facts, [fact], 'shared fact ledger must persist alongside adversary');
        assert.equal(persisted.facts.lastTargetIndex, 1);
        assert.equal(persisted.facts.snapshots.length, 1);
        assert.equal(persisted.adversary.plots.length, 1);
        assert.notEqual(persisted.facts, persisted.adversary);
        assert.ok(calls.at(-1)[1].includes('p1'));
        assert.ok(bubbles.every(v => typeof v === 'string' && !v.includes('SECRET')));
        await app.runPostGeneration(); assert.deepEqual(requests, ['facts', 'adversary'], 'same floor must reuse facts and adversary observations');
        assert.deepEqual(ctx.chatMetadata['beatrice-guide'].facts.facts, [fact]);
        settings.realm = 'beatrice'; app.syncAdversaryDirector(); assert.equal(calls.at(-1)[1], '');
        settings.realm = 'void'; app.syncAdversaryDirector(); assert.ok(calls.at(-1)[1].includes('p1'));
        ctx.chat[1].mes = '新的分支'; app.syncAdversaryDirector(); assert.equal(app.adversaryState().plots.length, 0);
        assert.ok(!calls.at(-1)[1].includes('p1'));
        await app.clearAdversary(); assert.equal(ctx.chatMetadata['beatrice-guide'].adversary, undefined);
    } finally { LlmClient.prototype.complete = old; }
});
