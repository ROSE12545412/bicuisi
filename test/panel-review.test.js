import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { buildConfigSections } from '../src/ui/panel.js';

class ReviewNode {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.style = {}; this.dataset = {}; this.attrs = {}; this.listeners = {}; this._text = ''; this.classList = { add() {} }; }
    set textContent(value) { this._text = String(value); this.childNodes = []; }
    get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
    appendChild(node) { this.childNodes.push(node); node.parentNode = this; return node; }
    replaceChildren(...nodes) { this._text = ''; this.childNodes = []; nodes.forEach(node => this.appendChild(node)); }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(key, fn) { this.listeners[key] = fn; }
    querySelector(tag) { return walk(this).find(node => node.tagName === tag); }
    querySelectorAll(selector) { return walk(this).filter(node => selector.split(', ').includes(node.tagName)); }
    async click() { if (!this.disabled) { this.listeners.click?.({ target: this }); for (let i = 0; i < 20; i++) await Promise.resolve(); } }
}
const walk = node => [node, ...node.childNodes.flatMap(walk)];
const nodes = body => body.flatMap(walk);
const button = (body, text) => nodes(body).find(node => node.tagName === 'button' && node.textContent === text);

test('review panel requires explicit edited confirmation, full safe content and resumes selection', async () => {
    const previousDocument = globalThis.document;
    const previousTimeout = globalThis.setTimeout;
    globalThis.document = { createElement: tag => new ReviewNode(tag), createTextNode: text => { const node = new ReviewNode('#text'); node.textContent = text; return node; } };
    globalThis.setTimeout = () => 0;
    try {
        const candidates = Array.from({ length: 125 }, (_, index) => ({ uid: index, comment: `entry ${index}`, content: `<script>unsafe()</script>${'完整原文'.repeat(100)}TAIL${index}` }));
        const review = { ok: true, needsConfirmation: true, candidates, selectedIndices: [0, 124], reviewId: 'draft', coverage: { complete: true, entries: 125 } };
        let pending = null;
        let confirmed = 0;
        let callback;
        let release;
        const app = {
            settings: defaultSettings(), ctx: {}, persistSettings() {}, log() {}, channelStatus: () => ({ ready: true }),
            getHookPoolReview: () => pending,
            buildHookPool: async ({ force, onProgress }) => {
                assert.equal(force, true);
                onProgress({ stage: 'reading', totalCalls: 2, completedCalls: 1, currentCall: 2, status: 'calling' });
                pending = review; return review;
            },
            confirmHookPoolSelection: async (indices, { reviewId, onProgress }) => {
                confirmed++; assert.deepEqual(indices, [124]); assert.equal(reviewId, 'draft'); callback = onProgress;
                await new Promise(resolve => { release = resolve; }); pending = null;
                return { ok: true, hooks: [{ label: 'pool' }] };
            },
        };
        app.settings.worldbook.bookNames = ['book'];
        let lore = buildConfigSections(app).find(section => section.id === 'lore').body;
        await button(lore, '🔎 让 AI 通读世界书').click();
        assert.equal(confirmed, 0);
        assert.equal(nodes(lore).filter(node => node.tagName === 'details').length, 125);
        assert.ok(nodes(lore).some(node => node.textContent === candidates[124].content && !node.innerHTML));
        const boxes = nodes(lore).filter(node => node.tagName === 'input' && node.attrs.type === 'checkbox');
        assert.equal(boxes[0].checked, true); assert.equal(boxes[124].checked, true); assert.equal(boxes[1].checked, false);
        boxes[0].checked = false; boxes[0].listeners.change({ target: boxes[0] });
        lore = buildConfigSections(app).find(section => section.id === 'lore').body;
        const resumed = nodes(lore).filter(node => node.tagName === 'input' && node.attrs.type === 'checkbox');
        assert.equal(resumed[0].checked, false);
        const confirmation = button(lore, '确认选择并开始提取').click();
        assert.equal(button(lore, '🔎 让 AI 通读世界书').disabled, true);
        lore = buildConfigSections(app).find(section => section.id === 'lore').body;
        callback({ stage: 'extracting', totalCalls: 3, completedCalls: 1, currentCall: 2, status: 'calling' });
        assert.ok(nodes(lore).some(node => node.tagName === 'progress' && node.attrs.value === '1'));
        assert.ok(nodes(lore).some(node => node.textContent.includes('当前调用 2/3')));
        release(); await confirmation;
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert.equal(confirmed, 1);
        assert.equal(button(lore, '🔎 让 AI 通读世界书').disabled, false);
        assert.ok(nodes(lore).some(node => node.textContent.includes('已完成提取并建立线索池')));
    } finally { globalThis.document = previousDocument; globalThis.setTimeout = previousTimeout; }
});
