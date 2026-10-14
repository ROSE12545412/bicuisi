import assert from 'node:assert/strict';
import { test, describe } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { appendGuidanceToMessage, clearAppendedGuidance, repairDisplayedGuidance, observeDisplayedGuidance, displayReport, injectGuidance, clearPendingAppends } from '../src/inject.js';

const divider = '\n\n──────────\n贝翠丝：';
function fixture(fn) {
    const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, getComputedStyle: globalThis.getComputedStyle };
    const tails = new Map();
    let callback;
    class Node {
        constructor(tag = 'div') { this.tagName = tag; this.nodeType = 1; this.attrs = {}; this.children = []; this._text = ''; this.hidden = false; }
        get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
        set textContent(t) { this._text = String(t); this.children = []; }
        set innerHTML(_) { throw new Error('unsafe/reformatting body write'); }
        setAttribute(k, v) { this.attrs[k] = String(v); }
        getAttribute(k) { return this.attrs[k]; }
        replaceChildren(...nodes) { this._text = ''; this.children = nodes; nodes.forEach(n => n.parentElement = this); }
        remove() { tails.delete(Number(this.attrs['data-bg-message-id'])); }
        matches(sel) { return sel.includes('.TH-streaming') && this.className === 'TH-streaming'; }
        closest(sel) { if (sel === '#chat') return chatNode; return floor; }
    }
    const chatNode = new Node(); chatNode.id = 'chat';
    const floor = new Node(); floor.setAttribute('mesid', '0');
    const body = new Node(); body.textContent = 'rendered translation';
    const streaming = new Node(); streaming.className = 'TH-streaming';
    const iframe = new Node('iframe'); iframe.state = { loaded: true }; streaming.children = [iframe];
    const parent = new Node(); parent.children = [body, streaming];
    parent.insertBefore = (tail, next) => { parent.children.splice(next ? parent.children.indexOf(next) : parent.children.length, 0, tail); tail.parentElement = parent; tails.set(Number(tail.getAttribute('data-bg-message-id')), tail); };
    body.parentNode = parent; body.parentElement = parent; streaming.parentNode = parent;
    const doc = { body: chatNode, createElement: t => new Node(t), querySelector: sel => sel.includes('bg-inline-guidance') ? tails.get(0) ?? null : body, querySelectorAll: () => [...tails.values()] };
    globalThis.document = doc;
    globalThis.getComputedStyle = el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' });
    globalThis.MutationObserver = class { constructor(cb) { callback = cb; } observe() {} disconnect() {} };
    const ctx = { chat: [{ mes: 'original body', swipe_id: 0, extra: { display_text: '译文', unrelated: 42 } }], updateMessageBlock() { throw new Error('third-party body must not be rerendered'); } };
    const settings = defaultSettings();
    const api = { ctx, settings, body, tails, parent, streaming, iframe, notify: () => callback([{ target: body, addedNodes: [], removedNodes: [] }]) };
    return Promise.resolve().then(() => fn(api)).finally(() => { Object.assign(globalThis, saved); clearPendingAppends(); });
}
const append = (ctx, settings, guidance = 'safe advice') => appendGuidanceToMessage(ctx, 0, { guidance }, settings);

