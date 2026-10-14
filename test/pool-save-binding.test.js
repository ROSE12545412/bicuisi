import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { setCharacterPool, getCharacterPool, characterKey, isCharacterPoolFresh } from '../src/core/store.js';
import { defaultSettings } from '../src/config.js';

function context(avatar, shared = {}) {
    return { characterId: 0, characters: [{ name: avatar, avatar }], extensionSettings: shared, chatMetadata: {} };
}

test('显式保存的池绑定当前卡且不被旧 metadata 改写', () => {
    const shared = {};
    const a = context('card-a.png', shared);
    const b = context('card-b.png', shared);
    const result = setCharacterPool(a, [{ title: '登场事件', content: '第二章旅人登场' }], ['剧情书'], { character: 'wrong-card', savedAt: Date.now(), at: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.pool.character, characterKey(a));
    assert.equal(getCharacterPool(b), null);
    assert.equal(isCharacterPoolFresh(a, defaultSettings(), ['剧情书']), true);
    assert.equal(isCharacterPoolFresh(a, defaultSettings(), ['其他书']), false);
});
