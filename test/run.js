/**
 * 碧翠丝的禁书库 / test/run.js
 * ---------------------------------------------------------------------------
 * 自带的迷你测试运行器。
 *
 * 为什么不用 `node --test`：
 *  1. Node 内置 runner 会为**每个测试文件 spawn 一个子进程**并通过管道收集输出。
 *     在受限环境（沙箱、某些 CI 容器）里这个 spawn 会被直接拒绝
 *     （`spawn EPERM`），一个测试都跑不了。
 *  2. 本插件的测试大多是纯函数与假 ctx 的组装，**不需要**进程隔离。
 *     同进程注册、同进程跑，快得多，也不依赖任何子进程能力。
 *
 * API 刻意和 `node:test` 保持一致（test / describe / it + strict assert），
 * 这样将来想换回 `node --test` 不用改测试代码。
 *
 * 用法：
 *   node test/run.js              跑全部
 *   node test/run.js worldbook    只跑文件名含 worldbook 的
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 注册表（供 test/*.test.js import）
// ---------------------------------------------------------------------------

/** @type {Array<{name: string, fn: Function, suite: string[]}>} */
const registry = [];
/** @type {string[]} */
let suiteStack = [];

/**
 * 注册一个测试。
 * @param {string} name
 * @param {Function} fn
 */
export function test(name, fn) {
    registry.push({ name, fn, suite: [...suiteStack] });
}

/** test 的别名，便于用 it(...) 写。 */
export const it = test;

/**
 * 注册一组测试。
 * @param {string} name
 * @param {Function} fn
 */
export function describe(name, fn) {
    suiteStack.push(name);
    try {
        fn();
    } finally {
        suiteStack.pop();
    }
}

/** 只注册不执行（与 node:test 行为一致）。 */
export function skip(name, fn) {
    registry.push({ name, fn, suite: [...suiteStack], skip: true });
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/** 收集 test/ 下的所有 *.test.js。 */
async function findTestFiles() {
    const items = await readdir(HERE, { withFileTypes: true });
    return items
        .filter((i) => i.isFile() && i.name.endsWith('.test.js'))
        .map((i) => join(HERE, i.name))
        .sort();
}

/** 把断言错误里的堆栈裁到只剩测试文件那几行，输出更干净。 */
function cleanStack(/** @type {any} */ error) {
    const stack = String(error?.stack ?? '');
    const lines = stack.split('\n');
    // 第一行是错误信息，后面挑出我们自己的文件
    const mine = lines.slice(1).filter((l) => l.includes('碧翠丝') || l.includes('test') || l.includes('src'));
    return mine.slice(0, 4).join('\n');
}

async function main() {
    const filter = process.argv[2] ? String(process.argv[2]) : '';
    let files = await findTestFiles();
    if (filter) files = files.filter((f) => f.includes(filter));

    if (!files.length) {
        console.error(filter ? `没有匹配 "${filter}" 的测试文件` : '找不到任何 *.test.js');
        process.exit(1);
    }

    // 把注册表接到全局，测试文件 import 的就是这份
    /** @type {any} */ (globalThis).__bgTestRegistry = registry;

    console.log(`碧翠丝的禁书库 · 测试\n`);

    for (const file of files) {
        // 每个文件前清空套件栈（模块级 describe 会自己压栈）
        suiteStack = [];
        const before = registry.length;
        try {
            await import(pathToFileURL(file).href);
        } catch (e) {
            console.error(`✖ 加载测试文件失败：${file}`);
            console.error(`  ${e?.message ?? e}`);
            console.error(cleanStack(e));
            process.exit(1);
        }
        if (registry.length === before) {
            console.warn(`  ⚠️  ${file} 里没有注册任何测试`);
        }
    }

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    /** @type {string[]} */
    const failures = [];

    let currentSuite = null;
    for (const entry of registry) {
        const suiteName = entry.suite.join(' › ');
        if (suiteName !== currentSuite) {
            currentSuite = suiteName;
            if (suiteName) console.log(`\n${suiteName}`);
        }

        const label = `  ${entry.name}`;
        if (entry.skip) {
            skipped++;
            console.log(`${label} ⏭`);
            continue;
        }

        try {
            await entry.fn();
            passed++;
            console.log(`${label} ✅`);
        } catch (e) {
            failed++;
            const where = suiteName ? `${suiteName} › ${entry.name}` : entry.name;
            failures.push(`✖ ${where}\n  ${e?.message ?? e}\n${cleanStack(e)}`);
            console.log(`${label} ❌`);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    if (failures.length) {
        console.log(`\n失败详情：\n`);
        for (const f of failures) console.log(`${f}\n`);
    }
    const total = passed + failed + skipped;
    console.log(`共 ${total} 个测试：✅ ${passed} 通过　❌ ${failed} 失败　⏭ ${skipped} 跳过`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试运行器自身出错：', e);
  process.exit(1);
});
