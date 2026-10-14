import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { CODE_REVISION, defaultSettings, deepDefaults, normalizeSettings } from '../src/config.js';
import { buildConfigSections, createSettingsWindow } from '../src/ui/panel.js';

class Node {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.style = {}; this.dataset = {}; this.attrs = {}; this.listeners = {}; this._text = ''; }
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get textContent() { return this._text + this.childNodes.map(n => n.textContent).join(''); }
    appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
    replaceChildren(...nodes) { this._text = ''; this.childNodes = []; nodes.forEach(n => this.appendChild(n)); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(k, fn) { this.listeners[k] = fn; }
    querySelector() { return null; }
}
const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)];
const findButton = (node, label) => walk(node).find(n => n.tagName === 'button' && n.textContent === label);
const checks = node => walk(node).filter(n => n.tagName === 'input' && n.attrs.type === 'checkbox');
async function click(node) {
    await node.listeners.click?.({ target: node, preventDefault() {} });
    // button() does not return an async handler's promise; settle its awaited calls.
    for (let i = 0; i < 6; i++) await Promise.resolve();
}
async function domTest(fn) {
    const oldDocument = globalThis.document;
    const oldTimeout = globalThis.setTimeout;
    const oldConfirm = globalThis.confirm;
    globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => { const n = new Node('#text'); n.textContent = text; return n; } };
    globalThis.setTimeout = () => 0;
    try { await fn(); } finally { globalThis.document = oldDocument; globalThis.setTimeout = oldTimeout; globalThis.confirm = oldConfirm; }
}
function makeApp() {
    const settings = defaultSettings();
    settings.realm = 'void';
    const events = [];
    let reads = 0;
    let clears = 0;
    return {
        settings, ctx: {}, events,
        persistSettings() { events.push('persist'); },
        syncAdversaryDirector() { events.push('sync'); },
        log() {}, channelStatus: () => ({ ready: true }),
        adversaryDirectorStatus: () => ({ supported: false, reason: 'unsupported-host-test' }),
        adversaryState() { reads++; return { plots: [{ secret: 'HIDDEN-PLAN-TEST' }], audit: ['SECRET-AUDIT-TEST'] }; },
        clearAdversary() { clears++; },
        get reads() { return reads; }, get clears() { return clears; },
    };
}

test('adversary defaults off and normalization rejects unsafe booleans', () => {
    assert.equal(CODE_REVISION, 'r2026-10-12.33');
    assert.deepEqual(defaultSettings().adversary, { enabled: false, allowDeath: false, maxPlots: 3 });
    const s = defaultSettings();
    s.adversary = { enabled: 'true', allowDeath: 1, maxPlots: 99 };
    normalizeSettings(deepDefaults(s, defaultSettings()));
    assert.deepEqual(s.adversary, { enabled: false, allowDeath: false, maxPlots: 3 });
    s.adversary.maxPlots = -2;
    normalizeSettings(s);
    assert.equal(s.adversary.maxPlots, 1);
    s.adversary = null;
    normalizeSettings(s);
    assert.deepEqual(s.adversary, defaultSettings().adversary);
});

test('void-only adversary UI explicitly opts into fictional death and syncs after saving', async () => domTest(async () => {
    const app = makeApp();
    const untouchedPersona = JSON.stringify(app.settings.voidPersona);
    const untouchedApi = JSON.stringify(app.settings.llm);
    const body = buildConfigSections(app).find(s => s.id === 'adversary').body[0];
    assert.ok(body.textContent.includes('虚构剧情中的致死结局（角色死亡）'));
    assert.ok(body.textContent.includes('最多一次实质推进'));
    assert.ok(body.textContent.includes('不刻意预警'));
    assert.ok(body.textContent.includes('禁止临时补设定和口头翻案'));
    assert.ok(body.textContent.includes('unsupported-host-test'));
    assert.ok(body.textContent.includes('开启前必须先导入「人神对抗规则」世界书'));
    assert.ok(body.textContent.includes('不等于挂载给正文模型'));
    const [enabled, death] = checks(body);
    assert.equal(enabled.checked, false);
    assert.equal(death.checked, false);
    enabled.checked = true;
    await enabled.listeners.change();
    assert.deepEqual(app.events, ['persist', 'sync']);
    assert.equal(app.settings.adversary.enabled, true);
    assert.equal(app.settings.adversary.allowDeath, false);
    death.checked = true;
    await death.listeners.change();
    assert.equal(app.settings.adversary.allowDeath, true);
    assert.equal(JSON.stringify(app.settings.voidPersona), untouchedPersona);
    assert.equal(JSON.stringify(app.settings.llm), untouchedApi);
    app.settings.realm = 'beatrice';
    assert.ok(!buildConfigSections(app).some(s => s.id === 'adversary'));
}));

test('recap secrets require explicit per-window spoiler choice; clear needs confirmation', async () => domTest(async () => {
    globalThis.confirm = undefined;
    const app = makeApp();
    const win = createSettingsWindow({ app });
    win.open('adversary');
    assert.equal(app.reads, 0);
    assert.ok(!win.node.textContent.includes('HIDDEN-PLAN-TEST'));
    await click(findButton(win.node, '刷新复盘'));
    assert.equal(app.reads, 0);
    const spoiler = checks(win.node).at(-1);
    spoiler.checked = true;
    await spoiler.listeners.change();
    assert.ok(win.node.textContent.includes('HIDDEN-PLAN-TEST'));
    assert.ok(win.node.textContent.includes('SECRET-AUDIT-TEST'));
    assert.equal(app.clears, 0);
    const clear = findButton(win.node, '清空当前聊天的对抗记录');
    await click(clear);
    assert.equal(app.clears, 0);
    await click(clear);
    assert.equal(app.clears, 1);
    assert.ok(app.events.includes('sync'));
    win.close();
    assert.ok(!win.node.textContent.includes('HIDDEN-PLAN-TEST'));
    win.open('adversary');
    assert.equal(checks(win.node).at(-1).checked, false);
    assert.ok(!win.node.textContent.includes('SECRET-AUDIT-TEST'));
    globalThis.confirm = () => false;
    await click(findButton(win.node, '清空当前聊天的对抗记录'));
    assert.equal(app.clears, 1);
    globalThis.confirm = () => true;
    await click(findButton(win.node, '清空当前聊天的对抗记录'));
    assert.equal(app.clears, 2);
}));

test('return to Beatrice promptly removes adversary director prompt', async () => domTest(async () => {
    const app = makeApp();
    app.settings.adversary.enabled = true;
    const win = createSettingsWindow({ app });
    win.open('adversary');
    await click(findButton(win.node, '返回碧翠丝的禁书库'));
    assert.equal(app.settings.realm, 'beatrice');
    assert.deepEqual(app.events, ['persist', 'sync']);
    assert.equal(app.settings.adversary.enabled, true, 'realm switch preserves optional preference');
}));
