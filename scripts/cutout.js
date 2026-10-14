#!/usr/bin/env node
/**
 * 碧翠丝的禁书库 / scripts/cutout.js
 * ---------------------------------------------------------------------------
 * 把一张「角色立绘 + 纯色背景」的图片抠成透明 PNG，作为悬浮窗立绘。
 *
 * ── 为什么输入是 BMP 而不是直接用 JPG
 *
 * Node 24 **没有任何内置的图像解码能力**（`ImageDecoder` / `node:image` /
 * `createImageBitmap` 全都不存在，已实测）。而解码 JPEG 需要完整的
 * 霍夫曼 + 反 DCT + YCbCr 转换，自己写一遍不值得。
 *
 * 所以解码这一步交给 Windows 自带的 GDI+（见 `scripts/decode-to-bmp.ps1`），
 * 它把任意常见格式转成无压缩 BMP。本脚本只负责读 BMP 的像素、抠背景、
 * 再编成 PNG —— 这三件事都不需要解码器。
 *
 * 用法：
 *   powershell -File scripts/decode-to-bmp.ps1 <输入图> <输出bmp>
 *   node scripts/cutout.js <输入bmp> <输出png> [容差]
 *
 * ⚠️ **容差不要超过 12**（这张图的实测值）。这个角色是淡色画风，
 * **脸的奶油色距纯白只有 23.4**；容差到了 16 泛洪就会从轮廓的裂缝钻进脸里，
 * 把整张脸挖成透明。容差 3~12 都能保住脸，默认 12 是「尽量多去掉背景」的边界值。
 * 背景残留的白边由 fillEnclosedHoles 与 composite 的边缘收缩一起处理。
 *
 * ── 为什么不用「所有接近白色的像素都变透明」这种简单做法
 *
 * 这个角色**身上本来就有大片白色**（白裙、领口、头发高光、白色蕾丝）。
 * 按阈值一刀切会把她的裙子和高光一起挖空，抠出来是个破洞的人。
 *
 * 所以这里用**从图像边缘泛洪（flood fill）**：只有「与边缘连通」的背景才会被
 * 去掉。角色内部的白色区域被角色的线条围住，泛洪走不进去，因此完整保留。
 *
 * 另外做了三件让边缘不难看的事：
 *  1. **容差判定**用的是到背景色的欧氏距离，不是单纯看亮度 —— 背景不是纯白时也对。
 *  2. **软边缘**：命中容差边缘的像素按距离给出部分透明度，抗锯齿的轮廓不会变成
 *     硬邦邦的锯齿。
 *  3. **收缩一圈**：把最外圈轮廓像素的颜色往背景方向压一点、alpha 也压一点，
 *     消掉 JPG 在轮廓外留下的浅色「白雾」—— 否则贴在深色酒馆背景上会看到灰边。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const [inputPath, outputPath, toleranceArg] = process.argv.slice(2);
if (!inputPath || !outputPath) {
    console.error('用法：node scripts/cutout.js <输入bmp> <输出png> [容差=26]');
    process.exit(1);
}
const TOLERANCE = Number(toleranceArg) || 26;

// ---------------------------------------------------------------------------
// 读 BMP
// ---------------------------------------------------------------------------

/**
 * 读无压缩 BMP（24 位或 32 位，BITMAPINFOHEADER）。
 *
 * 只需要支持 GDI+ 导出的那一种形态，所以刻意写得很窄：不处理 RLE 压缩、
 * 不处理 OS/2 头、不处理 16 位色。遇到不认识的格式直接报错，
 * 而不是勉强解出一堆花屏像素。
 *
 * @param {string} path
 * @returns {Promise<{width: number, height: number, rgba: Uint8ClampedArray}>}
 */
