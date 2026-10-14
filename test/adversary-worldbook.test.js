import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from './_harness.js';

test('adversary rule worldbook is importable constant system entry with guarded activation', () => {
    const book = JSON.parse(readFileSync(new URL('../docs/人神对抗规则.json', import.meta.url), 'utf8'));
    assert.equal(book.name, '人神对抗规则');
    const entry = book.entries['0'];
    assert.equal(entry.uid, 0);
    assert.equal(entry.constant, true);
    assert.equal(entry.disable, false);
    assert.equal(entry.position, 4);
    assert.equal(entry.role, 0);
    assert.equal(entry.depth, 0);
    assert.deepEqual(entry.key, []);
    assert.ok(entry.comment.startsWith('[禁止引导]'));
    for (const rule of ['没有该提示时', 'allowDeath=true', '同义表达有效', '不得代写用户', '失败阴谋不得复活', '另一次用户回应', '可察觉是有机会发现', '最终引爆与严格结算', '死了就是死了', '此前存在且实际满足条件', '不得突然插入']) assert.ok(entry.content.includes(rule), rule);
});
