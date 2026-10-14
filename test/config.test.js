/**
 * 配置层的测试：默认值、深补全、归一化、输入框解析、扩展目录推导。
 *
 * 为什么这些用例值得存在：
 *  - `defaultSettings()` 是所有模块的输入。一旦它返回共享引用，任何一个调用方
 *    （比如悬浮窗拖拽改坐标）都会污染其他调用方，表现为「我没动设置，设置自己变了」，
 *    而且这种 bug 只在特定操作顺序下出现，极难复现 —— 所以引用独立性必须逐层断言。
 *  - `deepDefaults` 决定两件事：老用户升级后新字段能不能生效、手改坏的配置会不会让插件崩。
 *    它同时承担「前向兼容」职责：新版本写进配置的多余字段，绝不能被老版本读一次就抹掉。
 *  - `normalizeSettings` 是设置面板允许自由输入后的最后一道闸。越界值必须夹回、
 *    非法枚举必须退回默认，否则会出现「面板显示每 2 轮、实际永不触发」这种查半天的怪象。
 *  - `deriveExtensionFolder` 决定内置立绘的相对路径。用户把扩展文件夹改名（很常见）就会踩到，
 *    踩到时的表现是「头像空白」，控制台却什么都没有。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import {
    CADENCE_MODES,
    EMOTIONS,
    EXT_ID,
    LLM_MODES,
    clampInt,
    clampNum,
    cleanStringList,
    deepDefaults,
    defaultSettings,
    deriveExtensionFolder,
    formatListInput,
    normalizeSettings,
    parseListInput,
} from '../src/config.js';

/** 造一份默认设置 → 应用改动 → 归一化。测归一化时统一走这个入口。 */
function normalized(mutate) {
    const s = defaultSettings();
    mutate(s);
    return normalizeSettings(s);
}

/** 模拟 store.getSettings 的前半步：把残缺配置补全。 */
function filled(patch) {
    return deepDefaults(patch, defaultSettings());
}

describe('defaultSettings —— 每次都是全新对象', () => {
    test('两次调用不是同一个对象', () => {
        assert.notEqual(defaultSettings(), defaultSettings());
    });

    test('嵌套对象 / 数组字段都不共享引用', () => {
        const a = defaultSettings();
        const b = defaultSettings();
        assert.notEqual(a.cadence, b.cadence);
        assert.notEqual(a.worldbook, b.worldbook);
        assert.notEqual(a.ui.avatarPos, b.ui.avatarPos);
        assert.notEqual(a.worldbook.tags, b.worldbook.tags);
    });

    test('改一份（含深层）不会影响另一份', () => {
        const a = defaultSettings();
        const b = defaultSettings();
        a.cadence.everyN = 99;
        a.worldbook.tags.push('被污染的标签');
        a.ui.avatarPos.x = -1;
        a.persona.name = '改过的名字';

        assert.equal(b.cadence.everyN, 2);
        assert.equal(b.worldbook.tags.includes('被污染的标签'), false);
        assert.equal(b.ui.avatarPos.x, 24);
        assert.equal(b.persona.name, '贝翠丝');
    });

    test('关键默认值与 CONTRACTS §1 一致', () => {
        const s = defaultSettings();
        assert.equal(s.schemaVersion, 1);
        assert.equal(s.enabled, true);
        assert.equal(s.cadence.mode, 'every-n');
        assert.equal(s.cadence.everyN, 2);
        assert.equal(s.cadence.probability, 0.5);
        assert.equal(s.cadence.cooldownMs, 20000);
        // ⚠️ 这里断言的是**空数组**，这是刻意的设计变更。
        //
        // 原来默认是 ['引导','钩子','剧情',...] —— 也就是「只读标了这些标签的条目」。
        // 用户指出这个前提不成立：
        //   「没有写卡作者会为了我们的插件来特地制定剧情条目。」
        // 所以现在默认空 = 不按标签过滤，读全部条目交给 AI 判断。
        assert.deepEqual(s.worldbook.tags, [], '默认不按标签过滤（由 AI 判断全部条目）');
        assert.deepEqual(s.worldbook.excludeTags, ['禁止引导', '剧透', '勿引导']);
        assert.deepEqual(s.worldbook.bookNames, [], '空数组 = 自动发现世界书');
        assert.equal(s.worldbook.includeConstantEntries, true);
        assert.equal(s.guidance.maxChars, 60);
        assert.equal(s.guidance.hintOnly, true);
        // 40 太紧：吐槽常常需要「先铺垫再抖包袱」两句，40 字会在逗号处被硬截，
        // 用户实测看到过气泡里只有半句话。放宽到 70。
        assert.equal(s.commentary.maxChars, 70);
        assert.equal(s.llm.mode, 'profile');
        assert.deepEqual(s.llm.custom, { url: '', key: '', model: '', modelList: [] });
        assert.equal(s.llm.temperature, 1.0);
        // 400 不够装下「引导 + 吐槽」两个字段的 JSON —— 用户实测被截断过
        //（气泡里只有半句话）。默认提到 800。
        assert.equal(s.llm.maxTokens, 800);
        assert.equal(s.llm.timeoutMs, 45000);
        assert.equal(s.injection.mode, 'append');
        assert.equal(s.injection.speakerName, '贝翠丝');
        assert.equal(s.injection.maxChars, 600);
        assert.deepEqual(s.ui.avatarPos, { x: 24, y: 220 });
        assert.equal(s.ui.bubbleSide, 'auto');
        assert.equal(s.persona.name, '贝翠丝');
        // 人设提示词默认是空数组 = 用内置分段（不是「用户配了一个空人设」）
        assert.deepEqual(s.persona.prompts, [], '默认应该是空数组，表示「用内置」');
    });
});

