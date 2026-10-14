import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
import { runGuide, normalizeSourceAssessment, retrieveVerifiedSources } from '../src/llm/guide.js';

const original = 'After the invitation arrives, the blue bell rings at the gate.';
const finishedText = 'The invitation arrived. The traveler opened it.';
const hooks = [{ book: 'Canon', uid: 1, label: 'Bell', brief: 'SUMMARY_SECRET', content: 'STALE_SECRET' }];
const locate = { ok: true, text: JSON.stringify({ phase: 'at gate', pick: [1] }) };
const compose = { ok: true, text: JSON.stringify({ guidance: 'That sound is worth a moment.', commentary: '', emotion: 'calm', hooks_used: [], sourceAssessment: [] }) };
const row = (patch = {}) => ({ book: 'Canon', uid: 1, status: 'applicable', conditions: ['Invitation arrival: established by completed prose'], reason: 'Arrival evidenced', evidence: ['After the invitation arrives', 'The invitation arrived.'], ...patch });
const assessment = (rows) => ({ ok: true, text: JSON.stringify({ sourceAssessment: rows }) });
function context(second = '') {
    return { chat: [], chatMetadata: {}, loadWorldInfo: async () => ({ entries: {
        1: { uid: 1, content: original }, ...(second ? { 2: { uid: 2, content: second } } : {}),
    } }) };
}
async function mocked(responses, fn) {
    const old = LlmClient.prototype.complete; const calls = [];
    LlmClient.prototype.complete = async function (opts) {
        calls.push(opts); assert.ok(responses.length, 'unexpected extra API call'); return responses.shift();
    };
    try { await fn(calls); } finally { LlmClient.prototype.complete = old; }
}

describe('r22 source applicability is an enforced pre-composition gate', () => {
    for (const realm of ['beatrice', 'void']) {
        for (const bad of [row({ status: 'unknown', conditions: ['Invitation unknown'] }), row({ status: 'excluded' }), row({ evidence: ['conditions all satisfied'] }), row({ conditions: ['all conditions satisfied'] }), row({ conditions: ['Arrival unknown despite claim'] }), row({ evidence: ['After the invitation arrives', 'Invented arrival quote'] })]) {
            test(`${realm}: rejects ${bad.status}/${bad.conditions.join(',')}/${bad.evidence.join(',')}`, async () => {
                const settings = defaultSettings(); settings.realm = realm;
                await mocked([locate, assessment([bad])], async (calls) => {
                    const out = await runGuide(context(), settings, { hooks, finishedText });
                    assert.equal(calls.length, 2); assert.equal(out.ok, false); assert.equal(out.recoverable, true);
                    assert.equal(out.result.guidance, ''); assert.equal(out.result.commentary, '');
                    assert.equal(out.retrievedSources, 1); assert.equal(out.sourceAssessment.length, 1);
                    assert.notEqual(out.sourceAssessment[0].status, 'applicable');
                });
            });
        }
    }
    test('approved exact original and completed prose evidence permits composition', async () => {
        await mocked([locate, assessment([row()]), compose], async (calls) => {
            const out = await runGuide(context(), defaultSettings(), { hooks, finishedText });
            assert.equal(out.ok, true); assert.equal(calls.length, 3);
            assert.equal(calls[1].maxTokens, 3000); assert.equal(calls[1].temperature, 0.1);
            const prompt = JSON.stringify(calls[2].messages);
            assert.ok(prompt.includes(original)); assert.ok(!prompt.includes('SUMMARY_SECRET')); assert.ok(!prompt.includes('STALE_SECRET'));
            assert.equal(out.sourceAssessment[0].status, 'applicable');
        });
    });
    test('mixed sources retain diagnostics but excluded original never reaches composition', async () => {
        const rejected = 'REJECTED_SECRET: requires the dragon awakening.';
        const second = { book: 'Canon', uid: 2, label: 'Dragon', brief: 'REJECTED_SUMMARY' };
        await mocked([{ ok: true, text: '{"phase":"REJECTED_SECRET phase","pick":[1,2]}' }, assessment([row(), row({ uid: 2, status: 'unknown', conditions: ['Awakening missing'] })]), compose], async (calls) => {
            const out = await runGuide(context(rejected), defaultSettings(), { hooks: [...hooks, second], finishedText });
            assert.equal(out.ok, true); assert.equal(out.retrievedSources, 2); assert.equal(out.hooks.length, 1);
            assert.equal(out.sourceAssessment.length, 2); assert.equal(out.sourceAssessment[1].status, 'unknown');
            const prompt = JSON.stringify(calls[2].messages);
            assert.ok(!prompt.includes('REJECTED_SECRET')); assert.ok(!prompt.includes('REJECTED_SUMMARY'));
        });
    });
    test('no picked source retains generic situational composition without assessment call', async () => {
        await mocked([{ ok: true, text: '{"phase":"waiting","pick":[]}' }, compose], async (calls) => {
            const out = await runGuide(context(), defaultSettings(), { hooks, finishedText: 'The traveler waited.' });
            assert.equal(calls.length, 2); assert.equal(out.ok, true); assert.deepEqual(out.sourceAssessment, []);
            assert.equal(out.retrievedSources, 0); assert.ok(!JSON.stringify(calls[1].messages).includes(original));
        });
    });
    test('malformed assessment closes round; never salvages text as guidance', async () => {
        await mocked([locate, { ok: true, text: 'Use the secret bell.' }], async (calls) => {
            const out = await runGuide(context(), defaultSettings(), { hooks, finishedText });
            assert.equal(calls.length, 2); assert.equal(out.ok, false); assert.equal(out.result.guidance, '');
            assert.equal(out.sourceAssessment[0].status, 'unknown');
        });
    });
    test('shared retrieval for other paths exposes approved sources only', async () => {
        await mocked([locate, assessment([row({ status: 'excluded' })])], async () => {
            const out = await retrieveVerifiedSources(context(), defaultSettings(), { hooks, finishedText });
            assert.deepEqual(out.sources, []); assert.equal(out.retrievedSources, 1);
            assert.equal(out.sourceAssessment[0].status, 'excluded'); assert.ok(out.error);
        });
    });
    test('exact quote cannot cherry-pick positive fragment out of negation', () => {
        const rows = normalizeSourceAssessment([row()], [{ ...hooks[0], content: original }], ['The invitation arrived.']);
        assert.equal(rows[0].status, 'applicable');
        assert.equal(normalizeSourceAssessment([row({ evidence: ['After the invitation arrives', 'invitation arrived'] })], [{ ...hooks[0], content: original }], ['No invitation arrived.'])[0].status, 'unknown');
        assert.equal(normalizeSourceAssessment([row(), row()], [{ ...hooks[0], content: original }], [finishedText])[0].status, 'unknown');
    });
});
