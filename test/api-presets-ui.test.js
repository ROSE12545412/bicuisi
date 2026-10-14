import { strict as assert } from 'node:assert';
import { test } from './_harness.js';
import { defaultSettings } from '../src/config.js';
import { API_STAGES } from '../src/api-presets.js';
import { buildConfigSections, redactDiagnostics } from '../src/ui/panel.js';

class Node {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.style = {}; this.dataset = {}; this.attrs = {}; this.listeners = {}; this._text = ''; }
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get textContent() { return this._text + this.childNodes.map(n => n.textContent).join(''); }
    appendChild(n) { this.childNodes.push(n); return n; }
    replaceChildren(...nodes) { this._text = ''; this.childNodes = []; nodes.forEach(n => this.appendChild(n)); }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(k, fn) { this.listeners[k] = fn; }
    fire(type, value) { if (value !== undefined) this.value = value; this.listeners[type]?.({ target: this, preventDefault() {} }); }
}
const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)];
function fixture(run) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => { const n = new Node('#text'); n.textContent = text; return n; } };
    try {
        const settings = defaultSettings();
        settings.llm.mode = 'custom';
        settings.llm.custom.key = 'private-key-123';
        settings.apiPresets = [];
        settings.apiRoutes = Object.fromEntries(API_STAGES.map(s => [s.id, '']));
        const view = {};
        let body, persists = 0, renders = 0, busy = false;
        const app = { settings, ctx: {}, persistSettings() { persists++; }, log() {}, isBusy: () => busy };
        const draw = () => { renders++; body = buildConfigSections(app, draw, view).find(s => s.id === 'llm').body; };
        draw();
        const nodes = () => body.flatMap(walk);
        const control = label => {
            const field = nodes().find(n => n.dataset.wide !== undefined && n.childNodes[0]?.textContent === label);
            assert.ok(field, label);
            return walk(field).find(n => ['input', 'select'].includes(n.tagName));
        };
        const click = label => { const node = nodes().find(n => n.tagName === 'button' && n.textContent === label); assert.ok(node, label); node.fire('click'); };
        run({ settings, draw, control, click, nodes, view, setBusy: v => { busy = v; }, get persists() { return persists; }, get renders() { return renders; } });
    } finally { globalThis.document = previous; }
}

test('API presets UI saves, explicitly loads/updates, and confirms destructive delete', () => fixture(f => {
    const startRenders = f.renders;
    f.control('预设名称').fire('input', '便宜模型');
    f.control('预设名称').fire('change');
    assert.equal(f.renders, startRenders, 'typing and blur must not rebuild the name input');
    assert.equal(f.persists, 0);
    f.click('保存为新预设');
    assert.equal(f.settings.apiPresets.length, 1);
    const id = f.settings.apiPresets[0].id;
    f.settings.llm.custom.model = 'changed';
    f.control('已保存的 API 预设').fire('change', id);
    assert.equal(f.settings.llm.custom.model, 'changed', 'selection is not loading');
    f.click('加载所选预设');
    assert.notEqual(f.settings.llm.custom.model, 'changed');
    f.settings.llm.custom.model = 'updated-model';
    f.control('预设名称').fire('input', '更新名字');
    f.click('用当前设置更新所选预设');
    assert.equal(f.settings.apiPresets[0].name, '更新名字');
    assert.equal(f.settings.apiPresets[0].llm.custom.model, 'updated-model');
    f.control(`${API_STAGES[0].label} API`).fire('change', id);
    f.click('删除所选预设');
    assert.equal(f.settings.apiPresets.length, 1);
    f.click('取消删除预设');
    f.click('删除所选预设');
    assert.equal(f.settings.apiPresets.length, 1);
    f.click('删除所选预设');
    assert.equal(f.settings.apiPresets.length, 0);
    assert.equal(f.settings.apiRoutes.facts, '');
    assert.equal(f.persists, 5);
}));

test('four API stages select independently and retain explicit invalid preset selections', () => fixture(f => {
    f.control('预设名称').fire('input', '路由模型');
    f.click('保存为新预设');
    const id = f.settings.apiPresets[0].id;
    for (const stage of API_STAGES) {
        f.control(`${stage.label} API`).fire('change', id);
        assert.equal(f.settings.apiRoutes[stage.id], id);
    }
    f.control(`${API_STAGES[1].label} API`).fire('change', '');
    assert.equal(f.settings.apiRoutes.locate, '');
    assert.equal(f.settings.apiRoutes.facts, id);
    f.settings.apiRoutes.assess = 'missing-preset';
    f.draw();
    const invalid = f.control(`${API_STAGES[2].label} API`);
    assert.equal(invalid.value, 'missing-preset');
    assert.ok(invalid.childNodes.some(n => n.attrs.value === 'missing-preset' && n.textContent.includes('不存在')));
    assert.equal(f.settings.apiRoutes.assess, 'missing-preset');
}));

test('busy preset actions and routing cannot mutate even if request begins after rendering', () => fixture(f => {
    f.control('预设名称').fire('input', '忙碌测试');
    f.click('保存为新预设');
    const id = f.settings.apiPresets[0].id;
    const before = JSON.stringify(f.settings);
    const persisted = f.persists;
    f.setBusy(true);
    f.click('加载所选预设');
    f.click('用当前设置更新所选预设');
    f.click('删除所选预设');
    f.click('保存为新预设');
    const route = f.control(`${API_STAGES[0].label} API`);
    route.fire('change', id);
    assert.equal(route.value, '');
    assert.equal(JSON.stringify(f.settings), before);
    assert.equal(f.persists, persisted);
    f.draw();
    assert.equal(f.control(`${API_STAGES[0].label} API`).disabled, true);
    assert.ok(f.nodes().some(n => n.textContent.includes('明文')));
    assert.ok(!JSON.stringify(redactDiagnostics(f.settings)).includes('private-key-123'));
}));
