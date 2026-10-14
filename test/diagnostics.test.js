/** 诊断导出不得泄露直连 API 凭据。 */

import { strict as assert } from 'node:assert';
import { describe, test } from './_harness.js';
import { redactDiagnostics } from '../src/ui/panel.js';

describe('redactDiagnostics —— 可安全粘贴到公开 Issue', () => {
    test('递归隐藏常见凭据字段，并保留排障所需的非敏感设置', () => {
        const settings = {
            llm: {
                mode: 'custom',
                custom: {
                    url: 'https://api.example.test/v1',
                    key: 'sk-super-secret',
                    model: 'example-model',
                },
            },
            futureAuth: {
                apiKey: 'future-key',
                api_key: 'snake-key',
                authorization: 'Bearer token',
                token: 'access-token',
                secret: 'shared-secret',
                password: 'password-value',
            },
        };

        const redacted = redactDiagnostics(settings);
        const text = JSON.stringify(redacted);

        for (const secret of [
            'sk-super-secret',
            'future-key',
            'snake-key',
            'Bearer token',
            'access-token',
            'shared-secret',
            'password-value',
        ]) {
            assert.equal(text.includes(secret), false);
        }
        assert.equal(redacted.llm.custom.key, '[REDACTED]');
        assert.equal(redacted.llm.custom.url, settings.llm.custom.url);
        assert.equal(redacted.llm.custom.model, settings.llm.custom.model);
    });

    test('不修改原设置，数组里的嵌套凭据也会隐藏', () => {
        const settings = { providers: [{ name: 'one', apiKey: 'array-secret' }] };
        const redacted = redactDiagnostics(settings);

        assert.notEqual(redacted, settings);
        assert.notEqual(redacted.providers, settings.providers);
        assert.equal(redacted.providers[0].apiKey, '[REDACTED]');
        assert.equal(settings.providers[0].apiKey, 'array-secret');
    });
});
