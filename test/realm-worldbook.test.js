import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { RULE_BOOK, isRuleBook, installRealmWorldbookGuard } from '../src/realm-worldbook.js';

const KEYS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
function host(useLast = true) {
    const handlers = [];
    const calls = [];
    const source = {
        on(event, fn) { calls.push(['on', event]); handlers.push(fn); },
        removeListener(event, fn) { calls.push(['remove', event]); const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); },
    };
    if (useLast) source.makeLast = (event, fn) => { calls.push(['makeLast', event]); handlers.push(fn); };
    return {
        context: { eventSource: source, eventTypes: { WORLDINFO_ENTRIES_LOADED: 'loaded' }, chatId: 'one', settings: { realm: 'beatrice', enabled: false } },
        calls,
        emit(payload) { for (const fn of [...handlers]) fn(payload); },
        handlers,
    };
}
function lore() {
    return Object.fromEntries(KEYS.map(key => [key, [
        { world: 'Other', uid: 1, disable: false },
        { world: RULE_BOOK, uid: 1, disable: false },
        { world: RULE_BOOK, uid: 1, disable: true },
        { world: ` ${RULE_BOOK}`, uid: 2 },
        { world: `${RULE_BOOK}续`, uid: 3 },
    ]]));
}

describe('Runtime dedicated realm worldbook guard', () => {
    test('scanner exclusion trims only the exact dedicated name', () => {
        assert.equal(RULE_BOOK, '人神对抗规则');
        for (const name of [RULE_BOOK, ` ${RULE_BOOK}\n`]) assert.equal(isRuleBook(name), true);
        for (const name of [null, undefined, {}, 123, '', '人神', `${RULE_BOOK}续`]) assert.equal(isRuleBook(name), false);
    });
    test('Beatrice filters all four arrays in place even with plugin disabled; preserves other entries', () => {
        const h = host();
        const guard = installRealmWorldbookGuard(() => h.context, ctx => ctx.settings);
        const payload = lore();
        const originals = Object.fromEntries(KEYS.map(key => [key, [...payload[key]]]));
        const refs = { ...payload };
        h.emit(payload);
        assert.equal(guard.supported, true);
        assert.equal(h.calls[0][0], 'makeLast');
        for (const key of KEYS) {
            assert.equal(payload[key], refs[key]);
            assert.deepEqual(payload[key], [originals[key][0], originals[key][3], originals[key][4]]);
            assert.equal(originals[key][1].disable, false);
            assert.equal(originals[key][2].disable, true);
        }
        assert.deepEqual(guard.status().last, { realm: 'beatrice', filtered: 8, chatId: 'one', ok: true });
        assert.equal(guard.status().active, true);
    });
    test('void leaves all arrays and disable states unchanged without attaching anything', () => {
        const h = host(false);
        h.context.settings.realm = 'void';
        const guard = installRealmWorldbookGuard(() => h.context, ctx => ctx.settings);
        const payload = lore();
        const before = JSON.stringify(payload);
        const refs = { ...payload };
        h.emit(payload);
        assert.equal(JSON.stringify(payload), before);
        for (const key of KEYS) assert.equal(payload[key], refs[key]);
        assert.equal(h.calls[0][0], 'on');
        assert.equal(guard.status().filtered, 0);
        assert.equal(guard.status().active, false);
    });
    test('fresh context and settings are used after runtime chat and realm switches', () => {
        const h = host();
        let current = h.context;
        const guard = installRealmWorldbookGuard(() => current, ctx => ctx.settings);
        h.emit(lore());
        current = { ...current, chatId: 'two', settings: { realm: 'void' } };
        const reopened = lore();
        h.emit(reopened);
        assert.equal(reopened.globalLore.length, 5);
        assert.deepEqual(guard.status().last, { realm: 'void', filtered: 0, chatId: 'two', ok: true });
        current = { ...current, chatId: 'three', settings: { realm: 'beatrice' } };
        const closed = lore();
        h.emit(closed);
        assert.equal(closed.globalLore.length, 3);
        assert.equal(guard.status().last.chatId, 'three');
        guard.dispose();
        guard.dispose();
        assert.equal(h.handlers.length, 0);
        assert.equal(h.calls.filter(call => call[0] === 'remove').length, 1);
        const untouched = lore();
        h.emit(untouched);
        assert.equal(untouched.globalLore.length, 5);
        assert.equal(guard.supported, false);
        assert.equal(guard.status().active, false);
    });
    test('unsupported host and callback failures warn without reporting fake success', () => {
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args);
        try {
            const missing = installRealmWorldbookGuard(() => ({}), () => ({ realm: 'beatrice' }));
            assert.equal(missing.supported, false);
            assert.match(missing.status().error, /WORLDINFO_ENTRIES_LOADED/);
            const h = host();
            const guard = installRealmWorldbookGuard(() => h.context, ctx => ctx.settings);
            const payload = lore();
            delete payload.personaLore;
            const before = JSON.stringify(payload);
            assert.doesNotThrow(() => h.emit(payload));
            assert.equal(JSON.stringify(payload), before);
            assert.equal(guard.supported, false);
            assert.equal(guard.status().last.ok, false);
            assert.equal(guard.status().filtered, 0);
            guard.dispose();
            assert.equal(h.handlers.length, 0);
            assert.equal(warnings.length, 2);
        } finally { console.warn = originalWarn; }
    });
    test('fresh context exceptions are caught and frozen arrays never claim suppression', () => {
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            const h = host();
            let broken = false;
            const guard = installRealmWorldbookGuard(() => { if (broken) throw new Error('no context'); return h.context; }, ctx => ctx.settings);
            broken = true;
            const payload = lore();
            assert.doesNotThrow(() => h.emit(payload));
            assert.equal(payload.globalLore.length, 5);
            assert.equal(guard.status().active, false);
            assert.match(guard.status().error, /no context/);
            guard.dispose();
            const frozen = installRealmWorldbookGuard(() => h.context, ctx => ctx.settings);
            const frozenPayload = lore();
            Object.freeze(frozenPayload.globalLore);
            assert.doesNotThrow(() => h.emit(frozenPayload));
            assert.equal(frozen.supported, false);
            assert.equal(frozen.status().last.ok, false);
            frozen.dispose();
        } finally { console.warn = originalWarn; }
    });
});