describe('r22 display ownership and source identity', () => {
    test('translation composes once, independent safe tail does not rewrite rendered body; clear restores override', () => fixture(({ ctx, settings, body, tails }) => {
        assert.equal(append(ctx, settings).ok, true);
        assert.equal(ctx.chat[0].extra.display_text, '译文' + divider + 'safe advice');
        assert.equal(body.textContent, 'rendered translation');
        assert.ok(tails.get(0).textContent.includes('safe advice'));
        append(ctx, settings, '<img src=x onerror=alert(1)>');
        assert.equal(ctx.chat[0].extra.display_text, '译文' + divider + '<img src=x onerror=alert(1)>');
        assert.equal(tails.get(0).children[1].textContent, '<img src=x onerror=alert(1)>');
        assert.equal(clearAppendedGuidance(ctx, 0), true);
        assert.equal(ctx.chat[0].extra.display_text, '译文');
        assert.equal(ctx.chat[0].extra.unrelated, 42);
        assert.equal(tails.size, 0);
        assert.equal(repairDisplayedGuidance(ctx, 0, { domOnly: true }), 0);
    }));
    test('clear removes a host-rendered combined translated display without falling back to raw mes', () => fixture(({ ctx, settings, body, tails }) => {
        append(ctx, settings);
        body.textContent = ctx.chat[0].extra.display_text;
        assert.equal(clearAppendedGuidance(ctx, 0), true);
        assert.equal(body.textContent, '译文');
        assert.equal(ctx.chat[0].extra.display_text, '译文');
        assert.equal(tails.size, 0);
    }));
    test('clear and repair never clobber intervening third-party display override', () => fixture(({ ctx, settings, body, tails }) => {
        append(ctx, settings);
        ctx.chat[0].extra.display_text = 'new translation';
        body.textContent = 'new raw rendered translation';
        assert.equal(clearAppendedGuidance(ctx, 0), true);
        assert.equal(ctx.chat[0].extra.display_text, 'new translation');
        assert.equal(body.textContent, 'new raw rendered translation');
        append(ctx, settings);
        ctx.chat[0].extra.display_text = 'another override';
        repairDisplayedGuidance(ctx, 0, { domOnly: true });
        assert.equal(ctx.chat[0].extra.display_text, 'another override');
        assert.equal(tails.size, 0);
    }));
    test('shortened prefix invalidates old body and advice; new append uses edited body', () => fixture(({ ctx, settings, body }) => {
        append(ctx, settings);
        ctx.chat[0].mes = 'original'; body.textContent = 'edited rendered body';
        repairDisplayedGuidance(ctx, 0, { domOnly: true });
        assert.equal(ctx.chat[0].extra.display_text, undefined);
        assert.equal(body.textContent, 'edited rendered body');
        delete ctx.updateMessageBlock;
        append(ctx, settings, 'new advice');
        assert.equal(ctx.chat[0].extra.display_text, 'original' + divider + 'new advice');
    }));
    test('equal-text swipe invalidates full source identity and discards saved old translation', () => fixture(({ ctx, settings, tails }) => {
        append(ctx, settings); ctx.chat[0].swipe_id = 1;
        repairDisplayedGuidance(ctx, 0, { domOnly: true });
        assert.equal(ctx.chat[0].extra.display_text, undefined);
        assert.equal(tails.size, 0);
    }));
    test('legacy prefix edit migrates exact raw source and deletes no unrelated metadata', () => fixture(({ ctx, tails }) => {
        const msg = ctx.chat[0]; msg.mes = 'original';
        msg.extra.display_text = 'original body' + divider + 'stale advice';
        msg.extra.beatriceGuide = { appendedTo: 0, at: 1, realm: 'void', foreign: 'keep' };
        repairDisplayedGuidance(ctx, 0, { domOnly: true });
        assert.equal(msg.extra.display_text, undefined);
        assert.deepEqual(msg.extra.beatriceGuide, { foreign: 'keep' });
        assert.equal(msg.extra.unrelated, 42);
        assert.equal(tails.size, 0);
        msg.extra.display_text = 'third party';
        msg.extra.beatriceGuide = { injected: true, reason: 'historical message', foreign: 'keep' };
        repairDisplayedGuidance(ctx, 0, { domOnly: true });
        assert.equal(msg.extra.display_text, 'third party');
        assert.equal(msg.extra.beatriceGuide.injected, true);
    }));
    test('observer respects raw plugin DOM, hidden streaming body and stable iframe; historical realm stays void', () => fixture(async ({ ctx, settings, body, tails, parent, streaming, iframe, notify }) => {
        settings.realm = 'void';
        append(ctx, settings);
        const msg = ctx.chat[0];
        // Mode is a generation-time property, not read from current settings during repair.
        assert.equal(msg.extra.beatriceGuide.realm, 'void');
        settings.realm = 'beatrice'; body.hidden = true;
        const stop = observeDisplayedGuidance(() => ctx);
        try {
            await new Promise(r => setTimeout(r, 100));
            tails.get(0).remove(); body.textContent = 'another plugin raw render'; notify();
            await new Promise(r => setTimeout(r, 100));
            assert.equal(body.textContent, 'another plugin raw render');
            assert.equal(parent.children[1], streaming);
            assert.equal(streaming.children[0], iframe);
            assert.deepEqual(iframe.state, { loaded: true });
            const tail = tails.get(0);
            assert.equal(tail.getAttribute('data-bg-realm'), 'void');
            assert.equal(tail.children[0].getAttribute('alt'), '人神');
            assert.equal(displayReport(ctx).onScreen, 1);
            ctx.chat[0].mes = 'edited'; notify();
            await new Promise(r => setTimeout(r, 100));
            assert.equal(ctx.chat[0].extra.display_text, undefined);
            assert.equal(tails.size, 0);
        } finally { stop(); }
    }));
    test('message injection optional lifecycle guard blocks mutation and save after stale render await', async () => {
        const settings = defaultSettings();
        const blocked = { chat: [], saveChat() { throw new Error('must not save'); } };
        assert.equal((await injectGuidance(blocked, { guidance: 'advice' }, settings, { validate: () => false })).ok, false);
        assert.equal(blocked.chat.length, 0);
        let valid = true; let saves = 0;
        const ctx = { chat: [], async addOneMessage() { valid = false; }, async saveChat() { saves++; } };
        assert.equal((await injectGuidance(ctx, { guidance: 'advice' }, settings, { validate: () => valid })).ok, false);
        assert.equal(saves, 0);
    });
});
