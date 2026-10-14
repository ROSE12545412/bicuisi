/**
 * 模型下拉框选项规划的测试。
 *
 * ── 为什么值得单独测
 *
 * 这个逻辑很短，但踩过两次坑，而且两次都是**用户先发现的**：
 *
 *  1. 第一版「拉取模型」只是把模型名填进一个手打输入框，下拉框还停在占位文字上 ——
 *     用户的原话是「拉取模型做的不对，应该有下拉框让我选择模型」。
 *  2. 改成下拉框之后，如果用户手填过一个不在列表里的模型名（或换了端点），
 *     重画时那一项会被无声丢掉，下拉框显示的和实际生效的对不上。
 *
 * 这些都是**纯数据变换**问题，用 DOM 测反而绕远，所以抽成纯函数在这测。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';

import { CUSTOM_MODEL, planModelOptions } from '../src/ui/panel.js';

describe('planModelOptions —— 模型下拉框该有哪些项、选中哪个', () => {
    test('还没拉取过：只有提示项 + 自定义出口', () => {
        const plan = planModelOptions([], '');
        assert.equal(plan.values.length, 2);
        assert.match(plan.labels[0], /拉取模型/, '第一项应该是提示用户去拉取');
        assert.equal(plan.values[1], CUSTOM_MODEL, '必须留一个手填出口');
        assert.equal(plan.selected, '');
    });

    test('还没拉取过，但已经有模型名：那一项要显示出当前值', () => {
        const plan = planModelOptions([], 'deepseek-chat');
        assert.equal(plan.values[0], 'deepseek-chat');
        assert.equal(plan.labels[0], 'deepseek-chat');
        assert.equal(plan.selected, 'deepseek-chat');
    });

    test('拉到列表且当前模型在列表里：列出全部，选中当前那个', () => {
        const models = ['claude-sonnet-4', 'deepseek-chat', 'gpt-4o-mini'];
        const plan = planModelOptions(models, 'deepseek-chat');

        // 三个模型 + 一个自定义出口
        assert.deepEqual(plan.values, [...models, CUSTOM_MODEL]);
        assert.deepEqual(plan.labels.slice(0, 3), models);
        assert.equal(plan.selected, 'deepseek-chat');
    });

    test('⚠️ 当前模型不在列表里：必须补一项显示它，不能被无声丢掉', () => {
        // 这是真实场景：用户先手填了一个模型名，之后又点了「拉取模型」，
        // 而那个名字恰好不在返回的列表里。如果把当前值一丢，
        // 下拉框会显示别的模型，但实际生效的还是原来那个 —— 两边对不上。
        const plan = planModelOptions(['a-model', 'b-model'], 'my-private-deployment');
        assert.ok(
            plan.values.includes('my-private-deployment'),
            `当前模型被丢掉了：${JSON.stringify(plan.values)}`,
        );
        const idx = plan.values.indexOf('my-private-deployment');
        assert.match(plan.labels[idx], /当前/, '补的那一项要标明是「当前」');
        assert.equal(plan.selected, 'my-private-deployment', '仍然要选中它');
    });

    test('拉到列表但没有当前值：默认选中第一个', () => {
        const plan = planModelOptions(['first', 'second'], '');
        assert.equal(plan.selected, 'first');
    });

    test('永远有「（自定义…）」出口（端点不提供 /models 时靠它）', () => {
        for (const [models, cur] of [
            [[], ''],
            [[], 'x'],
            [['a'], ''],
            [['a', 'b'], 'a'],
            [['a', 'b'], 'zzz'],
        ]) {
            const plan = planModelOptions(models, cur);
            assert.ok(
                plan.values.includes(CUSTOM_MODEL),
                `列表 ${JSON.stringify(models)} / 当前 ${cur} 时缺少自定义出口`,
            );
        }
    });

    test('列表里的空项与重复项要清掉（脏数据不该进下拉框）', () => {
        const plan = planModelOptions(['a', '', 'b', 'a'], 'a');
        // 去重是上游 extractModelIds 的职责，但这里至少不能把空串当选项
        assert.ok(!plan.values.includes(''), '下拉框里不该有空字符串选项');
    });

    test('非数组输入不崩（设置被手改坏时）', () => {
        for (const bad of [null, undefined, 'string', 42, {}]) {
            const plan = planModelOptions(/** @type {any} */ (bad), 'x');
            assert.ok(Array.isArray(plan.values));
            assert.equal(plan.selected, 'x', '当前值仍然要保留');
        }
    });

    test('模型名里的特殊字符原样保留（有些中转带 / 和 : ）', () => {
        const weird = 'accounts/fireworks/models/llama-v3p1-70b';
        const plan = planModelOptions([weird, 'ollama:llama3'], 'ollama:llama3');
        assert.ok(plan.values.includes(weird));
        assert.equal(plan.selected, 'ollama:llama3');
    });
});