async function readBmp(path) {
    const buf = await readFile(path);
    if (buf.length < 54 || buf.toString('ascii', 0, 2) !== 'BM') {
        throw new Error('不是 BMP 文件');
    }
    const dataOffset = buf.readUInt32LE(10);
    const headerSize = buf.readUInt32LE(14);
    if (headerSize < 40) throw new Error(`不支持的 BMP 头（${headerSize} 字节，可能是 OS/2 格式）`);

    const width = buf.readInt32LE(18);
    const rawHeight = buf.readInt32LE(22);
    const bitCount = buf.readUInt16LE(28);
    const compression = buf.readUInt32LE(30);

    if (compression !== 0) throw new Error(`不支持的 BMP 压缩方式（${compression}，只支持 0=无压缩）`);
    if (bitCount !== 24 && bitCount !== 32) throw new Error(`不支持的位深（${bitCount}，只支持 24/32）`);

    // 高度为负表示「自上而下」存储；GDI+ 导出的是正的（自下而上）
    const bottomUp = rawHeight > 0;
    const height = Math.abs(rawHeight);
    const bytesPerPixel = bitCount / 8;
    // BMP 每行按 4 字节对齐
    const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
        const srcRow = bottomUp ? height - 1 - row : row;
        const srcOff = dataOffset + srcRow * rowStride;
        for (let x = 0; x < width; x++) {
            const s = srcOff + x * bytesPerPixel;
            const d = (row * width + x) * 4;
            // BMP 是 BGR(A)
            rgba[d] = buf[s + 2];
            rgba[d + 1] = buf[s + 1];
            rgba[d + 2] = buf[s];
            rgba[d + 3] = bytesPerPixel === 4 ? buf[s + 3] : 255;
        }
    }
    return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// 背景色探测
// ---------------------------------------------------------------------------

/**
 * 取四条边的中位色作为背景色。
 * 用中位数而不是平均值：万一某条边上蹭到了角色的一部分，平均值会被带偏。
 */
function detectBackground({ width, height, rgba }) {
    const samples = [];
    const push = (x, y) => {
        const o = (y * width + x) * 4;
        samples.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
    };
    const stepX = Math.max(1, Math.floor(width / 40));
    const stepY = Math.max(1, Math.floor(height / 40));
    for (let x = 0; x < width; x += stepX) {
        push(x, 0);
        push(x, height - 1);
    }
    for (let y = 0; y < height; y += stepY) {
        push(0, y);
        push(width - 1, y);
    }
    const median = (i) => {
        const v = samples.map((s) => s[i]).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)];
    };
    return [median(0), median(1), median(2)];
}