describe('deepDefaults —— 缺字段补齐 / 类型纠正 / 前向兼容', () => {
    test('缺字段补默认值，并就地写回同一个对象', () => {
        const target = {};
        const out = deepDefaults(target, defaultSettings());
        assert.equal(out, target, '必须返回补全后的同一个引用');
        assert.equal(out.cadence.everyN, 2);
        assert.equal(out.guidance.maxChars, 60);
        assert.equal(out.ui.avatarPos.y, 220);
    });

    test('已有值被保留，同级缺失字段仍会补上', () => {
        const out = filled({ cadence: { everyN: 7 }, injection: { speakerName: '小碧' } });
        assert.equal(out.cadence.everyN, 7);
        assert.equal(out.injection.speakerName, '小碧');
        assert.equal(out.cadence.mode, 'every-n');
        assert.equal(out.injection.maxChars, 600);
    });

    test('多余字段必须保留（前向兼容）', () => {
        const out = filled({ futureFlag: { a: 1 }, cadence: { everyN: 3, futureNested: true } });
        assert.deepEqual(out.futureFlag, { a: 1 });
        assert.equal(out.cadence.futureNested, true);
    });

    test('嵌套对象递归补全（逐字段补，不是整块覆盖）', () => {
        const out = filled({ ui: { avatarPos: { x: 500 } } });
        assert.equal(out.ui.avatarPos.x, 500);
        assert.equal(out.ui.avatarPos.y, 220, '嵌套对象里缺的字段也要补');
        assert.equal(out.ui.avatarSize, 96);
    });

    test('数字字段收到非数字字符串 → 退回默认值', () => {
        const out = filled({ guidance: { maxChars: '很多字' }, cadence: { everyN: '好多轮' } });
        assert.equal(out.guidance.maxChars, 60);
        assert.equal(out.cadence.everyN, 2);
    });

    test('数字字段收到数字型字符串 → 转成数字（注意与 config.js:180 的注释描述不一致）', () => {
        // 注释写的是「类型不符 → 用默认值覆盖（例如字符串 "2"）」，
        // 实际实现委托给 coerce()，会 Number("2") → 2 而不是退回默认值 60。
        // 这里断言的是**实际行为**；两者对最终生效值没有影响，因为 normalizeSettings 还会夹一次区间。
        const out = filled({ guidance: { maxChars: '2' }, cadence: { everyN: '5' } });
        assert.equal(out.guidance.maxChars, 2);
        assert.equal(out.cadence.everyN, 5);
        assert.equal(typeof out.guidance.maxChars, 'number');
    });

    test('布尔字段收到非布尔值 → 退回默认值', () => {
        const out = filled({ enabled: 'false', guidance: { enabled: 0 } });
        assert.equal(out.enabled, true, '字符串 "false" 不会被当成 false');
        assert.equal(out.guidance.enabled, true);
    });

    test('字符串字段收到非字符串 → 退回默认值', () => {
        const out = filled({ persona: { name: 123, overridePrompt: { 整段: '人设' } } });
        assert.equal(out.persona.name, '贝翠丝', '不是变成 "123"，而是退回默认名字');
        assert.equal(out.persona.overridePrompt, '');
    });

    test('数组字段收到非数组 → 用默认值的副本（不与模板共享）', () => {
        const tpl = defaultSettings();
        const out = deepDefaults({ worldbook: { tags: '引导,钩子' } }, tpl);
        assert.deepEqual(out.worldbook.tags, tpl.worldbook.tags);
        assert.notEqual(out.worldbook.tags, tpl.worldbook.tags);
        out.worldbook.tags.push('污染模板');
        assert.ok(!tpl.worldbook.tags.includes('污染模板'));
    });

    test('字段是 null 视为缺失', () => {
        const out = filled({ injection: { speakerName: null }, cadence: { everyN: null } });
        assert.equal(out.injection.speakerName, '贝翠丝');
        assert.equal(out.cadence.everyN, 2);
    });

    test('target 是 null / undefined → 返回模板的深拷贝', () => {
        const tpl = defaultSettings();
        for (const bad of [null, undefined]) {
            const out = deepDefaults(bad, tpl);
            assert.equal(out.cadence.everyN, 2);
            assert.notEqual(out, tpl);
            assert.notEqual(out.worldbook.tags, tpl.worldbook.tags);
        }
    });

    test('target 是非对象（字符串 / 数字 / 数组 / 布尔）→ 不崩，返回模板深拷贝', () => {
        for (const bad of ['配置坏了', 42, [], true]) {
            const out = deepDefaults(bad, defaultSettings());
            assert.equal(out.guidance.maxChars, 60, `输入 ${JSON.stringify(bad)} 时没有退回模板`);
        }
    });

    test('模板不是普通对象时原样返回 target（内部工具的兜底分支）', () => {
        assert.equal(deepDefaults('用户填的', '默认'), '用户填的');
        assert.equal(deepDefaults(undefined, '默认'), '默认');
    });
});

