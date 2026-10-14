#!/usr/bin/env node
/**
 * 碧翠丝的禁书库 / scripts/check-syntax.js
 * ---------------------------------------------------------------------------
 * 加载检查：把整个源码依赖图 import 一遍。
 *
 * 为什么需要这个而不是直接跑测试：扩展是**免构建**的，代码没有编译期检查。
 * 一个路径写错、一个循环依赖、一个漏掉的 export，在浏览器里表现为
 * 「插件静默不工作」—— 用户只会看到「装了没反应」，你连报错都看不到。
 * 这个脚本把这类问题在提交前全部暴露出来。
 *
 * 用法：node scripts/check-syntax.js
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * 递归找出所有需要检查的文件（跳过 node_modules 与隐藏目录）。
 *
 * `.js` 用于 import 检查；`.ps1` / `.css` 只参与 BOM 检查
 *（`.ps1` 必须有 BOM，`.js` / `.css` 必须没有 —— 两种都会静默出问题）。
 */
async function walk(dir, out = []) {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) await walk(full, out);
        else if (item.isFile() && /\.(js|ps1|css)$/.test(item.name)) out.push(full);
    }
    return out;
}

/** 检查文件里是否有 BOM（会让某些加载器把第一行识别成非法字符）。 */
async function hasBom(file) {
    const buf = await readFile(file);
    return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

/**
 * 静态检查 import 的目标文件是否存在。
 *
 * 为什么不能只靠动态 import：动态 import 某个模块时，它内部的相对 import
 * 只在那个模块真正被求值时才会解析。如果有个文件谁都没 import 到（死代码路径），
 * 单靠 import 整个图是发现不了它的。所以这里额外做一遍静态扫描。
 */
async function checkImportTargets(file) {
    const src = await readFile(file, 'utf8');
    const problems = [];
    const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const spec = m[1] ?? m[2];
        if (!spec || !spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec);
        try {
            const st = await stat(target);
            if (!st.isFile()) problems.push(`${relative(ROOT, file)} → ${spec}（不是文件）`);
        } catch {
            problems.push(`${relative(ROOT, file)} → ${spec}（不存在）`);
        }
    }
    return problems;
}

async function main() {
    const files = (await walk(ROOT)).sort();
    const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');

    let failed = 0;
    const problems = [];

    // ── 1. BOM 检查 ────────────────────────────────────────────────────
    //
    // 为什么查这个：带 BOM 的 JS 文件在部分加载器里会把 BOM 当成源码的第一个字符，
    // 表现是「扩展静默不工作」。实测踩到过 —— 用 PowerShell 的 Set-Content 改过
    // 一次文件就带上了 BOM，而浏览器里什么错都不报。
    //
    // ⚠️ 例外：`.ps1` **必须**有 BOM。Windows PowerShell 5.1 在没有 BOM 时
    // 按 ANSI 解码脚本，中文注释会变乱码并直接导致语法错误（也实测踩到过）。
    for (const file of files) {
        const isBom = await hasBom(file);
        if (rel(file).endsWith('.ps1')) {
            if (!isBom) {
                problems.push(`${rel(file)}：PowerShell 脚本缺少 BOM —— Windows PowerShell 5.1 会把中文当 ANSI 读并报语法错误`);
            }
        } else if (isBom) {
            problems.push(`${rel(file)}：文件带 BOM，可能导致扩展加载异常`);
        }
    }

    // ── 2. import 目标静态检查 ─────────────────────────────────────────
    for (const file of files) {
        for (const p of await checkImportTargets(file)) problems.push(p);
    }

    // ── 3. 真正把入口 import 一遍 ──────────────────────────────────────
    //
    // 逐个 import 纯逻辑模块。`src/ui/*` 里有 `floating.js`（自包含、不依赖 DOM 就能
    // 求值）和 `panel.js` / `dom.js`（顶层不碰 DOM，只在使用时取 document）——
    // 所以都能直接 import。只有真需要 DOM 的才会落到下面的「跳过求值」分支。
    const modules = files.filter((f) => rel(f).startsWith('src/') && rel(f).endsWith('.js'));
    const entry = join(ROOT, 'index.js');

    const targets = [...modules, entry];

    for (const file of targets) {
        const name = rel(file);
        try {
            // 缓存破坏参数，确保每次都真正求值一次（而不是命中 ESM 缓存）
            await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
            console.log(`  ✅ ${name}`);
        } catch (e) {
            // index.js 在没有 DOM 的环境里不会自动 boot（有 typeof document 保护），
            // 但它的顶层 import 会被求值 —— ui/* 依赖 DOM，所以这里允许特定的失败。
            const isDomOnly = /document is not defined|Cannot read properties of (undefined|null) \(reading '(createElement|querySelector|body|addEventListener)'\)/.test(
                String(e?.message ?? ''),
            );
            if (isDomOnly) {
                console.log(`  ⚠️  ${name}（需要 DOM，跳过求值）`);
                continue;
            }
            failed++;
            console.log(`  ❌ ${name}`);
            problems.push(`${name}：${e?.message ?? e}\n${String(e?.stack ?? '').split('\n').slice(1, 4).join('\n')}`);
        }
    }

    // ── 4. manifest.json 校验 ──────────────────────────────────────────
    try {
        const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
        for (const key of ['display_name', 'js', 'css', 'author', 'version']) {
            if (!manifest[key]) problems.push(`manifest.json 缺少必需字段 ${key}`);
        }
        for (const key of ['js', 'css']) {
            if (!manifest[key]) continue;
            try {
                await stat(join(ROOT, manifest[key]));
            } catch {
                problems.push(`manifest.json 里的 ${key} 指向的文件不存在：${manifest[key]}`);
            }
        }
        const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
        if (pkg.version !== manifest.version) {
            problems.push(`package.json (${pkg.version}) 与 manifest.json (${manifest.version}) 版本号不一致`);
        }
        console.log(`  ✅ manifest.json（v${manifest.version}）`);
    } catch (e) {
        failed++;
        problems.push(`manifest.json 校验失败：${e?.message ?? e}`);
    }

    // ── 汇总 ───────────────────────────────────────────────────────────
    console.log('');
    if (problems.length) {
        console.log(`❌ 发现 ${problems.length} 个问题：\n`);
        for (const p of problems) console.log(`  · ${p}`);
        process.exit(1);
    }
    console.log(`✅ 全部通过：${targets.length} 个模块 + manifest.json`);
}

main().catch((e) => {
    console.error('检查脚本自身出错：', e);
    process.exit(1);
});
