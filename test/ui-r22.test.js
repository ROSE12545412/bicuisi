import assert from 'node:assert/strict';
import { test } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
import { buildConfigSections, createSettingsWindow, redactDiagnostics, buildDiagnostics } from '../src/ui/panel.js';

const walk = n => [n, ...(n.childNodes ?? []).flatMap(walk)];
class Node {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.style = {}; this.dataset = {}; this.attrs = {}; this.listeners = {}; this._text = ''; }
    set textContent(v) { this._text = String(v); this.replaceChildren(); }
    get textContent() { return this._text + this.childNodes.map(n => n.textContent).join(''); }
    appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
    replaceChildren(...ns) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; ns.forEach(n => this.appendChild(n)); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(k, fn) { this.listeners[k] = fn; }
    querySelectorAll() { return walk(this).slice(1).filter(n => ['button', 'input', 'select', 'textarea'].includes(n.tagName)); }
    querySelector() { return this.querySelectorAll()[0]; }
    focus() { document.activeElement = this; }
    click() { return this.listeners.click?.({ preventDefault() {} }); }
}
async function fixture(fn) {
    const oldDoc = globalThis.document, oldTimer = globalThis.setTimeout, oldFetch = LlmClient.fetchModels, oldComplete = LlmClient.prototype.complete;
    const timers = [];
    globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => { const n = new Node('#text'); n.textContent = text; return n; }, querySelector() { return null; } };
    globalThis.setTimeout = (f, ms) => { timers.push(ms); return timers.length; };
    const settings = defaultSettings(); settings.llm.mode = 'custom'; settings.llm.custom.url = 'https://one.example/v1'; settings.llm.custom.model = 'private';
    const app = { settings, ctx: {}, persistSettings() {}, log() {}, channelStatus: () => ({ ready: true }), state: () => ({ lastError: 'Bearer unknown-secret', story: 'PRIVATE STORY' }) };
    try { await fn(app, timers); } finally { globalThis.document = oldDoc; globalThis.setTimeout = oldTimer; LlmClient.fetchModels = oldFetch; LlmClient.prototype.complete = oldComplete; }
}
const button = (root, text) => walk(root).find(n => n.tagName === 'button' && n.textContent === text);
const llm = app => ({ childNodes: buildConfigSections(app).find(s => s.id === 'llm').body });

test('r22 password input persists without replacing focused control', () => fixture(async app => {
    let saves = 0; app.persistSettings = () => saves++;
    const win = createSettingsWindow({ app }); win.open('llm');
    const pass = walk(win.node).find(n => n.attrs.type === 'password'); pass.focus();
    pass.value = 'abc'; pass.listeners.input(); pass.value = 'abcdef'; pass.listeners.input();
    assert.equal(app.settings.llm.custom.key, 'abcdef'); assert.equal(saves, 2);
    assert.equal(document.activeElement, pass); assert.ok(walk(win.node).includes(pass));
    assert.ok(pass.attrs['aria-labelledby']);
}));

test('r22 model fetch preserves private deployment and ignores changed config, abort and disconnect', () => fixture(async app => {
    LlmClient.fetchModels = async () => ({ ok: true, models: ['public'] });
    await button(llm(app), '🔄 拉取模型').click(); assert.equal(app.settings.llm.custom.model, 'private');
    for (const key of ['url', 'key', 'model']) {
        let resolve; LlmClient.fetchModels = () => new Promise(r => resolve = r);
        const root = llm(app), pending = button(root, '🔄 拉取模型').click();
        app.settings.llm.custom[key] = 'changed-' + key;
        const before = JSON.stringify(app.settings); resolve({ ok: true, models: ['stale'] }); await pending;
        assert.equal(JSON.stringify(app.settings), before);
    }
    for (const reason of ['aborted', 'disconnected']) {
        let resolve; LlmClient.fetchModels = () => new Promise(r => resolve = r);
        const root = llm(app), pending = button(root, '🔄 拉取模型').click();
        if (reason === 'disconnected') walk(root).filter(n => n.className?.includes('preview')).forEach(n => n.isConnected = false);
        const before = JSON.stringify(app.settings); resolve({ ok: true, models: ['bad'], aborted: reason === 'aborted' }); await pending;
        assert.equal(JSON.stringify(app.settings), before);
    }
}));

test('r22 stale generation test cannot show response or speak', () => fixture(async app => {
    let resolve, spoken = 0; LlmClient.prototype.complete = () => new Promise(r => resolve = r); app.askNow = () => { throw Error('Connection test must not observe story'); }; app.ui = { say() { spoken++; } };
    const root = llm(app), pending = button(root, '🔌 测试连接').click();
    app.settings.llm.custom.key = 'new-key';
    resolve({ ok: true, text: 'STALE' }); await pending;
    assert.equal(spoken, 0); assert.ok(!walk(root).some(n => String(n.textContent ?? '').includes('STALE')));
}));