/** 到背景色的欧氏距离。 */
function dist(r, g, b, bg) {
    const dr = r - bg[0];
    const dg = g - bg[1];
    const db = b - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ---------------------------------------------------------------------------
// 泛洪去背景
// ---------------------------------------------------------------------------

/**
 * 从边缘泛洪，标记所有「与边缘连通的背景像素」。
 *
 * 用**扫描线泛洪**而不是四邻递归：一张 1259×790 的图有四百万像素，
 * 递归会把调用栈撑爆，逐像素入栈的 BFS 又会慢得难受。
 * 扫描线一次处理一整段连续像素，快一个量级。
 *
 * @returns {{isBg: Uint8Array, soft: Float32Array}}
 *   isBg 1=确定是背景；soft 给出 0~1 的「背景程度」，用于做软边缘
 */
function floodBackground({ width, height, rgba }, bg) {
    const isBg = new Uint8Array(width * height);
    /** 每个像素到背景色的距离，泛洪时顺便记下来给软边缘用 */
    const distMap = new Float32Array(width * height);

    // 预计算距离，避免在泛洪里反复开方
    for (let i = 0, p = 0; i < isBg.length; i++, p += 4) {
        distMap[i] = dist(rgba[p], rgba[p + 1], rgba[p + 2], bg);
    }

    // 容差内视为「背景候选」
    const isCandidate = (i) => distMap[i] <= TOLERANCE;

    /** @type {number[]} 待处理的种子（线性下标） */
    const stack = [];
    const pushSeed = (x, y) => {
        const i = y * width + x;
        if (!isBg[i] && isCandidate(i)) {
            isBg[i] = 1;
            stack.push(i);
        }
    };

    // 四条边全部作为种子
    for (let x = 0; x < width; x++) {
        pushSeed(x, 0);
        pushSeed(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
        pushSeed(0, y);
        pushSeed(width - 1, y);
    }

    while (stack.length) {
        const i = stack.pop();
        const y = (i / width) | 0;
        const x = i - y * width;

        // 向左右扫完一整段
        let left = x;
        while (left > 0 && !isBg[i - (x - left) - 1] && isCandidate(i - (x - left) - 1)) {
            const j = i - (x - left) - 1;
            isBg[j] = 1;
            left--;
        }
        let right = x;
        while (right < width - 1 && !isBg[i + (right - x) + 1] && isCandidate(i + (right - x) + 1)) {
            const j = i + (right - x) + 1;
            isBg[j] = 1;
            right++;
        }

        // 上下两行继续找种子
        for (const ny of [y - 1, y + 1]) {
            if (ny < 0 || ny >= height) continue;
            for (let nx = left; nx <= right; nx++) {
                const j = ny * width + nx;
                if (!isBg[j] && isCandidate(j)) {
                    isBg[j] = 1;
                    stack.push(j);
                }
            }
        }
    }

    return { isBg, distMap };
}

// ---------------------------------------------------------------------------
// 合成 alpha
// ---------------------------------------------------------------------------

/**
 * 生成最终 RGBA。
 *
 * 三档处理：
 *  - 泛洪命中的背景      → alpha 0
 *  - 紧贴背景的角色像素  → 按距离给 0~255 的部分 alpha（软边缘）
 *  - 其余                → 原样保留
 *
 * 另外做一次**边缘收缩**：对每个「非背景但紧邻背景」的像素，把它的颜色向自身
 * 混合一点点（去掉 JPG 在轮廓外留下的一圈浅色雾），否则贴深色背景会看到灰边。
 */
function composite({ width, height, rgba }, { isBg, distMap }, bg) {
    const out = new Uint8ClampedArray(rgba.length);
    const total = width * height;

    // 第一遍：基础 alpha
    for (let i = 0; i < total; i++) {
        const p = i * 4;
        if (isBg[i]) {
            out[p] = rgba[p];
            out[p + 1] = rgba[p + 1];
            out[p + 2] = rgba[p + 2];
            out[p + 3] = 0;
            continue;
        }
        out[p] = rgba[p];
        out[p + 1] = rgba[p + 1];
        out[p + 2] = rgba[p + 2];
        // 靠近容差上限的像素给部分透明度，消锯齿
        const d = distMap[i];
        const t = Math.min(1, Math.max(0, (d - TOLERANCE) / (TOLERANCE * 0.85)));
        out[p + 3] = Math.round(255 * t);
    }

    // 第二遍：**只收 alpha，一个颜色字节都不改**。
    //
    // ── 这里曾经做错，教训值得留下来
    //
    // 为了去掉白底在轮廓外留下的浅色雾，我原本对边缘像素做「往暗处压」
    // （`target = min(v, bg) * 0.82`，压两圈）。白边是没了，但整张图被压脏了：
    // 实测不透明像素的平均色偏达到 **ΔR=-4.4 ΔG=-6.3 ΔB=-6.2**，
    // 个别位置（发梢）甚至偏了 114 个色阶。
    //
    // 原因是**角色身上大部分像素都是描边**（这是线稿画风），
    // 「凡是贴着背景的像素都压暗」等于压了全身 —— 用户一眼就看出「颜色不对」。
    //
    // 正确做法：白边是**合成问题**，不是颜色问题。贴到深色背景上时，
    // 白边之所以显眼，是因为那些像素的 alpha 偏高、却仍带着大量背景色。
    // 所以只要把最外圈的 alpha 压下去，它自然就淡出了 —— 颜色一个字节都不用动。
    //
    // 代价是轮廓整体内收约 1px。这个代价可以接受：换来的「颜色完全忠实」重要得多。
    const out2 = new Uint8ClampedArray(out);

    // 找出「紧贴背景」的像素（四邻里有背景）
    const isEdge = new Uint8Array(total);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (isBg[i] || out[i * 4 + 3] === 0) continue;
            for (const [dx, dy] of [
                [-1, 0],
                [1, 0],
                [0, -1],
                [0, 1],
            ]) {
                if (isBg[(y + dy) * width + (x + dx)]) {
                    isEdge[i] = 1;
                    break;
                }
            }
        }
    }

    // 最外圈：alpha 打折（让它半透明地淡出，而不是留一条白线）
    for (let i = 0; i < total; i++) {
        if (isEdge[i]) out2[i * 4 + 3] = Math.round(out[i * 4 + 3] * 0.45);
    }

    // 第二圈：更轻地打一次折，让淡出是渐变而不是硬边
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (isBg[i] || isEdge[i] || out[i * 4 + 3] === 0) continue;
            for (const [dx, dy] of [
                [-1, 0],
                [1, 0],
                [0, -1],
                [0, 1],
            ]) {
                if (isEdge[(y + dy) * width + (x + dx)]) {
                    out2[i * 4 + 3] = Math.round(out[i * 4 + 3] * 0.86);
                    break;
                }
            }
        }
    }

    return out2;
}

// ---------------------------------------------------------------------------
// 填洞
// ---------------------------------------------------------------------------

