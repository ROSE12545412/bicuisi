#!/usr/bin/env node
/**
 * 碧翠丝的禁书库 / _render/serve.js
 * ---------------------------------------------------------------------------
 * 验收用的极简静态服务器。**不随扩展发布**，只给 `_render/harness.html` 用。
 *
 * 为什么必须有它：验收页要 `import('../index.js')` 把插件真加载起来，
 * 而浏览器在 `file://` 协议下出于 CORS 禁止动态 import 本地模块
 *（实测报错：Failed to fetch dynamically imported module）。
 * 走 http 就正常了 —— 这也正好复现酒馆真实的 http 服务环境。
 *
 * 用法：node _render/serve.js [port]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.argv[2]) || 8791;

/** 扩展名 → Content-Type。ESM 必须是 javascript，否则浏览器拒绝执行。 */
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
        let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (!rel) rel = '_render/harness.html';

        // ── 假的 /models 端点 ────────────────────────────────────────────
        // 「拉取模型」这个功能需要有人应答。这里模拟一个 OpenAI 兼容的
        // `/models` 响应，好让验收页能真的走一遍「点按钮 → 列表填进下拉框」。
        if (url.pathname === '/mock/v1/models' || url.pathname === '/mock/models') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    object: 'list',
                    data: [
                        { id: 'deepseek-chat', object: 'model' },
                        { id: 'deepseek-reasoner', object: 'model' },
                        { id: 'gemini-3-flash-preview', object: 'model' },
                        { id: 'claude-sonnet-4', object: 'model' },
                        { id: 'gpt-4o-mini', object: 'model' },
                    ],
                }),
            );
            return;
        }

        // 目录穿越防护：解析后必须仍在 ROOT 之内
        const full = resolve(join(ROOT, normalize(rel)));
        if (!full.startsWith(ROOT)) {
            res.writeHead(403).end('forbidden');
            return;
        }

        const body = await readFile(full);
        res.writeHead(200, {
            'Content-Type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(body);
    } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`404 ${req.url}\n${e?.message ?? e}`);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`验收服务器已启动：http://127.0.0.1:${PORT}/_render/harness.html`);
});
