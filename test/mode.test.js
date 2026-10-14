import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { defaultSettings, deepDefaults, normalizeSettings, CODE_REVISION } from '../src/config.js';
import { isVoid, guideName, modeImageUrl } from '../src/mode.js';
import { resolvePersonaPrompts, defaultPersonaPrompts, buildPersonaMessages, buildCommentaryRules, buildOutputSchema } from '../src/prompts.js';

describe('Reversible void realm', () => {
    test('defaults, unknown values and legacy settings normalize safely', () => {
        assert.equal(defaultSettings().realm, 'beatrice');
        assert.equal(CODE_REVISION, 'r2026-10-12.35');
        for (const realm of [undefined, null, 'unknown', false]) {
            assert.equal(normalizeSettings(deepDefaults({ realm }, defaultSettings())).realm, 'beatrice');
        }
        const s = defaultSettings();
        s.realm = 'void';
        s.voidPersona.prompts = [{ content: 'custom', role: 'invalid' }, null];
        normalizeSettings(s);
        assert.equal(isVoid(s), true);
        assert.equal(s.voidPersona.prompts.length, 1);
        assert.equal(s.voidPersona.prompts[0].role, 'system');
        assert.notEqual(defaultSettings().voidPersona.prompts, defaultSettings().voidPersona.prompts);
    });
    test('names and image URLs follow realm and preserve custom Beatrice art', () => {
        const s = defaultSettings();
        s.persona.name = 'Custom name';
        s.ui.customImageSrc = 'https://example.com/custom.png';
        assert.equal(guideName(s), 'Custom name');
        assert.equal(modeImageUrl(s), s.ui.customImageSrc);
        assert.ok(modeImageUrl(s, 'inline').endsWith('/assets/guidance-avatar.jpg'));
        s.realm = 'void';
        assert.equal(guideName(s), '人神');
        assert.ok(modeImageUrl(s).endsWith('/assets/hitogami.jpg'));
        assert.equal(modeImageUrl(s), modeImageUrl(s, 'inline'));
        s.realm = 'beatrice';
        assert.equal(modeImageUrl(s), s.ui.customImageSrc);
        s.ui.customImageSrc = '';
        s.persona.name = '  ';
        assert.equal(guideName(s), '贝翠丝');
        assert.ok(modeImageUrl(s).endsWith('/assets/beatrice.png'));
    });
    test('realm changes isolate overrides, disabled prompts and stored Beatrice data', () => {
        const s = defaultSettings();
        s.persona.overridePrompt = 'Beatrice override';
        s.persona.prompts = [{ id: 'edited', content: 'Edited Beatrice', enabled: false, role: 'user' }];
        s.persona.promptsVersion = 1;
        const before = JSON.stringify(s.persona);
        s.realm = 'void';
        assert.ok(resolvePersonaPrompts(s).some(p => p.id === 'void-identity'));
        s.voidPersona.overridePrompt = 'Void override';
        assert.equal(resolvePersonaPrompts(s)[0].content, 'Void override');
        s.voidPersona.overridePrompt = '';
        s.voidPersona.prompts = [{ id: 'off', role: 'user', content: 'off', enabled: false }, { id: 'on', role: 'assistant', content: 'on', enabled: true }];
        assert.deepEqual(resolvePersonaPrompts(s).map(p => p.content), ['on']);
        assert.equal(JSON.stringify(s.persona), before);
        s.realm = 'beatrice';
        assert.equal(resolvePersonaPrompts(s)[0].content, 'Beatrice override');
        assert.equal(JSON.stringify(s.persona), before);
        assert.equal(s.voidPersona.prompts.length, 2);
    });
    test('Hitogami defaults and general rules honor fiction boundaries without Beatrice personality', () => {
        const s = defaultSettings();
        s.realm = 'void';
        const prompts = defaultPersonaPrompts(s).map(p => p.content).join('\n');
        assert.ok(prompts.includes('人神'));
        assert.ok(prompts.includes('片面真相、选择性省略'));
        assert.ok(prompts.includes('不要公开标注哪句是真话、哪句是假话'));
        assert.ok(prompts.includes('不得捏造或篡改正史事实'));
        assert.ok(prompts.includes('用户结合剧情自行判断'));
        assert.ok(prompts.includes('不得用于现实世界欺骗'));
        assert.ok(buildCommentaryRules(s).includes('友善随和'));
        assert.ok(!buildCommentaryRules(s).includes('刻薄但心软'));
        assert.ok(buildOutputSchema(s).value.properties.commentary.description.includes('友善闲聊'));
        const messages = buildPersonaMessages(s, 'Current scene');
        assert.equal(messages.at(-1).content, 'Current scene');
        assert.ok(messages.at(-2).content.includes('友善闲聊'));
        s.commentary.enabled = false;
        assert.ok(buildCommentaryRules(s).includes('留空字符串'));
    });
});
