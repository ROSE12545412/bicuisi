/**
 * 引导输出解析层（容错 JSON）的测试。
 *
 * 为什么这些用例值得存在：
 *  - 解析层是整个插件**唯一**直接面对「模型不听话」的地方。提示词里写死了「只输出 JSON」，
 *    但实测不同模型会返回：```json 围栏、前面一句「好的，以下是结果：」、后面一句
 *    「希望对你有帮助！」、单引号当键名、中文引号当定界符、尾随逗号，甚至整段纯文本。
 *  - 这里错了的表现**不是报错**，而是「贝翠丝说了一句莫名其妙的话」或者干脆不出声，
 *    用户在界面上完全看不出是解析失败 —— 所以每一种畸形输出都要有一条用例钉住。
 *  - `extractBalancedJson` 尤其危险：用贪婪正则 `/\{[\s\S]*\}/` 也能通过大部分用例，
 *    只有在「JSON 后面还跟了带大括号的说明文字」时才翻车。所以这里专门放了一条
 *    与贪婪正则对照的用例，把「为什么不能那么写」写进测试里。
 *  - `smartTrim` 的 maxChars 是硬约束（气泡宽度、注入预算都依赖它），
 *    所以除了「在标点处收尾」还要钉住「绝不越界」。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import { extractBalancedJson, normalizeEmotion, parseGuideResult, smartTrim } from '../src/llm/guide.js';
import { EMOTIONS, defaultSettings } from '../src/config.js';

/** 造一份只关心两个上限的设置。 */
function settingsWith({ guidanceMax = 60, commentaryMax = 40 } = {}) {
    const s = defaultSettings();
    s.guidance.maxChars = guidanceMax;
    s.commentary.maxChars = commentaryMax;
    return s;
}

/** 一份解析成功时结果必须齐全的结构。 */
const EMPTY_RESULT = { guidance: '', commentary: '', emotion: 'calm', hooks_used: [] };

describe('extractBalancedJson —— 只抠第一个平衡的 {…}', () => {
    test('正常 JSON 原样抠出', () => {
        const text = '{"guidance":"甲","commentary":"乙"}';
        assert.equal(extractBalancedJson(text), text);
    });

    test('前面有说明文字', () => {
        assert.equal(
            extractBalancedJson('好的，以下是结果：\n{"guidance":"甲"}'),
            '{"guidance":"甲"}',
        );
    });

    test('后面有说明文字：只取第一个平衡对象（贪婪正则会吃过头）', () => {
        const text = '{"guidance":"甲"} 以上就是我的回答，如果还要补充 {这些} 请告诉我';
        assert.equal(extractBalancedJson(text), '{"guidance":"甲"}');
        // 对照：贪婪正则会把后面的说明文字一起吞进来，导致 JSON.parse 失败
        assert.equal(
            text.match(/\{[\s\S]*\}/)[0],
            '{"guidance":"甲"} 以上就是我的回答，如果还要补充 {这些}',
        );
    });

    test('字符串值里的 { } 不能被当结构括号', () => {
        const text = '{"guidance":"记得把 {姓名} 换成真名","commentary":"模板味太重"}';
        assert.equal(extractBalancedJson(text), text);
    });

    test('中文引号包裹的值里的括号也不算结构', () => {
        const text = '{「guidance」：「把 {名字} 填进去」}';
        assert.equal(extractBalancedJson(text), text);
    });

    test('转义引号不会让扫描器提前退出字符串', () => {
        const text = '{"guidance":"他说\\"往东走\\"，然后就走了"}';
        assert.equal(extractBalancedJson(text), text);
    });

    test('嵌套对象只取外层平衡范围', () => {
        const text = '{"guidance":"甲","meta":{"a":{"b":1}},"commentary":"乙"}';
        assert.equal(extractBalancedJson(text), text);
    });

    test('找不到 { → 空串', () => {
        assert.equal(extractBalancedJson('完全没有大括号的一段话'), '');
        assert.equal(extractBalancedJson(''), '');
        assert.equal(extractBalancedJson(null), '');
        assert.equal(extractBalancedJson(undefined), '');
    });

    test('括号没闭合（模型被截断）→ 空串，而不是半截对象', () => {
        assert.equal(extractBalancedJson('{"guidance":"说到一半就被截'), '');
    });
});

