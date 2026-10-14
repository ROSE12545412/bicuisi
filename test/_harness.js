/**
 * 测试脚手架：让同一份测试文件既能在自带运行器（`node test/run.js`）下跑，
 * 也能在 Node 内置 runner（`node --test`）下跑。
 *
 * 为什么需要它：
 *  - `node --test` 会为每个文件 spawn 子进程，在受限环境（沙箱/容器）里
 *    直接 `spawn EPERM`，一个测试都跑不了 —— 所以自带运行器是主力。
 *  - 但有些 CI 或别人的机器上 `node --test` 用着更顺手，不该被绑死。
 *
 * 判断方式：自带运行器在 import 测试文件前会先设好
 * `globalThis.__bgTestRegistry`。有它就说明是自带运行器在跑。
 */

let mod;
if (/** @type {any} */ (globalThis).__bgTestRegistry) {
    mod = await import('./run.js');
} else {
    mod = await import('node:test');
}

export const test = mod.test;
export const it = mod.it ?? mod.test;
export const describe = mod.describe;
export const skip = mod.skip;