describe('normalizeSettings —— 越界夹回、非法枚举退回默认', () => {
    test('cadence.everyN 夹到 1~20', () => {
        assert.equal(normalized((s) => { s.cadence.everyN = 0; }).cadence.everyN, 1);
        assert.equal(normalized((s) => { s.cadence.everyN = 999; }).cadence.everyN, 20);
        assert.equal(normalized((s) => { s.cadence.everyN = 3; }).cadence.everyN, 3);
    });

    test('cadence.probability 夹到 0~1', () => {
        assert.equal(normalized((s) => { s.cadence.probability = -0.5; }).cadence.probability, 0);
        assert.equal(normalized((s) => { s.cadence.probability = 1.5; }).cadence.probability, 1);
        assert.equal(normalized((s) => { s.cadence.probability = 0.25; }).cadence.probability, 0.25);
    });

    test('guidance.maxChars 夹到 10~400（0 不会变成「不限长度」）', () => {
        assert.equal(normalized((s) => { s.guidance.maxChars = 0; }).guidance.maxChars, 10);
        assert.equal(normalized((s) => { s.guidance.maxChars = 9999; }).guidance.maxChars, 400);
    });

    test('commentary.maxChars / maxHooks / maxHookChars / injection.maxChars 的区间', () => {
        assert.equal(normalized((s) => { s.commentary.maxChars = 1; }).commentary.maxChars, 5);
        assert.equal(normalized((s) => { s.worldbook.maxHooks = 0; }).worldbook.maxHooks, 1);
        assert.equal(normalized((s) => { s.worldbook.maxHooks = 1e6; }).worldbook.maxHooks, 200);
        assert.equal(normalized((s) => { s.worldbook.maxHookChars = 1; }).worldbook.maxHookChars, 40);
        assert.equal(normalized((s) => { s.injection.maxChars = 1; }).injection.maxChars, 60);
        assert.equal(normalized((s) => { s.injection.maxChars = 1e9; }).injection.maxChars, 8000);
    });

    test('llm 与 ui 的数值区间', () => {
        assert.equal(normalized((s) => { s.llm.temperature = 5; }).llm.temperature, 2);
        assert.equal(normalized((s) => { s.llm.temperature = -1; }).llm.temperature, 0);
        assert.equal(normalized((s) => { s.llm.maxTokens = 1; }).llm.maxTokens, 32);
        assert.equal(normalized((s) => { s.llm.timeoutMs = 1; }).llm.timeoutMs, 3000);
        assert.equal(normalized((s) => { s.ui.avatarSize = 1; }).ui.avatarSize, 48);
        assert.equal(normalized((s) => { s.ui.bubbleDurationMs = -5; }).ui.bubbleDurationMs, 0, '0 = 不自动消失，要允许');
        assert.equal(normalized((s) => { s.cadence.cooldownMs = -1; }).cadence.cooldownMs, 0);
    });

    test('NaN / Infinity 用兜底默认值（不是 min 也不是 max）', () => {
        assert.equal(normalized((s) => { s.cadence.everyN = NaN; }).cadence.everyN, 2);
        assert.equal(normalized((s) => { s.cadence.everyN = Infinity; }).cadence.everyN, 2);
        assert.equal(normalized((s) => { s.cadence.probability = NaN; }).cadence.probability, 0.5);
        assert.equal(normalized((s) => { s.llm.temperature = Infinity; }).llm.temperature, 1.0);
    });

    test('非法枚举退回默认', () => {
        assert.equal(normalized((s) => { s.llm.mode = 'gpt'; }).llm.mode, 'profile');
        assert.equal(normalized((s) => { s.llm.mode = 'PROFILE'; }).llm.mode, 'profile', '枚举大小写敏感，大写不算合法');
        assert.equal(normalized((s) => { s.cadence.mode = 'sometimes'; }).cadence.mode, 'every-n');
        assert.equal(normalized((s) => { s.ui.bubbleSide = 'top'; }).ui.bubbleSide, 'auto');
        assert.equal(normalized((s) => { s.injection.mode = 'inline'; }).injection.mode, 'append');
    });

    test('合法枚举原样保留', () => {
        for (const mode of LLM_MODES) {
            assert.equal(normalized((s) => { s.llm.mode = mode; }).llm.mode, mode);
        }
        for (const mode of CADENCE_MODES) {
            assert.equal(normalized((s) => { s.cadence.mode = mode; }).cadence.mode, mode);
        }
        for (const side of ['auto', 'left', 'right']) {
            assert.equal(normalized((s) => { s.ui.bubbleSide = side; }).ui.bubbleSide, side);
        }
        for (const mode of ['append', 'message', 'off']) {
            assert.equal(normalized((s) => { s.injection.mode = mode; }).injection.mode, mode);
        }
    });

    test('老配置迁移：`appended` 是 `message` 的旧名字，要自动改过来', () => {
        // v1.0.0 只有两态（'appended' / 'off'）。改成三态之后，
        // 已经存过设置的用户不该因为字段名变了就丢掉原来的选择：
        // 'appended' 的语义正是「作为一条独立小字消息」，所以映射到 'message'。
        assert.equal(
            normalized((s) => { s.injection.mode = 'appended'; }).injection.mode,
            'message',
            "'appended' 应该迁移到 'message'（语义相同），而不是被当成非法值退回默认",
        );
    });

    test('worldbook 的三个列表都被 cleanStringList 清洗', () => {
        const s = normalized((x) => {
            x.worldbook.tags = [' 引导 ', '引导', '', '   ', '钩子'];
            x.worldbook.excludeTags = ['剧透', '剧透', '  '];
            x.worldbook.bookNames = [' 我的书 ', '另一本'];
        });
        assert.deepEqual(s.worldbook.tags, ['引导', '钩子']);
        assert.deepEqual(s.worldbook.excludeTags, ['剧透']);
        assert.deepEqual(s.worldbook.bookNames, ['我的书', '另一本']);
    });

    test('tags 被清空成空数组时不崩，也不会偷偷塞回默认标签', () => {
        assert.deepEqual(normalized((s) => { s.worldbook.tags = []; }).worldbook.tags, []);
    });

    test('avatarPos 越界夹回，整块坏掉就重置成默认坐标', () => {
        assert.deepEqual(
            normalized((s) => { s.ui.avatarPos = { x: 99999, y: -99999 }; }).ui.avatarPos,
            { x: 12000, y: -2000 },
        );
        assert.deepEqual(
            normalized((s) => { s.ui.avatarPos = '左上角'; }).ui.avatarPos,
            { x: 24, y: 220 },
        );
        assert.deepEqual(
            normalized((s) => { s.ui.avatarPos = { x: 'abc' }; }).ui.avatarPos,
            { x: 24, y: 220 },
        );
    });

    test('就地归一化：返回的就是传入的那个对象', () => {
        const s = defaultSettings();
        s.cadence.everyN = 999;
        const out = normalizeSettings(s);
        assert.equal(out, s);
        assert.equal(s.cadence.everyN, 20);
    });

    test('归一化是幂等的', () => {
        const once = normalized((s) => {
            s.cadence.everyN = 999;
            s.llm.mode = 'x';
            s.worldbook.tags = [' 引导 ', '引导'];
        });
        assert.deepEqual(normalizeSettings(once), once);
    });
});

