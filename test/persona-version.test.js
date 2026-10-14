import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { BUILTIN_PROMPTS_VERSION, defaultPersonaPrompts, migrateBuiltinPrompts, resolvePersonaPrompts } from '../src/prompts.js';
import { defaultSettings } from '../src/config.js';

describe('Prompt upgrades preserve user data', () => {
    test('old built-in IDs do not authorize replacing edited content, roles or disabled state', () => {
        const s = defaultSettings();
        s.persona.prompts = defaultPersonaPrompts(s).filter(p => p.id !== 'timing');
        s.persona.prompts[0].content = 'My edited identity';
        s.persona.prompts[1].enabled = false;
        s.persona.prompts[2].role = 'user';
        s.persona.promptsVersion = 0;
        const before = JSON.stringify(s.persona);
        assert.equal(migrateBuiltinPrompts(s), false);
        resolvePersonaPrompts(s);
        assert.equal(JSON.stringify(s.persona), before);
    });
    test('empty custom prompts resolve to current defaults without persisting a copy', () => {
        const s = defaultSettings();
        const result = resolvePersonaPrompts(s);
        assert.ok(result.some(p => p.id === 'timing'));
        assert.deepEqual(s.persona.prompts, []);
        assert.equal(s.persona.promptsVersion, BUILTIN_PROMPTS_VERSION);
    });
    test('whole prompt override remains untouched', () => {
        const s = defaultSettings();
        s.persona.overridePrompt = 'My full prompt';
        const before = JSON.stringify(s.persona);
        assert.equal(resolvePersonaPrompts(s)[0].content, 'My full prompt');
        assert.equal(JSON.stringify(s.persona), before);
    });
});