test('r22 generation abort, disconnect and window close ignore late results', () => fixture(async app => {
    for (const reason of ['aborted', 'disconnected', 'closed']) {
        let resolve, spoken = 0; LlmClient.prototype.complete = () => new Promise(r => resolve = r); app.askNow = () => { throw Error('Connection test must not observe story'); }; app.ui = { say() { spoken++; } };
        const win = createSettingsWindow({ app }); win.open();
        const pending = button(win.node, '🔌 测试连接').click();
        if (reason === 'disconnected') walk(win.node).filter(n => n.className?.includes('preview')).forEach(n => n.isConnected = false);
        if (reason === 'closed') win.close();
        resolve({ ok: true, aborted: reason === 'aborted', text: 'late' }); await pending;
        assert.equal(spoken, 0, reason);
    }
}));

test('connection probe bypasses busy adversary without story or bubble effects', () => fixture(async app => {
    app._adversaryInFlight = true; app.settings.realm = 'void';
    app.askNow = () => { throw Error('Must not advance story'); };
    app.ui = { say() { throw Error('Must not speak test as persona'); } };
    let calls = 0;
    LlmClient.prototype.complete = async req => {
        calls++; assert.ok(!JSON.stringify(req).includes('PRIVATE STORY'));
        assert.equal(req.jsonSchema, undefined);
        return { ok: true, text: '连接成功', meta: { mode: 'custom' } };
    };
    const root = llm(app); await button(root, '🔌 测试连接').click();
    assert.equal(calls, 1); assert.ok(root.childNodes.some(n => n.textContent.includes('连接正常')));
}));

test('r22 reports default to minimal preview and redact all known secret occurrences', () => fixture(async app => {
    app.settings.llm.custom.key = 'known-secret';
    app.settings.llm.custom.url = 'https://example/v1?api_key=url-secret';
    app.settings.future = { access_token: 'access-secret', client_secret: 'client-secret', 'x-api-key': 'alternate-secret' };
    const data = { ...app.settings, error: 'known-secret access-secret client-secret alternate-secret url-secret Bearer unknown-secret', logs: ['https://x/?auth_key=extra-secret'] };
    const text = JSON.stringify(redactDiagnostics(data));
    for (const secret of ['known-secret', 'access-secret', 'client-secret', 'alternate-secret', 'url-secret', 'unknown-secret', 'extra-secret']) assert.ok(!text.includes(secret), secret);
    const minimal = buildDiagnostics(app); assert.ok(!minimal.includes('PRIVATE STORY')); assert.ok(!minimal.includes('example')); assert.ok(!minimal.includes('lastError'));
    assert.ok(buildDiagnostics(app, { includeStory: true }).includes('PRIVATE STORY'));
    const diag = { childNodes: buildConfigSections(app).find(s => s.id === 'diag').body };
    button(diag, '预览公开报告').click(); assert.ok(walk(diag).some(n => n.tagName === 'pre'));
}));

test('r22 diagnostic and persona clipboard paths are sanitized', () => fixture(async app => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText(text) { copied.push(text); } } } });
    try {
        app.settings.llm.custom.key = 'clipboard-secret';
        app.settings.persona.overridePrompt = 'My secret clipboard-secret; https://x/?access_token=embedded-secret';
        const sections = buildConfigSections(app);
        await button({ childNodes: sections.find(s => s.id === 'persona').body }, '📋 复制人设文本').click();
        const diag = { childNodes: sections.find(s => s.id === 'diag').body };
        await button(diag, '📋 复制诊断信息').click();
        assert.equal(copied.length, 2);
        for (const text of copied) { assert.ok(!text.includes('clipboard-secret')); assert.ok(!text.includes('embedded-secret')); }
        assert.ok(walk(diag).some(n => n.tagName === 'pre'), 'copy also displays the exact report preview');
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
    }
}));

test('r22 inactive lore does not schedule loads; eight/nine tabs and dialog focus trap restore', () => fixture(async (app, timers) => {
    const launcher = new Node('button'); launcher.focus();
    const win = createSettingsWindow({ app }); win.open('llm');
    assert.equal(timers.filter(ms => ms === 0).length, 0);
    assert.equal(walk(win.node).filter(n => n.className?.endsWith('win-tab')).length, 8);
    const dialog = walk(win.node).find(n => n.attrs.role === 'dialog'); assert.equal(dialog.attrs['aria-modal'], 'true');
    const controls = dialog.querySelectorAll(); controls.at(-1).focus(); let prevented = false;
    win.node.listeners.keydown({ key: 'Tab', preventDefault() { prevented = true; } }); assert.ok(prevented); assert.equal(document.activeElement, controls[0]);
    win.close(); assert.equal(document.activeElement, launcher);
    const sections = buildConfigSections(app); assert.equal(timers.filter(ms => ms === 0).length, 0);
    sections.find(s => s.id === 'lore').body; assert.equal(timers.filter(ms => ms === 0).length, 1);
    sections.find(s => s.id === 'lore').body; assert.equal(timers.filter(ms => ms === 0).length, 1, 'lazy body memoizes one build');
    app.settings.realm = 'void'; win.open(); assert.equal(walk(win.node).filter(n => n.className?.endsWith('win-tab')).length, 9);
}));
