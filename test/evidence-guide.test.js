import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
import { runGuide, retrieveVerifiedSources, normalizeSourceAssessment, parseGuideResult, buildLocateSystemPrompt, buildLocateUserPrompt } from '../src/llm/guide.js';
import { buildPersonaMessages, buildUserPrompt, buildOutputSchema } from '../src/prompts.js';

const hooks = [
    { book: 'Canon', uid: 1, label: 'Selected', brief: 'SUMMARY_ONLY', content: 'STALE_CANON' },
    { book: 'Canon', uid: 2, label: 'Unselected', brief: 'UNSELECTED_BRIEF', content: 'UNSELECTED_CACHE' },
];
const original = `ORIGINAL_START ${'x'.repeat(650)} ORIGINAL_END: requires arrival after invitation.`;
function context(fail = false) {
    return { chat: [], chatMetadata: {}, loadWorldInfo: async () => {
        if (fail) throw new Error('unavailable');
        return { entries: { 1: { uid: 1, content: original }, 2: { uid: 2, content: 'OTHER_ORIGINAL' } } };
    } };
}
async function mocked(responses, fn) {
    const old = LlmClient.prototype.complete;
    const calls = [];
    LlmClient.prototype.complete = async function (opts) { calls.push(opts); return responses.shift(); };
    try { return await fn(calls); } finally { LlmClient.prototype.complete = old; }
}
const locate = { ok: true, text: '{"phase":"arrival","pick":[1],"why":"candidate requires checking"}' };
function composed(sourceAssessment = []) {
    return { ok: true, text: JSON.stringify({ guidance: 'Take a breath.', commentary: '', emotion: 'calm', hooks_used: [], sourceAssessment }) };
}

