import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { buildConfigSections, createSettingsWindow } from '../src/ui/panel.js';

class Node {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.style = {}; this.dataset = {}; this.attrs = {}; this.listeners = {}; this._text = ''; this.classList = { add() {} }; }
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get textContent() { return this._text + this.childNodes.map(n => n.textContent).join(''); }
    appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
    replaceChildren(...nodes) { this._text = ''; this.childNodes = []; nodes.forEach(n => this.appendChild(n)); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(k, fn) { this.listeners[k] = fn; }
    querySelector(tag) { return walk(this).find(n => n.tagName === tag); }
    async click() { await this.listeners.click?.({ target: this, preventDefault() {} }); }
}
function walk(node) { return [node, ...(node.childNodes ?? []).flatMap(walk)]; }
function nodes(body) { return body.flatMap(walk); }
function btn(body, label) { return nodes(body).find(n => n.tagName === 'button' && n.textContent === label); }

for (const realm of ['beatrice', 'void']) test(`panel controls and live card save in ${realm}`, async () => {
    const previous = globalThis.document;
    const previousTimeout = globalThis.setTimeout;
    globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => { const n = new Node('#text'); n.textContent = text; return n; } };
    globalThis.setTimeout = () => 0; // Worldbook-list timer is unrelated to these focused UI checks.
    try {
        let currentCard = 'Card A';
        const saved = [];
        let picks;
        let confirms = 0;
        const settings = defaultSettings();
        settings.worldbook.bookNames = ['Selected'];
        settings.realm = realm;
        const app = {
            settings, ctx: {}, persistSettings() {}, log() {}, channelStatus: () => ({ ready: true }),
            readHookPool: () => ({ ok: true, character: currentCard, hooks: [], fresh: true, note: 'ready' }),
            saveHookPool: async (...args) => { assert.equal(args.length, 0); saved.push(currentCard); return { ok: true, character: currentCard }; },
            buildHookPool: async () => ({ ok: true, needsConfirmation: true, reviewId: 'review-1',
                candidates: [{ uid: 1, comment: '事件', content: '原文' }], selectedIndices: [0], coverage: { complete: true } }),
            confirmHookPoolSelection: async (indices, options) => {
                confirms++;
                assert.deepEqual(indices, [0]);
                assert.equal(options.reviewId, 'review-1');
                return { ok: true, hooks: [{ label: '事件' }] };
            },
            prepareScanCandidates: async () => ({ scanned: 1, skipped: 0, candidates: [{ uid: 1, comment: '事件', content: '原文' }] }),
            buildHookPoolFromPicks: async (candidates, chosen) => { picks = chosen; return { ok: true, hooks: candidates.map(c => ({ label: c.comment })) }; },
        };
        const sections = buildConfigSections(app);
        const lore = sections.find(s => s.id === 'lore').body;
        const text = nodes(lore).map(n => n.textContent).join('\n');
        assert.ok(text.includes(`${realm === 'void' ? '人神' : '贝翠丝'}会读完`));
        assert.ok(text.includes('全部条目正文'));
        assert.ok(text.includes('未来事件和出场人物'));
        for (const removed of ['③ 排除', '③ 或者自己挑', '只读带标签的条目', '每条送给 AI 的正文长度', 'AI 通读上限', '常量条目（蓝灯）也纳入']) assert.ok(!text.includes(removed), removed);
        const read = btn(lore, '🔎 让 AI 通读世界书');
        const manual = btn(lore, '📋 列出条目让我自己挑');
        assert.equal(read.parentNode, manual.parentNode);
        await read.click();
        assert.equal(confirms, 0, 'AI reading cannot auto-confirm the selection');
        assert.ok(nodes(lore).some(n => n.textContent.includes('原文')), 'review exposes full candidate body');
        await btn(lore, '确认选择并开始提取').click();
        assert.equal(confirms, 1, 'only the human confirmation button starts extraction');
        await manual.click();
        await btn(lore, '☑ 全选').click();
        await btn(lore, '✅ 用勾选的条目建立线索池').click();
        assert.deepEqual(picks, [1]);
        const pool = sections.find(s => s.id === 'pool').body;
        assert.ok(nodes(pool).some(n => n.textContent.includes('绑定在「Card A」上')));
        const save = btn(pool, '保存并绑定当前角色卡');
        assert.ok(save);
        currentCard = 'Card B';
        await save.click();
        assert.deepEqual(saved, ['Card B']);
        assert.ok(nodes(pool).some(n => n.textContent.includes('绑定在「Card B」上')));
        const win = createSettingsWindow({ app });
        if (realm === 'void') assert.ok(walk(win.node).some(n => n.tagName === 'button' && n.textContent === '返回碧翠丝的禁书库'));
    } finally {
        globalThis.document = previous;
        globalThis.setTimeout = previousTimeout;
    }
});