describe('clampInt / clampNum —— 脏输入', () => {
    test('clampInt：NaN / undefined / ±Infinity 都返回兜底值', () => {
        assert.equal(clampInt(NaN, 1, 20, 2), 2);
        assert.equal(clampInt(undefined, 1, 20, 2), 2);
        assert.equal(clampInt(Infinity, 1, 20, 2), 2);
        assert.equal(clampInt(-Infinity, 1, 20, 2), 2);
    });

    test('clampInt：字符串数字能识别，非数字字符串走兜底', () => {
        assert.equal(clampInt('7', 1, 20, 2), 7);
        assert.equal(clampInt('7.6', 1, 20, 2), 8, '先四舍五入再夹');
        assert.equal(clampInt('七', 1, 20, 2), 2);
    });

    test('clampInt：正常值原样通过、越界夹回', () => {
        assert.equal(clampInt(7, 1, 20, 2), 7);
        assert.equal(clampInt(0, 1, 20, 2), 1);
        assert.equal(clampInt(999, 1, 20, 2), 20);
    });

    test('clampInt：空串与 null 等价于 0（不是兜底值）—— 面板清空输入时的实际表现', () => {
        assert.equal(clampInt('', 0, 10, 99), 0);
        assert.equal(clampInt(null, 5, 20, 99), 5);
    });

    test('clampNum：不取整，其余判定同 clampInt', () => {
        assert.equal(clampNum(0.37, 0, 1, 0.5), 0.37);
        assert.equal(clampNum('0.25', 0, 1, 0.5), 0.25);
        assert.equal(clampNum(1.5, 0, 1, 0.5), 1);
        assert.equal(clampNum(-1, 0, 1, 0.5), 0);
        assert.equal(clampNum(NaN, 0, 1, 0.5), 0.5);
        assert.equal(clampNum(undefined, 0, 1, 0.5), 0.5);
        assert.equal(clampNum(Infinity, 0, 1, 0.5), 0.5);
    });
});