describe('parseGuideResult —— 标准输入', () => {
    test('标准 JSON：四个字段都解析出来', () => {
        const text = JSON.stringify({
            guidance: '街角的风向变了，往东边走的人多了起来',
            commentary: '又是这种拐弯抹角的说法',
            emotion: 'smug',
            hooks_used: ['旧城区'],
        });
        const r = parseGuideResult(text, settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了，往东边走的人多了起来');
        assert.equal(r.result.commentary, '又是这种拐弯抹角的说法');
        assert.equal(r.result.emotion, 'smug');
        assert.deepEqual(r.result.hooks_used, ['旧城区']);
        assert.equal(r.salvage, undefined, '正常解析不该带兜底标记');
    });

    test('只有 guidance / 只有 commentary 都算成功', () => {
        const g = parseGuideResult('{"guidance":"往东边走"}', settingsWith());
        assert.equal(g.ok, true);
        assert.equal(g.result.commentary, '');

        const c = parseGuideResult('{"commentary":"又来了"}', settingsWith());
        assert.equal(c.ok, true);
        assert.equal(c.result.guidance, '');
        assert.equal(c.result.commentary, '又来了');
    });

    test('settings 缺失时用内置默认上限 60 / 40', () => {
        const r = parseGuideResult(JSON.stringify({ guidance: '一'.repeat(100) }), undefined);
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance.length, 60);
    });

    test('解析成功时结果结构始终齐全', () => {
        const r = parseGuideResult('{"guidance":"甲"}', settingsWith());
        assert.deepEqual(Object.keys(r.result).sort(), ['commentary', 'emotion', 'guidance', 'hooks_used']);
    });
});