describe('Evidence-only guide retrieval and composition', () => {
    for (const realm of ['beatrice', 'void']) {
        test(`${realm}: even off locates, reads selected full original, excludes summaries`, async () => {
            const settings = defaultSettings(); settings.realm = realm; settings.guidance.locate = 'off';
            await mocked([locate, { ok: true, text: JSON.stringify({ sourceAssessment: [{ book: 'Canon', uid: 1, status: 'unknown', conditions: ['Invitation not evidenced'], reason: 'missing invitation', evidence: ['requires arrival after invitation.'] }] }) }], async (calls) => {
                const out = await runGuide(context(), settings, { hooks, finishedText: 'The traveler arrived.' });
                assert.equal(calls.length, 2);
                const prompt = calls[1].user;
                assert.equal(out.ok, false);
                assert.equal(out.result.guidance, '');
                assert.equal(out.result.commentary, '');
                assert.equal(out.retrievedSources, 1);
                assert.ok(prompt.includes(original));
                for (const excluded of ['SUMMARY_ONLY', 'STALE_CANON', 'UNSELECTED_BRIEF', 'UNSELECTED_CACHE', 'OTHER_ORIGINAL']) assert.ok(!prompt.includes(excluded), excluded);
                assert.equal(out.hooks.length, 1);
                assert.equal(out.sourceAssessment[0].status, 'unknown');
                assert.equal(out.sourceAssessment[0].reason, 'missing invitation');
            });
        });
    }
    test('read failure cannot fall back to stale canon or summary', async () => {
        await mocked([locate, composed()], async (calls) => {
            const out = await runGuide(context(true), defaultSettings(), { hooks, finishedText: 'Waiting.' });
            assert.deepEqual(out.hooks, []);
            assert.deepEqual(out.sourceAssessment, []);
            const prompt = JSON.stringify(calls[1].messages);
            assert.ok(!prompt.includes('SUMMARY_ONLY')); assert.ok(!prompt.includes('STALE_CANON'));
        });
    });
    test('locate failure never composes from the index', async () => {
        await mocked([{ ok: false, error: 'offline' }, composed()], async (calls) => {
            const out = await runGuide(context(), defaultSettings(), { hooks });
            assert.deepEqual(out.hooks, []);
            assert.ok(!JSON.stringify(calls[1].messages).includes('SUMMARY_ONLY'));
        });
    });
    test('manual content is allowed only as marked noncanonical user notes', async () => {
        await mocked([locate, composed()], async (calls) => {
            const out = await runGuide(context(), defaultSettings(), { hooks: [{ label: 'Note', content: 'USER_CONTENT', brief: 'NOTE_SUMMARY' }] });
            const prompt = JSON.stringify(calls[1].messages);
            assert.ok(prompt.includes('USER_CONTENT')); assert.ok(prompt.includes('用户手写笔记：非正史'));
            assert.ok(!prompt.includes('NOTE_SUMMARY')); assert.equal(out.hooks[0].sourceType, 'user-note');
            assert.deepEqual(out.sourceAssessment, []);
        });
    });
    test('shared retrieval returns original only and fails closed', async () => {
        const finishedText = 'The traveler arrived after receiving the invitation.';
        const assessment = { ok: true, text: JSON.stringify({ sourceAssessment: [{ book: 'Canon', uid: 1,
            status: 'applicable', conditions: ['Invitation received and arrival completed in prose'],
            reason: 'Invitation precedes completed arrival', evidence: ['requires arrival after invitation.', finishedText] }] }) };
        await mocked([locate, assessment], async (calls) => {
            const out = await retrieveVerifiedSources(context(), defaultSettings(), { hooks, finishedText });
            assert.equal(calls.length, 2);
            assert.equal(out.sourceAssessment[0].status, 'applicable');
            assert.equal(out.sources[0].content, original); assert.equal(out.sources.length, 1);
            const prompt = calls[1].user;
            for (const excluded of ['SUMMARY_ONLY', 'STALE_CANON', 'UNSELECTED_BRIEF', 'UNSELECTED_CACHE', 'OTHER_ORIGINAL']) assert.ok(!prompt.includes(excluded), excluded);
        });
        await mocked([locate], async () => {
            assert.deepEqual((await retrieveVerifiedSources(context(true), defaultSettings(), { hooks })).sources, []);
        });
    });
    test('assessment rejects invented origins and downgrades unsupported applicability', () => {
        const rows = normalizeSourceAssessment([
            { book: 'Canon', uid: 1, status: 'applicable', conditions: [], evidence: [], reason: 'guess' },
            { book: 'Other', uid: 99, status: 'applicable', conditions: ['yes'], evidence: ['yes'] },
        ], hooks.slice(0, 1));
        assert.equal(rows.length, 1); assert.equal(rows[0].status, 'unknown');
        assert.equal(normalizeSourceAssessment([], hooks.slice(0, 1))[0].status, 'unknown');
    });
    test('parser retains optional assessment separately while preserving legacy result shape', () => {
        const parsed = parseGuideResult(composed([{ book: 'Canon', uid: 1, status: 'excluded' }]).text, defaultSettings());
        assert.equal(parsed.sourceAssessment.length, 1);
        assert.deepEqual(Object.keys(parsed.result), ['guidance', 'commentary', 'emotion', 'hooks_used']);
        assert.ok(buildOutputSchema(defaultSettings()).value.properties.sourceAssessment);
    });
    test('neutral facts reach locate and compose; normal immutable benevolence does not mix personas', () => {
        const facts = 'FACT: invitation absent from recorded evidence';
        assert.ok(buildLocateUserPrompt({ factsText: facts }, 'INDEX').includes(facts));
        assert.ok(buildLocateSystemPrompt(4).includes('允许 pick: []'));
        const s = defaultSettings(); s.persona.overridePrompt = 'CUSTOM';
        const normal = buildPersonaMessages(s, buildUserPrompt({ factsText: facts }, s), facts).map((m) => m.content).join('\n');
        assert.ok(normal.includes('绝对善意')); assert.ok(normal.includes('禁止恶意误导')); assert.ok(normal.includes(facts));
        assert.ok(!normal.includes('人神')); assert.ok(!normal.includes('不可靠引路人'));
        s.realm = 'void';
        const voidText = buildPersonaMessages(s, 'scene', facts).map((m) => m.content).join('\n');
        assert.ok(voidText.includes('不可靠引路人')); assert.ok(!voidText.includes('贝翠丝不可覆盖的善意边界'));
    });
});
