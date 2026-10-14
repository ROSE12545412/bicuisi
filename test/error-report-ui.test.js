import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { buildErrorReport } from '../src/error-report.js';
import { buildConfigSections } from '../src/ui/panel.js';

// Match the existing panel UI mocks, with selection support for manual copying.
class Node {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.style = {}; this.dataset = {}; this.attrs = {}; this.listeners = {}; this._text = ''; }
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get textContent() { return this._text + this.childNodes.map(n => n.textContent).join(''); }
    set innerHTML(v) { throw new Error(`Unsafe HTML: ${v}`); }
    appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
    replaceChildren(...nodes) { this._text = ''; this.childNodes = []; nodes.forEach(n => this.appendChild(n)); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(k, fn) { this.listeners[k] = fn; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
    async click() { await this.listeners.click?.({ target: this, preventDefault() {} }); }
}
const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)];
const nodes = body => body.flatMap(walk);
const button = (body, label) => nodes(body).find(n => n.tagName === 'button' && n.textContent === label);
const reportInput = body => nodes(body).find(n => n.tagName === 'textarea' && n.attrs['aria-label'] === '错误报告（可选择并手动复制）');
const withoutTime = report => { const { createdAt, ...rest } = report; return rest; };

async function domTest(navigator, fn) {
    const previousDocument = globalThis.document;
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const previousTimeout = globalThis.setTimeout;
    globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => { const n = new Node('#text'); n.textContent = text; return n; } };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
    globalThis.setTimeout = () => 0; // Keep toast cleanup timers out of focused UI tests.
    try { await fn(); } finally {
        globalThis.document = previousDocument;
        if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
        else delete globalThis.navigator;
        globalThis.setTimeout = previousTimeout;
    }
}
function fixture() {
    const settings = defaultSettings();
    settings.llm.custom.key = 'PRIVATE-API-KEY';
    settings.persona.beatrice = 'PRIVATE-PERSONA';
    return { settings, ctx: {}, version: 'test', channelStatus: () => ({ ready: true }),
        state: () => ({ story: 'PRIVATE-STORY', plots: [{ objective: 'PRIVATE-PLOT' }] }) };
}
function diag(app) { return buildConfigSections(app).find(section => section.id === 'diag').body; }
function assertReport(body, app) {
    const input = reportInput(body);
    assert.ok(input, 'the complete report is inspectable in a selectable textarea');
    assert.equal(input.readOnly, true);
    assert.ok(Object.hasOwn(input.attrs, 'readonly'));
    const report = JSON.parse(input.value);
    assert.deepEqual(withoutTime(report), withoutTime(buildErrorReport(app)), 'UI does not prune useful request structure');
    for (const secret of ['PRIVATE-API-KEY', 'PRIVATE-PERSONA', 'PRIVATE-STORY', 'PRIVATE-PLOT']) assert.ok(!input.value.includes(secret), secret);
    return input;
}

test('diagnostic tab copies a dedicated JSON error report and keeps it inspectable', async () => {
    const copied = [];
    const clipboard = { async writeText(text) { assert.equal(this, clipboard); copied.push(text); } };
    await domTest({ clipboard }, async () => {
        const app = fixture();
        const body = diag(app);
        assert.ok(button(body, '📋 复制诊断信息'), 'old diagnosis is a separate control');
        assert.equal(reportInput(body), undefined, 'generation is explicit');
        await button(body, '📋 复制错误报告').click();
        const input = assertReport(body, app);
        assert.deepEqual(copied, [input.value]);
        assert.ok(nodes(body).some(n => n.textContent.includes('错误报告已复制到剪贴板')));
        app.settings.enabled = !app.settings.enabled;
        await button(body, '📋 复制错误报告').click();
        assertReport(body, app);
        assert.equal(copied.length, 2, 'each click builds a fresh report');
        assert.notEqual(copied[0], copied[1]);
    });
});

for (const [label, navigator] of [
    ['navigator missing', undefined],
    ['clipboard missing', {}],
    ['writeText missing', { clipboard: {} }],
    ['writeText not callable', { clipboard: { writeText: true } }],
    ['clipboard permission rejected', { clipboard: { async writeText() { throw new Error('Denied'); } } }],
]) test(`error report manual copy fallback: ${label}`, async () => domTest(navigator, async () => {
    const app = fixture();
    const body = diag(app);
    await button(body, '📋 复制错误报告').click();
    const input = assertReport(body, app);
    assert.equal(input.focused, true);
    assert.equal(input.selected, true);
    assert.ok(nodes(body).some(n => n.textContent.includes('全选并手动复制错误报告')));
    assert.ok(!nodes(body).some(n => n.textContent.includes('错误报告已复制到剪贴板')), 'missing clipboard must never claim success');
}));

test('story opt-in and old diagnosis preview cannot widen or replace the error report', async () => domTest({}, async () => {
    const app = fixture();
    const body = diag(app);
    const checkbox = nodes(body).find(n => n.tagName === 'input' && n.attrs.type === 'checkbox');
    checkbox.checked = true;
    await checkbox.listeners.change();
    assert.ok(nodes(body).some(n => n.textContent.includes('PRIVATE-STORY')), 'old explicit story preview remains available');
    await button(body, '📋 复制错误报告').click();
    const input = assertReport(body, app);
    await button(body, '预览公开报告').click();
    assert.equal(reportInput(body), input, 'old preview uses a separate output container');
    assertReport(body, app);
}));

test('error report generation errors do not expose raw exception text', async () => domTest({}, async () => {
    const app = fixture();
    const body = diag(app);
    Object.defineProperty(app, 'settings', { get() { throw new Error('PRIVATE-STORY PRIVATE-API-KEY'); } });
    await button(body, '📋 复制错误报告').click();
    assert.ok(nodes(body).some(n => n.textContent.includes('错误报告生成失败')));
    assert.ok(!nodes(body).some(n => n.textContent.includes('PRIVATE-STORY')));
    assert.equal(reportInput(body), undefined);
}));