describe('cleanStringList —— 去空白 / 去重 / 去空项 / 限长', () => {
    test('去首尾空白、去重、去空项', () => {
        assert.deepEqual(cleanStringList([' 引导 ', '引导', '', '   ', '钩子']), ['引导', '钩子']);
    });

    test('非数组输入 → 空数组', () => {
        for (const bad of [null, undefined, '引导', 42, {}]) {
            assert.deepEqual(cleanStringList(bad), []);
        }
    });

    test('null / undefined 项被丢掉', () => {
        assert.deepEqual(cleanStringList([null, undefined, 'a']), ['a']);
    });

    test('限长时保留靠前的项', () => {
        assert.deepEqual(cleanStringList(['a', 'b', 'c', 'd'], 2), ['a', 'b']);
    });

    test('默认上限 64', () => {
        const many = Array.from({ length: 100 }, (_, i) => `t${i}`);
        assert.equal(cleanStringList(many).length, 64);
    });

    test('数字会被字符串化而不是丢掉（记录现状）', () => {
        assert.deepEqual(cleanStringList([1, 2]), ['1', '2']);
    });
});

describe('parseListInput / formatListInput —— 输入框一行文本 ↔ 数组', () => {
    test('半角逗号分隔', () => {
        assert.deepEqual(parseListInput('引导,钩子'), ['引导', '钩子']);
    });

    test('全角逗号 / 顿号 / 换行 / 制表符都是分隔符', () => {
        assert.deepEqual(parseListInput('引导，钩子'), ['引导', '钩子']);
        assert.deepEqual(parseListInput('引导、钩子'), ['引导', '钩子']);
        assert.deepEqual(parseListInput('引导\n钩子'), ['引导', '钩子']);
        assert.deepEqual(parseListInput('引导\r\n钩子\t线索'), ['引导', '钩子', '线索']);
    });

    test('空格不是分隔符（带空格的标签要完整保留）', () => {
        assert.deepEqual(parseListInput('引导 钩子'), ['引导 钩子']);
    });

    test('混合分隔符 + 多余空白 + 去重', () => {
        assert.deepEqual(parseListInput('  引导 ，， 钩子、\n 引导  '), ['引导', '钩子']);
    });

    test('空输入 → 空数组', () => {
        for (const empty of ['', '   ', '，、\n\t', null, undefined]) {
            assert.deepEqual(parseListInput(empty), []);
        }
    });

    test('formatListInput 是 parseListInput 的逆', () => {
        const list = ['引导', '钩子', '地点'];
        assert.equal(formatListInput(list), '引导，钩子，地点');
        assert.deepEqual(parseListInput(formatListInput(list)), list);

        const messy = parseListInput('a、b，c\n d');
        assert.deepEqual(parseListInput(formatListInput(messy)), messy);
    });

    test('formatListInput 非数组输入 → 空串', () => {
        for (const bad of [null, undefined, 'a,b', 42, {}]) {
            assert.equal(formatListInput(bad), '');
        }
        assert.equal(formatListInput([]), '');
    });
});