describe('parseGuideResult —— 畸形输出的容错', () => {
    test('```json 围栏包裹', () => {
        const r = parseGuideResult('```json\n{"guidance":"街角的风向变了"}\n```', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了');
    });

    test('围栏语言名大小写不同、甚至没有语言名', () => {
        assert.equal(parseGuideResult('```JSON\n{"guidance":"甲"}\n```', settingsWith()).result.guidance, '甲');
        assert.equal(parseGuideResult('```\n{"guidance":"甲"}\n```', settingsWith()).result.guidance, '甲');
    });

    test('围栏 + 前后都有解释文字', () => {
        const text = '好的，我明白了。\n```json\n{"guidance":"街角的风向变了","commentary":"真啰嗦"}\n```\n希望有帮助！';
        const r = parseGuideResult(text, settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了');
        assert.equal(r.result.commentary, '真啰嗦');
    });

    test('前后有解释文字（没有围栏）', () => {
        const text = '好的，以下是结果：\n{"guidance":"街角的风向变了"}\n希望对你有帮助！';
        const r = parseGuideResult(text, settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了');
    });

    test('中文引号「」当定界符（键值之间仍是半角冒号）', () => {
        // lenientParse 会把 「」 换成 ASCII 双引号，所以这种混搭能救回来
        const r = parseGuideResult('{「guidance」:"街角的风向变了"}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了');
    });

    test('中文引号“”当定界符（键值之间仍是半角冒号）', () => {
        const r = parseGuideResult('{“guidance”:"街角的风向变了"}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了');
    });

    test('中文引号 + 全角冒号（中文模型最自然的写法）', () => {
        // 契约 §4 要求「中文引号当作定界符」要能容错，而模型一旦改用中文引号，
        // 冒号通常也会一起变成全角。这条用例**曾经是红的**：
        // 当时的 lenientParse 只换引号、不换全角冒号，JSON.parse 失败后
        // 整段原文被当成纯文本兜底成 guidance —— 气泡里会直接显示一串花括号。
        const r = parseGuideResult('{「guidance」：「街角的风向变了」}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了', `实际拿到了：${r.result.guidance}`);
        assert.equal(r.salvage, undefined, '不该走纯文本兜底');
    });

    test('全角逗号当字段分隔符', () => {
        // 同上，这条也曾经是红的：全角逗号没有被归一化 → JSON.parse 失败 →
        // 整段原文兜底成 guidance，commentary 直接丢掉。
        const r = parseGuideResult('{"guidance":"街角的风向变了"，"commentary":"真啰嗦"}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了', `实际拿到了：${r.result.guidance}`);
        assert.equal(r.result.commentary, '真啰嗦');
    });

    test('ASCII JSON 的字符串内容里出现中文引号时不能被改坏', () => {
        // 中文引号归一化是「先换引号再切平衡对象」，很容易误伤**字符串内部**的中文引号。
        // 这条用例钉住那个边界：正常的 JSON 必须原封不动地解析出来。
        const r = parseGuideResult('{"guidance":"他说「别回头」，然后就走了"}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '他说「别回头」，然后就走了');
    });

    test('需要抢救的 JSON 里，字符串内容中的全角标点不能被改成半角', () => {
        // 尾随逗号让第 ① 步直接 JSON.parse 失败，只能走第 ② 步的全角→半角替换。
        // 那一步本意是修「分隔符」，但它不认识「哪些全角标点其实在字符串里面」，
        // 于是把台词里的「，」也一起换成了半角 —— 用户看到的是被改过标点的原句。
        const r = parseGuideResult('{"guidance":"先去东边，再去西边",}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '先去东边，再去西边', `实际拿到了：${r.result.guidance}`);
    });

    test('单引号键名与值', () => {
        const r = parseGuideResult("{'guidance': '街角的风向变了', 'commentary': '真啰嗦'}", settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了');
        assert.equal(r.result.commentary, '真啰嗦');
    });

    test('尾随逗号', () => {
        const r = parseGuideResult('{"guidance":"街角的风向变了",\n"emotion":"smug",}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '街角的风向变了');
        assert.equal(r.result.emotion, 'smug');
    });

    test('字符串值里带 { } 也能正常解析', () => {
        const r = parseGuideResult('{"guidance":"记得把 {姓名} 换成真名"}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '记得把 {姓名} 换成真名');
    });

    test('转义引号能正确还原', () => {
        const r = parseGuideResult('{"guidance":"他说\\"往东走\\"，然后就走了"}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '他说"往东走"，然后就走了');
    });
});

describe('parseGuideResult —— 字段名变体', () => {
    test('guide / hint / 引导 / 暗示 都能当 guidance', () => {
        for (const key of ['guide', 'hint', '引导', '暗示']) {
            const r = parseGuideResult(JSON.stringify({ [key]: '钟楼那边好像有动静' }), settingsWith());
            assert.equal(r.ok, true, `字段名 ${key} 没被认出来`);
            assert.equal(r.result.guidance, '钟楼那边好像有动静');
        }
    });

    test('comment / quip / remark / 吐槽 / 评论 都能当 commentary', () => {
        for (const key of ['comment', 'quip', 'remark', '吐槽', '评论']) {
            const r = parseGuideResult(JSON.stringify({ [key]: '又是这一套' }), settingsWith());
            assert.equal(r.ok, true, `字段名 ${key} 没被认出来`);
            assert.equal(r.result.commentary, '又是这一套');
            assert.equal(r.result.guidance, '');
        }
    });

    test('主字段与别名同时出现时以主字段为准', () => {
        const r = parseGuideResult(JSON.stringify({ guidance: '正牌字段', guide: '别名' }), settingsWith());
        assert.equal(r.result.guidance, '正牌字段');
    });

    test('主字段是空串时继续找别名（不直接判失败）', () => {
        const r = parseGuideResult(JSON.stringify({ guidance: '', hint: '备用字段' }), settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '备用字段');
    });

    test('emotion 也能用 mood / feeling / 情绪 这些别名', () => {
        for (const key of ['mood', 'feeling', '情绪', '表情']) {
            const r = parseGuideResult(JSON.stringify({ guidance: '甲', [key]: 'smug' }), settingsWith());
            assert.equal(r.result.emotion, 'smug', `字段名 ${key} 没被认出来`);
        }
    });
});

describe('parseGuideResult —— 超长字段截断而非丢弃', () => {
    test('guidance 截到 guidance.maxChars 以内', () => {
        const r = parseGuideResult(JSON.stringify({ guidance: '一'.repeat(200) }), settingsWith({ guidanceMax: 20 }));
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance.length, 20, '没有标点就硬截');
    });

    test('commentary 截到 commentary.maxChars 以内', () => {
        const r = parseGuideResult(JSON.stringify({ commentary: '二'.repeat(200) }), settingsWith({ commentaryMax: 10 }));
        assert.equal(r.ok, true);
        assert.equal(r.result.commentary.length, 10);
    });

    test('有标点时在标点处收尾（并仍然不超上限）', () => {
        const text = '一'.repeat(30) + '。' + '二'.repeat(30);
        const r = parseGuideResult(JSON.stringify({ guidance: text }), settingsWith({ guidanceMax: 40 }));
        assert.equal(r.ok, true);
        assert.ok(r.result.guidance.length <= 40, `实际 ${r.result.guidance.length}`);
        assert.ok(r.result.guidance.endsWith('。'), `实际结尾：${r.result.guidance.slice(-3)}`);
    });

    test('截断后的字符串仍是非空字符串（不是 null / undefined）', () => {
        const r = parseGuideResult(JSON.stringify({ guidance: '一'.repeat(200) }), settingsWith({ guidanceMax: 10 }));
        assert.equal(typeof r.result.guidance, 'string');
        assert.ok(r.result.guidance.length > 0);
    });
});

describe('parseGuideResult —— emotion 归一化', () => {
    test('合法枚举直通', () => {
        for (const emotion of EMOTIONS) {
            const r = parseGuideResult(JSON.stringify({ guidance: '甲', emotion }), settingsWith());
            assert.equal(r.result.emotion, emotion);
        }
    });

    test('大小写不敏感、顺手去空白', () => {
        assert.equal(normalizeEmotion('SMUG'), 'smug');
        assert.equal(normalizeEmotion(' Calm '), 'calm');
        assert.equal(normalizeEmotion('Thinking'), 'thinking');
    });

    test('中文与近义词映射到合法枚举', () => {
        const map = {
            平静: 'calm',
            冷静: 'calm',
            得意: 'smug',
            傲娇: 'smug',
            不屑: 'smug',
            生气: 'annoyed',
            恼火: 'annoyed',
            烦躁: 'annoyed',
            担心: 'worried',
            忧虑: 'worried',
            紧张: 'worried',
            微笑: 'smile',
            开心: 'smile',
            高兴: 'smile',
            思考: 'thinking',
            沉思: 'thinking',
            疑惑: 'thinking',
            happy: 'smile',
            angry: 'annoyed',
            sad: 'worried',
            neutral: 'calm',
        };
        for (const [input, expected] of Object.entries(map)) {
            assert.equal(normalizeEmotion(input), expected, `「${input}」映射错了`);
        }
    });

    test('未知值 → calm', () => {
        for (const bad of ['excited', '狂喜', '不知所措', 'ANNOYED!', 'none']) {
            assert.equal(normalizeEmotion(bad), 'calm', `「${bad}」应退回 calm`);
        }
    });

    test('非字符串输入不崩，一律 calm 或从包装对象里取文本', () => {
        for (const bad of [null, undefined, '', '   ', 42, true, [], {}]) {
            assert.equal(normalizeEmotion(bad), 'calm', `输入 ${JSON.stringify(bad)}`);
        }
        // toText 能从 { text } / { content } 这类包装里取出文本
        assert.equal(normalizeEmotion({ text: 'smug' }), 'smug');
        assert.equal(normalizeEmotion({ content: 'worried' }), 'worried');
    });

    test('任何输入都只会返回合法枚举（UI 靠它切表情，不能拿到野值）', () => {
        const inputs = [...EMOTIONS, '得意', '生气', '???', '', null, 0, {}, []];
        for (const input of inputs) {
            assert.ok(EMOTIONS.includes(normalizeEmotion(input)), `输入 ${JSON.stringify(input)} 返回了野值`);
        }
    });

    test('JSON 里的非法 emotion 也会在解析时退回 calm', () => {
        const r = parseGuideResult('{"guidance":"甲","emotion":"极其兴奋"}', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.emotion, 'calm');
    });
});

describe('parseGuideResult —— hooks_used', () => {
    test('数组 / 单个字符串 / 缺失都能处理', () => {
        const s = settingsWith();
        assert.deepEqual(
            parseGuideResult(JSON.stringify({ guidance: '甲', hooks_used: ['钟声', '下水道'] }), s).result.hooks_used,
            ['钟声', '下水道'],
        );
        assert.deepEqual(
            parseGuideResult(JSON.stringify({ guidance: '甲', hooks_used: '钟声' }), s).result.hooks_used,
            ['钟声'],
        );
        assert.deepEqual(parseGuideResult(JSON.stringify({ guidance: '甲' }), s).result.hooks_used, []);
    });

    test('最多留 12 条（调试字段不该把提示词撑爆）', () => {
        const many = Array.from({ length: 30 }, (_, i) => `钩子${i}`);
        const r = parseGuideResult(JSON.stringify({ guidance: '甲', hooks_used: many }), settingsWith());
        assert.equal(r.result.hooks_used.length, 12);
        assert.equal(r.result.hooks_used[0], '钩子0');
    });

    test('非字符串项被丢弃，不会出现 [object Object]', () => {
        const r = parseGuideResult(
            JSON.stringify({ guidance: '甲', hooks_used: ['钟声', { 复杂: '对象' }, 42, ''] }),
            settingsWith(),
        );
        assert.deepEqual(r.result.hooks_used, ['钟声', '42']);
    });
});

describe('parseGuideResult —— 空内容与纯文本兜底', () => {
    test('空字符串 / 纯空白 / null / undefined → ok:false，不崩', () => {
        for (const bad of ['', '   ', '\n\n\t', null, undefined]) {
            const r = parseGuideResult(bad, settingsWith());
            assert.equal(r.ok, false, `输入 ${JSON.stringify(bad)} 应判失败`);
            assert.deepEqual(r.result, EMPTY_RESULT);
            assert.ok(r.error, '必须带可读的 error');
        }
    });

    test('有 JSON 但 guidance 与 commentary 都是空 → ok:false', () => {
        const r = parseGuideResult('{"guidance":"","commentary":""}', settingsWith());
        assert.equal(r.ok, false);
        assert.deepEqual(r.result, EMPTY_RESULT);
        assert.match(r.error, /都是空的/);
    });

    test('字段全是空白字符也算空', () => {
        const r = parseGuideResult('{"guidance":"   ","commentary":"\\n"}', settingsWith());
        assert.equal(r.ok, false);
    });

    test('只有 emotion、没有内容 → ok:false', () => {
        const r = parseGuideResult('{"emotion":"smug","hooks_used":["钟声"]}', settingsWith());
        assert.equal(r.ok, false);
    });

    test('纯文本（没有 JSON）→ 兜底成 guidance，ok:true 且带 salvage', () => {
        const text = '我总觉得今晚的钟声多敲了一下，你不觉得吗';
        const r = parseGuideResult(text, settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, text);
        assert.equal(r.result.commentary, '');
        assert.equal(r.result.emotion, 'calm');
        assert.deepEqual(r.result.hooks_used, []);
        assert.match(r.salvage, /纯文本/);
    });

    test('围栏里的纯文本同样能兜底', () => {
        const r = parseGuideResult('```text\n我总觉得今晚的钟声多敲了一下\n```', settingsWith());
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '我总觉得今晚的钟声多敲了一下');
        assert.ok(r.salvage);
    });

    test('超长纯文本（模型写了一整段旁白）→ ok:false，不硬塞进气泡', () => {
        const long = '这是一个很长很长的旁白。'.repeat(30);
        const r = parseGuideResult(long, settingsWith());
        assert.equal(r.ok, false);
        assert.equal(r.result.guidance, '');
        assert.match(r.error, /纯文本/);
    });

    test('纯文本兜底的边界：正好 maxChars*3 还能救，多一个字就放弃', () => {
        const s = settingsWith({ guidanceMax: 10 }); // 阈值 = 30 字
        assert.equal(parseGuideResult('啊'.repeat(30), s).ok, true);
        assert.equal(parseGuideResult('啊'.repeat(31), s).ok, false);
    });

    test('兜底出来的 guidance 也要受 maxChars 约束', () => {
        const s = settingsWith({ guidanceMax: 10 });
        const r = parseGuideResult('啊'.repeat(29), s);
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance.length, 10);
    });

    test('⭐ 括号不闭合的残缺 JSON → 判为「被截断」，而不是把残句当引导', () => {
        // ── 这条断言改过一次，值得说明
        //
        // 原来的契约是「完全解析失败 → 把纯文本当 guidance 兜底（若长度合理）」，
        // 所以这里断言 ok === true、内容是那半句 JSON。
        //
        // 用户实测之后发现那个契约是错的：「这是碧翠丝的气泡发言被截断了」——
        // 他看到的就是这个兜底把半截内容贴了出来。
        //
        // 现在区分两种情况：
        //   格式写坏了   → 可以抢救（lenientParse 那一套）
        //   **输出被截断** → 抢救没有意义（内容本身不完整），报可操作的错
        //
        // 宁可这一轮不出声，也不要给用户看半句话。
        const r = parseGuideResult('{"guidance":"说到一半就被截断了', settingsWith());
        assert.equal(r.ok, false, '截断的输出不该被当成可用结果');
        assert.equal(r.truncated, true, '要标记成 truncated');
        assert.match(r.error, /token/, '错误信息要指向解决办法');
        assert.equal(r.result.guidance, '', '绝不能把残句当引导');
    });

    test('纯自然语言（不是 JSON）仍然走兜底 —— 那不算截断', () => {
        // 区分：模型压根没写 JSON（写了一句人话）→ 兜底仍然可用
        const s = settingsWith();
        const r = parseGuideResult('哼，收摊收得有点早啊。', s);
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, '哼，收摊收得有点早啊。');
    });
});

describe('smartTrim —— 在标点处收尾，但绝不越界', () => {
    test('短文本原样返回（只做首尾去空白）', () => {
        assert.equal(smartTrim('很短的一句话', 60), '很短的一句话');
        assert.equal(smartTrim('  两头有空白  ', 60), '两头有空白');
        assert.equal(smartTrim('正好六个字啊', 6), '正好六个字啊');
    });

    test('标点在范围内时在标点处收尾', () => {
        assert.equal(smartTrim('一二三四五。七八九十', 6), '一二三四五。');
        assert.equal(smartTrim('abcdef，ghijklmn', 8), 'abcdef，');
    });

    test('标点太靠前（不足上限的 60%）时宁可硬截，不在那里收尾', () => {
        // 句号在第 3 个字，采纳它只能留下 6 字预算的一半，读起来像被腰斩
        assert.equal(smartTrim('你好。世界很大很大', 6), '你好。世界很');
    });

    test('找不到标点时硬截', () => {
        assert.equal(smartTrim('abcdefghij', 4), 'abcd');
        assert.equal(smartTrim('一二三四五六七八九十', 5), '一二三四五');
    });

    test('标点在 limit 之外不会被采纳（上限优先于「收尾好看」）', () => {
        // 直觉上会以为结果是「……。」，但句号在下标 10，limit 是 6；
        // 采纳它就等于突破 maxChars，而 maxChars 是气泡宽度与注入预算的硬约束。
        assert.equal(smartTrim('一二三四五六七八九十。', 6), '一二三四五六');
    });

    test('任何合法上限下长度都不超过上限', () => {
        const text = '甲'.repeat(50) + '。' + '乙'.repeat(50);
        for (const limit of [5, 10, 20, 33, 51, 60, 100]) {
            const out = smartTrim(text, limit);
            assert.ok(out.length <= limit, `limit=${limit} 时长度 ${out.length}`);
        }
    });

    test('非法上限（0 / 负数 / NaN / 空 / 非数字）→ 原样返回，不误截', () => {
        for (const bad of [0, -1, NaN, undefined, null, 'abc', '']) {
            assert.equal(smartTrim('一二三四五六', bad), '一二三四五六', `上限 ${String(bad)}`);
        }
    });

    test('字符串数字上限能识别', () => {
        assert.equal(smartTrim('abcdefghij', '4'), 'abcd');
    });

    test('null / undefined 文本 → 空串', () => {
        assert.equal(smartTrim(null, 10), '');
        assert.equal(smartTrim(undefined, 10), '');
    });
});
