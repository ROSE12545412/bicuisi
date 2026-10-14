/**
 * 辅助 LLM 客户端里那几个纯函数的测试。
 *
 * 为什么这些用例值得存在：
 *  - `describeError` 是排障链路的**最后一环**。它一退化，用户看到的就只有「未知错误」，
 *    真实原因（401、模型名写错、群聊不支持、额度用完）被彻底掩盖 —— 而这几种恰好
 *    是被问得最多的。所以非标准异常、空 message、循环引用这几个「会掩盖真实原因」的坑
 *    必须逐个钉住。
 *  - `toText` 存在的唯一理由就是别把 `undefined` 变成字符串 `"undefined"`。
 *    这个坑一踩，`if (apiUrl)` 就会成立，「没配置」被误判成「配置了一个叫 undefined 的地址」。
 *  - `extractContent` 要同时兼容四条通道的四种返回形状。漏掉一种的表现是
 *    「模型明明返回了内容，插件却说返回为空」，而用户完全无从判断是哪一端的问题。
 *  - `buildChatEndpoint` 决定直连通道能不能用：用户填地址有三种常见写法，都得能用。
 *  - `isAbortError` 决定「用户主动中止」会不会被报成一条吓人的红色错误。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import {
    buildChatEndpoint,
    buildModelsEndpoint,
    describeError,
    extractContent,
    extractModelIds,
    isAbortError,
    LlmClient,
    toText,
} from '../src/llm/client.js';

describe('buildModelsEndpoint / extractModelIds —— 拉取模型列表', () => {
    test('模型列表挂在 base 那一层，不是挂在 /chat/completions 下面', () => {
        // 这一条容易错：`/v1/chat/completions/models` 是不存在的，
        // 正确端点是 `/v1/models`。所以要先把地址归一到 base 再拼。
        const cases = [
            ['https://api.x.com/v1', 'https://api.x.com/v1/models'],
            ['https://api.x.com/v1/', 'https://api.x.com/v1/models'],
            ['https://api.x.com/v1/chat/completions', 'https://api.x.com/v1/models'],
            ['https://api.x.com/v1/models', 'https://api.x.com/v1/models'],
            ['https://api.x.com', 'https://api.x.com/models'],
        ];
        for (const [input, want] of cases) {
            assert.equal(buildModelsEndpoint(input), want, `输入 ${input}`);
        }
    });

    test('空地址返回空串（调用方据此提示「还没填地址」）', () => {
        assert.equal(buildModelsEndpoint(''), '');
        assert.equal(buildModelsEndpoint('   '), '');
        assert.equal(buildModelsEndpoint(undefined), '');
    });

    test('OpenAI 风格 { data: [{ id }] }', () => {
        const ids = extractModelIds({
            object: 'list',
            data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
        });
        assert.deepEqual(ids, ['gpt-4o', 'gpt-4o-mini']);
    });

    test('Ollama 风格 { models: [{ name, model }] }', () => {
        const ids = extractModelIds({
            models: [
                { name: 'llama3:latest', model: 'llama3:latest' },
                { name: 'qwen2.5:7b', model: 'qwen2.5:7b' },
            ],
        });
        assert.deepEqual(ids, ['llama3:latest', 'qwen2.5:7b']);
    });

    test('直接给数组（元素是字符串或对象）', () => {
        assert.deepEqual(extractModelIds(['b', 'a']), ['a', 'b']);
        assert.deepEqual(extractModelIds([{ id: 'z' }, { name: 'y' }]), ['y', 'z']);
    });

    test('去重 + 排序（长列表里好找）', () => {
        const ids = extractModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] });
        assert.deepEqual(ids, ['a', 'b']);
    });

    test('认不出来的结构返回空数组，而不是崩', () => {
        for (const bad of [null, undefined, {}, { foo: 1 }, 'string', 42, { data: 'not-array' }]) {
            assert.deepEqual(extractModelIds(bad), [], `输入 ${JSON.stringify(bad)}`);
        }
    });

    test('列表里有脏项时跳过它，不产生 "undefined" 这样的模型名', () => {
        const ids = extractModelIds({ data: [{ id: 'ok' }, {}, null, { id: '' }] });
        assert.deepEqual(ids, ['ok'], `实际：${JSON.stringify(ids)}`);
    });
});

describe('describeError —— 不能把真实原因掩盖掉', () => {
    test('标准 Error 取 message', () => {
        assert.equal(describeError(new Error('读取世界书失败')), '读取世界书失败');
    });

    test('字符串 / 数字 / 布尔直接可用', () => {
        assert.equal(describeError('  出错了  '), '出错了');
        assert.equal(describeError(404), '404');
        assert.equal(describeError(false), 'false');
    });

    test('null / undefined → 空串（兜底文案由上层决定）', () => {
        assert.equal(describeError(null), '');
        assert.equal(describeError(undefined), '');
    });

    test('非标准 Error 对象：常见错误字段按顺序兜底', () => {
        assert.equal(describeError({ error: '额度用完' }), '额度用完');
        assert.equal(describeError({ error_description: 'invalid_grant' }), 'invalid_grant');
        assert.equal(describeError({ description: '描述' }), '描述');
        assert.equal(describeError({ reason: '原因' }), '原因');
        assert.equal(describeError({ detail: '细节' }), '细节');
        assert.equal(describeError({ msg: '消息' }), '消息');
    });

    test('嵌套的错误对象会被递归取出来（fetch 风格 { error: { message } }）', () => {
        assert.equal(describeError({ error: { message: '内层原因' } }), '内层原因');
        assert.equal(describeError({ detail: { reason: '很深的层' } }), '很深的层');
        assert.equal(describeError({ status: 429, error: { message: 'rate limit exceeded' } }), 'rate limit exceeded');
    });

    test('没有 message 也没有已知字段 → 退回 JSON，而不是「未知错误」', () => {
        assert.equal(describeError({ status: 401, code: 'unauthorized' }), '{"status":401,"code":"unauthorized"}');
    });

    test('空 message 的 Error → 用类型名兜底，不是空串', () => {
        const out = describeError(new Error(''));
        assert.ok(out, '必须给出可读文案');
        assert.match(out, /Error/);
    });

    test('message 是纯空白时也走兜底', () => {
        assert.match(describeError({ name: 'CustomError', message: '   ' }), /CustomError/);
    });

    test('循环引用对象不崩（JSON.stringify 会抛，必须被吃掉）', () => {
        const cyclic = { name: 'CyclicError' };
        cyclic.self = cyclic;
        const out = describeError(cyclic);
        assert.ok(out, '必须给出可读文案');
        assert.match(out, /CyclicError|字段|未知/);
    });

    test('完全空的对象 → 「未知异常」，不是空串', () => {
        assert.match(describeError({}), /未知异常/);
    });

    test('超长 JSON 被截断（不把整个 HTML 错误页塞进日志）', () => {
        const out = describeError({ blob: 'x'.repeat(2000) });
        assert.ok(out.length <= 400, `实际 ${out.length}`);
    });
});

describe('toText —— undefined 绝不能变成 "undefined"', () => {
    test('undefined / null → 空串', () => {
        assert.equal(toText(undefined), '');
        assert.equal(toText(null), '');
    });

    test('字符串去首尾空白', () => {
        assert.equal(toText('  abc  '), 'abc');
        assert.equal(toText('   '), '');
    });

    test('数字 / 布尔被字符串化', () => {
        assert.equal(toText(0), '0');
        assert.equal(toText(42), '42');
        assert.equal(toText(false), 'false');
    });

    test('包装对象：text / content / value / message 里取第一个非空字符串', () => {
        assert.equal(toText({ text: '甲' }), '甲');
        assert.equal(toText({ content: '乙' }), '乙');
        assert.equal(toText({ value: '丙' }), '丙');
        assert.equal(toText({ message: '丁' }), '丁');
        assert.equal(toText({ text: '  ', content: '丙' }), '丙', '空文本要跳过继续找');
        assert.equal(toText({ text: 42, content: '丁' }), '丁', '非字符串要跳过');
    });

    test('取不出文本的对象 / 数组 → 空串', () => {
        assert.equal(toText({}), '');
        assert.equal(toText([1, 2]), '');
        assert.equal(toText({ text: null }), '');
    });

    test('关键性质：没配置的字段不会变成 "undefined"', () => {
        const config = { url: undefined, key: null, model: undefined };
        for (const value of Object.values(config)) assert.equal(toText(value), '');
        assert.equal(Boolean(toText(config.url)), false, 'if (apiUrl) 必须是 false');
    });
});

describe('extractContent —— 四条通道的四种返回形状', () => {
    test('字符串原样返回', () => {
        assert.equal(extractContent('{"a":1}'), '{"a":1}');
    });

    test('① 酒馆助手：{ content }', () => {
        assert.equal(extractContent({ content: '甲' }), '甲');
        assert.equal(extractContent({ content: '', choices: [{ message: { content: '乙' } }] }), '乙', '空的 content 要继续往下找');
    });

    test('② 连接配置：{ result: { choices: [...] } }', () => {
        assert.equal(extractContent({ result: { choices: [{ message: { content: '甲' } }] } }), '甲');
    });

    test('③ 标准 OpenAI：choices[0].message.content 与 choices[0].text', () => {
        assert.equal(extractContent({ choices: [{ message: { content: '甲' } }] }), '甲');
        assert.equal(extractContent({ choices: [{ text: '乙' }] }), '乙');
    });

    test('④ 顶层 message（对象或字符串）', () => {
        assert.equal(extractContent({ message: { content: '甲' } }), '甲');
        assert.equal(extractContent({ message: '乙' }), '乙');
    });

    test('⑤ 工具调用：tool_calls[0].function.arguments', () => {
        assert.equal(extractContent({ tool_calls: [{ function: { arguments: '{"guidance":"甲"}' } }] }), '{"guidance":"甲"}');
    });

    test('⑥ 代理套了两层 data', () => {
        assert.equal(extractContent({ data: { choices: [{ message: { content: '甲' } }] } }), '甲');
    });

    test('优先级：顶层 content 高于 choices', () => {
        assert.equal(extractContent({ content: '甲', choices: [{ message: { content: '乙' } }] }), '甲');
    });

    test('认不出来 / 空值 → 空串，不崩', () => {
        for (const bad of [null, undefined, 42, {}, { foo: 'bar' }, { choices: [] }]) {
            assert.equal(extractContent(bad), '', `输入 ${JSON.stringify(bad)}`);
        }
    });
});

describe('buildChatEndpoint —— 直连地址规整', () => {
    test('裸域名 / 带 v1 前缀', () => {
        assert.equal(buildChatEndpoint('https://api.x.com'), 'https://api.x.com/chat/completions');
        assert.equal(buildChatEndpoint('https://api.x.com/v1'), 'https://api.x.com/v1/chat/completions');
    });

    test('结尾多几个斜杠', () => {
        assert.equal(buildChatEndpoint('https://api.x.com/v1/'), 'https://api.x.com/v1/chat/completions');
        assert.equal(buildChatEndpoint('https://api.x.com/v1///'), 'https://api.x.com/v1/chat/completions');
    });

    test('已经是 chat/completions 就原样返回（大小写不敏感）', () => {
        assert.equal(buildChatEndpoint('https://api.x.com/v1/chat/completions'), 'https://api.x.com/v1/chat/completions');
        assert.equal(buildChatEndpoint('https://api.x.com/v1/CHAT/COMPLETIONS'), 'https://api.x.com/v1/CHAT/COMPLETIONS');
    });

    test('误填 /models 也能救回来', () => {
        assert.equal(buildChatEndpoint('https://api.x.com/v1/models'), 'https://api.x.com/v1/chat/completions');
        assert.equal(buildChatEndpoint('https://api.x.com/v1/models/'), 'https://api.x.com/v1/chat/completions');
    });

    test('空值 / 全是空白 → 空串（上层据此报「没填地址」）', () => {
        for (const bad of ['', '   ', null, undefined]) {
            assert.equal(buildChatEndpoint(bad), '');
        }
    });

    test('包装对象里的地址也能用', () => {
        assert.equal(buildChatEndpoint({ text: 'https://api.x.com/v1' }), 'https://api.x.com/v1/chat/completions');
    });
});

describe('profile 通道中止 —— 绝不能无 signal 重试', () => {
    test('sendRequest 抛 AbortError 时只调用一次', async () => {
        let calls = 0;
        const ctx = {
            ConnectionManagerRequestService: {
                async sendRequest() {
                    calls++;
                    throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
                },
            },
        };
        const controller = new AbortController();
        const client = new LlmClient(ctx, { mode: 'profile', profileId: 'profile-1', timeoutMs: 3000 });

        const result = await client.complete({ user: 'test', signal: controller.signal });

        assert.equal(calls, 1, '中止后不能退回无 signal 的三参调用');
        assert.equal(result.ok, false);
        assert.equal(result.aborted, true);
    });

    test('sendRequest 成功返回但 signal 已中止时仍只调用一次并报告中止', async () => {
        let calls = 0;
        const controller = new AbortController();
        const ctx = {
            ConnectionManagerRequestService: {
                async sendRequest() {
                    calls++;
                    controller.abort();
                    return { result: { choices: [{ message: { content: '迟到的结果' } }] } };
                },
            },
        };
        const client = new LlmClient(ctx, { mode: 'profile', profileId: 'profile-1', timeoutMs: 3000 });

        const result = await client.complete({ user: 'test', signal: controller.signal });

        assert.equal(calls, 1);
        assert.equal(result.ok, false);
        assert.equal(result.aborted, true);
    });
});

describe('isAbortError —— 区分「用户中止」与「真失败」', () => {
    test('AbortError 名字', () => {
        assert.equal(isAbortError({ name: 'AbortError' }), true);
        assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
    });

    test('message 里出现 abort（AbortController 的标准文案）', () => {
        assert.equal(isAbortError(new Error('The operation was aborted.')), true);
        assert.equal(isAbortError(new Error('This operation was aborted')), true);
    });

    test('普通错误不是中止', () => {
        assert.equal(isAbortError(new Error('网络超时')), false);
        assert.equal(isAbortError({ name: 'TypeError', message: 'boom' }), false);
    });

    test('空值不是中止', () => {
        assert.equal(isAbortError(null), false);
        assert.equal(isAbortError(undefined), false);
        assert.equal(isAbortError(''), false);
    });

    test('字符串异常也能识别，中文文案不能误判', () => {
        assert.equal(isAbortError('AbortError: 请求被取消'), true);
        assert.equal(isAbortError('请求被取消'), false);
    });

    test('非 Error 对象（数字 / 布尔 / 空对象）不崩', () => {
        assert.equal(isAbortError(42), false);
        assert.equal(isAbortError(false), false);
        assert.equal(isAbortError({}), false);
    });
});