describe('deriveExtensionFolder —— 从 import.meta.url 推目录名', () => {
    test('常规安装路径', () => {
        assert.equal(deriveExtensionFolder('file:///data/extensions/beatrice-guide/index.js'), 'beatrice-guide');
    });

    test('从子模块的 URL 也能推出同一个目录', () => {
        assert.equal(deriveExtensionFolder('file:///data/extensions/beatrice-guide/src/llm/guide.js'), 'beatrice-guide');
    });

    test('装在 third-party/ 下', () => {
        assert.equal(deriveExtensionFolder('file:///data/extensions/third-party/beatrice-guide/index.js'), 'beatrice-guide');
        assert.equal(
            deriveExtensionFolder('file:///data/extensions/third-party/beatrice-guide/src/config.js'),
            'beatrice-guide',
        );
    });

    test('文件夹被改名（解压 zip 常见结果）', () => {
        assert.equal(deriveExtensionFolder('file:///data/extensions/beatrice-guide-main/index.js'), 'beatrice-guide-main');
        assert.equal(
            deriveExtensionFolder('file:///data/extensions/third-party/beatrice-guide-main/index.js'),
            'beatrice-guide-main',
        );
    });

    test('URL 带 query / hash', () => {
        assert.equal(deriveExtensionFolder('file:///data/extensions/beatrice-guide/index.js?v=1.2.3'), 'beatrice-guide');
        assert.equal(deriveExtensionFolder('file:///data/extensions/beatrice-guide/index.js#/chat'), 'beatrice-guide');
    });

    test('Windows 盘符路径（真实 import.meta.url 的形态）', () => {
        assert.equal(
            deriveExtensionFolder('file:///C:/Users/admin/Desktop/%E9%AA%B0%E5%AD%90/extensions/beatrice-guide/index.js'),
            'beatrice-guide',
        );
    });

    test('完全不匹配的 URL → 退回 EXT_ID', () => {
        assert.equal(deriveExtensionFolder('file:///data/other/beatrice-guide/index.js'), EXT_ID);
        assert.equal(deriveExtensionFolder('https://cdn.example.com/lib/mod.js'), EXT_ID);
        assert.equal(deriveExtensionFolder(''), EXT_ID);
    });

    test('非字符串输入 → 退回 EXT_ID，不崩', () => {
        for (const bad of [null, undefined, 42]) {
            assert.equal(deriveExtensionFolder(bad), EXT_ID);
        }
    });
});

describe('常量表', () => {
    test('EMOTIONS 冻结且内容与 CONTRACTS §4 一致', () => {
        assert.equal(Object.isFrozen(EMOTIONS), true);
        assert.deepEqual([...EMOTIONS], ['calm', 'smug', 'annoyed', 'worried', 'smile', 'thinking']);
    });

    test('LLM_MODES 冻结且四条通道都在', () => {
        assert.equal(Object.isFrozen(LLM_MODES), true);
        assert.deepEqual([...LLM_MODES], ['profile', 'tavern-helper', 'custom', 'main']);
    });

    test('CADENCE_MODES 冻结且三种节奏都在', () => {
        assert.equal(Object.isFrozen(CADENCE_MODES), true);
        assert.deepEqual([...CADENCE_MODES], ['every-n', 'probability', 'always']);
    });

    test('冻结是真的改不动（写操作抛错或被忽略，值保持不变）', () => {
        for (const table of [EMOTIONS, LLM_MODES, CADENCE_MODES]) {
            const before = [...table];
            try {
                /** @type {any} */ (table)[0] = 'hacked';
            } catch {
                /* 严格模式下会抛 TypeError，正是期望 */
            }
            assert.deepEqual([...table], before);
        }
    });
});
