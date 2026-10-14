import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { GuideController } from '../src/app.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
import { collectCandidates } from '../src/worldbook.js';
import { retrieveVerifiedSources } from '../src/llm/guide.js';

test('dedicated adversary rules never enter either realm source scan or direct retrieval', async () => {
    for (const realm of ['beatrice', 'void']) {
        const s = defaultSettings(); s.realm = realm; s.worldbook.bookNames = ['人神对抗规则', '剧情'];
        const read = []; const ctx = { chatMetadata: {}, chat: [], loadWorldInfo: async name => { read.push(name); return { entries: { 1: { uid: 1, content: 'actual source' } } }; } };
        const collected = await collectCandidates(ctx, s);
        assert.deepEqual(read, ['剧情']); assert.ok(collected.candidates.every(h => h.book === '剧情'));
        const retrieved = await retrieveVerifiedSources(ctx, s, { hooks: [{ book: '人神对抗规则', uid: 1, brief: 'SECRET_RULE' }] });
        assert.deepEqual(retrieved.sources, []); assert.deepEqual(read, ['剧情']);
    }
});

test('Beatrice observes neutral facts then composes benevolent guidance without adversary secrets', async () => {
    const s = defaultSettings(); s.adversary.enabled = true;
    const ctx = { name2: 'card', chatId: 'room', chatMetadata: { 'beatrice-guide': { adversary: { secret: 'NEVER_READ_SECRET' } } }, chat: [{ mes: '旅人到达大厅。' }], saveMetadata: async () => {} };
    const app = new GuideController(ctx, s); app.currentHookPool = () => ({ hooks: [], books: [] });
    const old = LlmClient.prototype.complete; const calls = [];
    LlmClient.prototype.complete = async opts => {
        calls.push(opts); assert.ok(!JSON.stringify(opts).includes('NEVER_READ_SECRET'));
        if (opts.system?.startsWith('Observe neutral events')) return { ok: true, text: JSON.stringify({ proposals: [{ id: 'arrival', actor: '旅人', action: '到达', result: '大厅', status: 'confirmed', knowledge: [], evidence: [{ index: 0, quote: '旅人到达大厅。' }] }] }) };
        assert.match(JSON.stringify(opts.messages), /绝对善意/); assert.match(JSON.stringify(opts.messages), /arrival/);
        return { ok: true, text: JSON.stringify({ guidance: '先歇一歇吧。', commentary: '', emotion: 'calm', sourceAssessment: [] }) };
    };
    try {
        const out = await app.askNow(); assert.equal(out.ok, true); assert.equal(out.realm, 'beatrice');
        assert.equal(calls.length, 2); assert.equal(app.factState().facts[0].id, 'arrival');
        assert.equal(ctx.chatMetadata['beatrice-guide'].adversary.secret, 'NEVER_READ_SECRET');
        await app.askNow(); assert.equal(calls.length, 3, 'same prose reuses fact observation');
    } finally { LlmClient.prototype.complete = old; }
});