/**
 * 填充「被前景包围」的透明小洞。
 *
 * ── 为什么必须有这一步（实测踩到的）
 *
 * 泛洪判定用的是「与背景色的距离 ≤ 容差」。这个角色是 Q 版淡色画风，
 * **脸上的奶油色距纯白只有 23.4**，头发高光、白色蕾丝更近。只要容差
 * 大于这些距离的**任何一个局部**，泛洪就会从某个裂缝钻进去，在脸、胸口、
 * 裙子上挖出小洞。
 *
 * 而容差又不能定得太小：JPG 在轮廓外留下一圈抗锯齿的浅色像素，容差太小
 * 就会剩下一圈白边。
 *
 * 所以策略是：**容差取一个保守的小值（保住白边），再用填洞补回误伤**。
 * 两者配合才能同时做到「没有白边」和「没有被挖穿的脸」。
 *
 * ── 为什么按大小设上限是安全的
 *
 * 实测这张图：内部洞共 1525 个、合计 16198 px，**最大的一个也才 1000 px 出头**；
 * 而背景是一整块 **68 万 px** 的连通区域。两者差三个数量级，所以「小于 N px 的
 * 内部空洞一律填掉」不可能误伤真正的背景。
 *
 * 填充色取**周围不透明像素的中位色**，而不是简单涂白 —— 洞在淡金色头发里
 * 就该填成淡金色，在粉色裙子上就该填成粉色。涂白会在头发上留一块显眼的疤。
 *
 * @param {Uint8ClampedArray} rgba 会被就地修改
 * @param {number} width
 * @param {number} height
 * @returns {{filled: number, holes: number}}
 */
function fillEnclosedHoles(rgba, width, height) {
    /** alpha 低于这个值就算「洞」（软边缘的像素 alpha 是渐变的不算） */
    const ALPHA_HOLE = 200;
    /** 洞的像素数上限。超过它的当成真背景，不动。 */
    const MAX_HOLE_PX = 8000;

    const total = width * height;
    const alphaAt = (i) => rgba[i * 4 + 3];

    // ① 从图像四条边泛洪，标记「与边缘连通的透明区域」= 真背景
    const isOutside = new Uint8Array(total);
    /** @type {number[]} */
    const stack = [];
    const seed = (x, y) => {
        const i = y * width + x;
        if (!isOutside[i] && alphaAt(i) < ALPHA_HOLE) {
            isOutside[i] = 1;
            stack.push(i);
        }
    };
    for (let x = 0; x < width; x++) {
        seed(x, 0);
        seed(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
        seed(0, y);
        seed(width - 1, y);
    }
    while (stack.length) {
        const i = stack.pop();
        const y = (i / width) | 0;
        const x = i - y * width;
        if (x > 0) seed(x - 1, y);
        if (x < width - 1) seed(x + 1, y);
        if (y > 0) seed(x, y - 1);
        if (y < height - 1) seed(x, y + 1);
    }

    // ② 剩下的低 alpha 像素就是洞，按连通块处理
    const seen = new Uint8Array(total);
    let filled = 0;
    let holes = 0;

    for (let start = 0; start < total; start++) {
        if (seen[start] || isOutside[start] || alphaAt(start) >= ALPHA_HOLE) continue;

        // 收集这一块
        /** @type {number[]} */
        const cells = [];
        /** @type {number[]} */
        const local = [start];
        seen[start] = 1;
        while (local.length) {
            const i = local.pop();
            cells.push(i);
            const y = (i / width) | 0;
            const x = i - y * width;
            for (const [dx, dy] of [
                [-1, 0],
                [1, 0],
                [0, -1],
                [0, 1],
            ]) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const j = ny * width + nx;
                if (seen[j] || isOutside[j] || alphaAt(j) >= ALPHA_HOLE) continue;
                seen[j] = 1;
                local.push(j);
            }
        }

        if (cells.length > MAX_HOLE_PX) continue; // 大块 → 当成真背景，不动

        // ③ 取这个洞四周「不透明邻居」的中位色
        /** @type {number[][]} */
        const samples = [];
        const cellSet = new Set(cells);
        for (const i of cells) {
            const y = (i / width) | 0;
            const x = i - y * width;
            for (let dy = -4; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const j = ny * width + nx;
                    if (cellSet.has(j) || alphaAt(j) < 250) continue;
                    samples.push([rgba[j * 4], rgba[j * 4 + 1], rgba[j * 4 + 2]]);
                }
            }
        }
        if (!samples.length) continue;

        const median = (/** @type {number} */ k) => {
            const v = samples.map((s) => s[k]).sort((a, b) => a - b);
            return v[Math.floor(v.length / 2)];
        };
        const fill = [median(0), median(1), median(2)];

        for (const i of cells) {
            const p = i * 4;
            rgba[p] = fill[0];
            rgba[p + 1] = fill[1];
            rgba[p + 2] = fill[2];
            rgba[p + 3] = 255;
        }
        filled += cells.length;
        holes++;
    }

    return { filled, holes };
}

