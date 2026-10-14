import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { buildConfigSections, createSettingsWindow } from '../src/ui/panel.js';

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
    querySelector() { return null; }
}
const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)];
const button = (node, label) => walk(node).find(n => n.tagName === 'button' && n.textContent === label);
const check = (node, label) => {
    const labelNode = walk(node).find(n => n.tagName === 'span' && n.textContent === label && n.attrs.id);
    return walk(node).find(n => n.tagName === 'input' && n.attrs['aria-labelledby'] === labelNode?.attrs.id);
};
async function click(node) {
    assert.ok(node, 'button exists');
    node.listeners.click?.({ target: node, preventDefault() {} });
    for (let i = 0; i < 10; i++) await Promise.resolve();
}
async function change(node, value) { assert.ok(node, 'checkbox exists'); node.checked = value; await node.listeners.change(); }
async function domTest(fn) {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => { const n = new Node('#text'); n.textContent = text; return n; } };
    try { await fn(); } finally { globalThis.document = oldDocument; }
}
function appFixture() {
    const settings = defaultSettings();
    const state = {
        reminders: [
            { id: 'r1', index: 2, realm: 'beatrice', guidance: '<img src=x onerror=alert(1)>', commentary: '安全提醒', sources: ['SOURCE-SECRET'], located: { secret: 'LOCATION-SECRET' }, bookmarked: false },
            { id: 'r2', index: 4, realm: 'void', guidance: '人神旧提醒', bookmarked: true },
        ],
        diary: [{ id: 'd1', actor: '旅人', action: '开门', result: '门已打开', evidence: 'DIARY-EVIDENCE' }],
    };
    const calls = { reads: 0, toggles: [], forget: [], clear: [], recap: 0, debug: 0 };
    const app = {
        settings, ctx: {}, persistSettings() {}, log() {}, channelStatus: () => ({ ready: true }),
        memoryState() { calls.reads++; return state; },
        toggleBookmark(id) { calls.toggles.push(id); const r = state.reminders.find(r => r.id === id); return r.bookmarked = !r.bookmarked; },
        forgetDiary(id) { calls.forget.push(id); state.diary = state.diary.filter(r => r.id !== id); return true; },
        clearMemories(kind) { calls.clear.push(kind); return true; },
        causalRecap({ spoilers }) { assert.equal(spoilers, true); calls.recap++; return { locked: false, plots: [
            { id: 'ended', stage: 'resolved', objective: '封锁通路', trace: '已落地伏笔', opportunity: '曾可反制', result: '最终解除', missing: ['没有因果记录'] },
            { id: 'active', stage: 'lurking', objective: 'ACTIVE-SECRET' },
        ] }; },
        adversaryState() { calls.debug++; return { plots: [{ secret: 'DEBUG-SECRET' }] }; },
    };
    return { app, calls, state };
}

test('memories tab is lazy in both realms; historical reminders use safe text and bookmark filter', async () => domTest(async () => {
    const { app, calls } = appFixture();
    for (const realm of ['beatrice', 'void']) {
        app.settings.realm = realm;
        const sections = buildConfigSections(app);
        assert.equal(calls.reads, realm === 'beatrice' ? 0 : 1);
        const tab = sections.find(s => s.id === 'memories');
        assert.equal(tab.title, '书签与日记'); assert.equal(tab.icon, '📚');
        const host = tab.body[0];
        assert.ok(host.textContent.includes('<img src=x onerror=alert(1)>'));
        assert.ok(!host.textContent.includes('SOURCE-SECRET'));
        assert.ok(!host.textContent.includes('DIARY-EVIDENCE'));
    }
    const win = createSettingsWindow({ app }); win.open('memories');
    await change(check(win.node, '只看已加书签的提醒'), true);
    assert.ok(!win.node.textContent.includes('<img src=x'));
    assert.ok(win.node.textContent.includes('人神旧提醒'));
    await click(button(win.node, '★ 取消书签'));
    assert.deepEqual(calls.toggles, ['r2']);
    assert.ok(!win.node.textContent.includes('人神旧提醒'), 'false bookmark result is success');
    win.close();
}));

test('sources need window consent plus item expansion; diary evidence is explicit and close resets reveal', async () => domTest(async () => {
    const { app } = appFixture();
    const win = createSettingsWindow({ app }); win.open('memories');
    assert.equal(button(win.node, '展开 / 收起此条原始来源'), undefined);
    await change(check(win.node, '显示提醒原始来源（可能剧透，仅本窗口）'), true);
    assert.ok(!win.node.textContent.includes('SOURCE-SECRET'));
    await click(button(win.node, '展开 / 收起此条原始来源'));
    assert.ok(win.node.textContent.includes('SOURCE-SECRET'));
    assert.ok(win.node.textContent.includes('LOCATION-SECRET'));
    await click(button(win.node, '展开 / 收起原始证据'));
    assert.ok(win.node.textContent.includes('DIARY-EVIDENCE'));
    win.close(); assert.ok(!win.node.textContent.includes('SOURCE-SECRET'));
    win.open('memories');
    assert.equal(check(win.node, '显示提醒原始来源（可能剧透，仅本窗口）').checked, false);
    assert.ok(!win.node.textContent.includes('DIARY-EVIDENCE'));
    win.close();
}));

test('forget and each clear require two explicit clicks; cancel and close disarm deletion', async () => domTest(async () => {
    const { app, calls } = appFixture();
    const win = createSettingsWindow({ app }); win.open('memories');
    const forget = '移除 / 忘记这条日记';
    await click(button(win.node, forget)); assert.deepEqual(calls.forget, []);
    await click(button(win.node, '取消删除'));
    await click(button(win.node, forget)); assert.deepEqual(calls.forget, []);
    win.close(); win.open('memories');
    await click(button(win.node, forget)); assert.deepEqual(calls.forget, []);
    await click(button(win.node, forget)); assert.deepEqual(calls.forget, ['d1']);
    for (const [kind, label] of [['bookmarks', '清空重要书签'], ['diary', '清空共同日记'], ['all', '清空全部提醒与日记']]) {
        const before = calls.clear.length;
        await click(button(win.node, label)); assert.equal(calls.clear.length, before);
        await click(button(win.node, label)); assert.equal(calls.clear.at(-1), kind);
    }
    win.close();
}));

test('ended causal recap is separately gated and filters active plots; debug retains separate consent', async () => domTest(async () => {
    const { app, calls } = appFixture(); app.settings.realm = 'void';
    const win = createSettingsWindow({ app }); win.open('adversary');
    assert.equal(calls.recap, 0); assert.equal(calls.debug, 0);
    await change(check(win.node, '查看已结束阴谋的因果复盘（剧透）'), true);
    assert.equal(calls.recap, 1); assert.equal(calls.debug, 0);
    for (const text of ['封锁通路', '已落地伏笔', '曾可反制', '最终解除', '没有因果记录']) assert.ok(win.node.textContent.includes(text));
    assert.ok(!win.node.textContent.includes('ACTIVE-SECRET'));
    assert.ok(!win.node.textContent.includes('DEBUG-SECRET'));
    await change(check(win.node, '显示隐藏阴谋与审计（剧透）'), true);
    assert.ok(win.node.textContent.includes('DEBUG-SECRET'));
    win.close(); win.open('adversary');
    assert.equal(check(win.node, '查看已结束阴谋的因果复盘（剧透）').checked, false);
    assert.equal(check(win.node, '显示隐藏阴谋与审计（剧透）').checked, false);
    win.close();
}));