/**
 * 裁掉四周的透明留白，只留一点点呼吸边距。
 *
 * 为什么必须裁：原图是「角色居中 + 大片白底」的构图，左右各有 ~200px 空白。
 * 不裁的话，这张图放进悬浮窗后角色只占中间一小块，看起来又小又偏 ——
 * 而且 CSS 里按 `width:100%` 缩放时，那些空白会把角色压得更小。
 *
 * 边距取**透明像素的 alpha 阈值 8** 作为判定：alpha ≤ 8 视为空白，
 * 这样不会因为软边缘的零星半透明像素而把包围盒撑大。
 *
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} pad 裁完后四周保留多少像素的透明边距
 * @returns {{rgba: Uint8ClampedArray, width: number, height: number, box: {x0:number,y0:number,x1:number,y1:number}}}
 */
function cropToContent(rgba, width, height, pad = 6) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (rgba[(y * width + x) * 4 + 3] > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return { rgba, width, height, box: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 } };

    const x0 = Math.max(0, minX - pad);
    const y0 = Math.max(0, minY - pad);
    const x1 = Math.min(width - 1, maxX + pad);
    const y1 = Math.min(height - 1, maxY + pad);
    const nw = x1 - x0 + 1;
    const nh = y1 - y0 + 1;

    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
        const srcStart = ((y + y0) * width + x0) * 4;
        out.set(rgba.subarray(srcStart, srcStart + nw * 4), y * nw * 4);
    }
    return { rgba: out, width: nw, height: nh, box: { x0, y0, x1, y1 } };
}

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

/** 把 RGBA 编成 PNG（8bit / 真彩+alpha / 非隔行）。 */
function encodePng(width, height, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    // 每行前面加一个 filter 字节。用 1（Sub）比 0（None）压得更好，
    // 对这种大片平坦区域的图能省一半体积。
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        const ro = y * (stride + 1);
        raw[ro] = 1;
        for (let x = 0; x < stride; x++) {
            const cur = rgba[y * stride + x];
            const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
            raw[ro + 1 + x] = (cur - left) & 0xff;
        }
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------------------

async function main() {
    console.log(`读取 ${inputPath}`);
    const img = await readBmp(inputPath);
    console.log(`  尺寸 ${img.width}×${img.height}`);

    const bg = detectBackground(img);
    console.log(`  探测到背景色 rgb(${bg.join(', ')})`);

    const flood = floodBackground(img, bg);
    const total = img.width * img.height;
    let bgCount = 0;
    for (let i = 0; i < total; i++) if (flood.isBg[i]) bgCount++;
    const pct = ((bgCount / total) * 100).toFixed(1);
    console.log(`  泛洪去除背景 ${bgCount} px（占 ${pct}%）`);
    console.log(`  保留前景 ${total - bgCount} px`);

    if (bgCount === 0) {
        console.error('  ⚠️ 一个背景像素都没识别到 —— 容差可能太小，或这张图没有纯色背景');
        process.exit(2);
    }
    if (pct > 92) {
        console.error('  ⚠️ 去掉了 92% 以上 —— 容差可能太大，把角色也吃掉了');
        process.exit(2);
    }

    const rgba = composite(img, flood, bg);

    // 填回被泛洪误伤的内部小洞（淡色画风的必需品，见 fillEnclosedHoles 的说明）
    const fillStat = fillEnclosedHoles(rgba, img.width, img.height);
    console.log(`  填回内部小洞 ${fillStat.holes} 个、共 ${fillStat.filled} px`);

    // 裁掉四周透明留白，否则角色在悬浮窗里会又小又偏
    const cropped = cropToContent(rgba, img.width, img.height, 6);
    console.log(
        `  裁掉留白：${img.width}×${img.height} → ${cropped.width}×${cropped.height}` +
            `（原图内有效区域 x:${cropped.box.x0}~${cropped.box.x1} y:${cropped.box.y0}~${cropped.box.y1}）`,
    );

    const png = encodePng(cropped.width, cropped.height, cropped.rgba);
    await writeFile(outputPath, png);
    console.log(`写出 ${outputPath}（${(png.length / 1024).toFixed(1)} KB）`);
}

main().catch((e) => {
    console.error('抠图失败：', e);
    process.exit(1);
});
