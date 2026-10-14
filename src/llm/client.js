/**
 * 碧翠丝的禁书库 / src/llm/client.js
 * ---------------------------------------------------------------------------
 * 辅助 LLM 客户端。和正文模型**完全分开**，四个通道任选：
 *
 *  1. `profile` —— `ctx.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens)`
 *     复用用户在「连接配置」里存好的 profile。**API key 明文拿不到**（存在 secrets.json），
 *     所以「既想用独立模型又不想重复填 key」时这是最佳选择。
 *     TauriTavern 是纯 Rust 客户端，必然实现这条 ST 内部路径 —— **默认走它**。
 *  2. `tavern-helper` —— `window.TavernHelper.generateRaw`
 *     功能最强（支持 custom_api 自带 URL/Key/Model 与 json_schema 强约束），
 *     但需要用户额外装「酒馆助手 / JS-Slash-Runner」扩展。
 *  3. `custom` —— 直连 OpenAI 兼容端点（fetch）。零依赖，但要自己填 URL/Key/Model，
 *     且在 Tauri 的 WebView 里可能被 CSP / 域名白名单拦。
 *  4. `main` —— 复用当前主连接。最省事但会被当前预设污染，只作兜底。
 *
 * ⚠️ **不要**去打 `/api/backends/chat-completions/generate`。那是 SillyTavern
 * **Node 服务端**的端点，TauriTavern 没有 Node 后端，该端点不一定存在。
 *
 * 所有通道统一返回 `{ ok, text, error, meta }`，由上层决定怎么解析。
 */

/** 用户主动中断时统一用这个字符串，方便上层区分「失败」与「被中止」。 */
import { beginRequestReport, finishRequestReport, responseShape } from '../error-report.js';

export const ABORT_MESSAGE = '已被用户中止';

/** 判断异常是不是「被 abort 中断」。 */
export function isAbortError(error) {
    if (!error) return false;
    const name = String(error?.name ?? '');
    if (name === 'AbortError') return true;
    const msg = String(error?.message ?? error ?? '');
    return /abort/i.test(msg);
}

/**
 * 把任意值安全地变成非空字符串。
 *
 * 存在的理由：`String(undefined)` 得到字面量 `"undefined"`，
 * 而配置里「没填」的字段到处都是 undefined。直接用 String() 会让
 * `if (apiUrl)` 之类的判断全部成立，把「没配置」误判成「配置了一个叫 undefined 的地址」。
 *
 * @param {any} value
 * @returns {string}
 */
export function toText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
        // 有些宿主把文本包在 { text } / { content } 里
        for (const key of ['text', 'content', 'value', 'message']) {
            const inner = value[key];
            if (typeof inner === 'string' && inner.trim()) return inner.trim();
        }
    }
    return '';
}

/**
 * 把任意异常转成**有信息量**的字符串。
 *
 * ⚠️ 这个函数的存在是有教训的：直接 `e.message` 遇到「不是标准 Error 的异常」时
 * 是 undefined，而 `?? e` 又拿到了那个对象 → 字符串化成 `[object Object]` 或空串，
 * 最后被兜底成一句毫无用处的「未知错误」，把真实原因彻底掩盖。
 *
 * 按可靠性依次尝试：message → 常见错误字段 → JSON → 类型名。
 *
 * @param {any} error
 * @returns {string}
 */
export function describeError(error) {
    if (error === null || error === undefined) return '';
    if (typeof error === 'string') return error.trim();
    if (typeof error === 'number' || typeof error === 'boolean') return String(error);

    const message = typeof error.message === 'string' ? error.message.trim() : '';
    if (message) return message;

    for (const key of ['error', 'error_description', 'description', 'reason', 'detail', 'msg']) {
        const value = error[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (value && typeof value === 'object') {
            const nested = describeError(value);
            if (nested) return nested;
        }
    }

    try {
        const json = JSON.stringify(error);
        if (json && json !== '{}' && json !== 'null') return json.slice(0, 400);
    } catch {
        /* 循环引用之类，忽略 */
    }

    const name = typeof error.name === 'string' && error.name ? error.name : '';
    const keys = (() => {
        try {
            return Object.keys(error).slice(0, 8).join(',');
        } catch {
            return '';
        }
    })();
    return [name || '未知异常', keys ? `字段：${keys}` : ''].filter(Boolean).join('　');
}

/**
 * 从各家响应里抠出正文文本。
 *
 * 四种通道（连接配置 / 酒馆助手 / 直连 / 主连接）返回的形状各不相同，
 * 所以这里逐个探测，而不是假定某一种。这是本机实测踩出来的清单。
 *
 * @param {any} response
 * @returns {string}
 */
export function extractContent(response) {
    if (response === null || response === undefined) return '';
    if (typeof response === 'string') return response;

    if (typeof response === 'object') {
        // ① TavernHelper.generateRaw 返回 GenerateToolCallResult: { content, tool_calls }
        if (typeof response.content === 'string' && response.content) return response.content;

        // ② ConnectionManagerRequestService：{ result: { choices: [...] } }
        const fromResult = response.result?.choices?.[0]?.message?.content;
        if (typeof fromResult === 'string' && fromResult) return fromResult;

        // ③ 标准 OpenAI：{ choices: [{ message: { content } }] } / [{ text }]
        const fromChoices = response.choices?.[0]?.message?.content ?? response.choices?.[0]?.text;
        if (typeof fromChoices === 'string' && fromChoices) return fromChoices;

        // ④ 有些实现直接把 message 放顶层
        const fromMessage = response.message?.content ?? (typeof response.message === 'string' ? response.message : '');
        if (fromMessage) return fromMessage;

        // ⑤ 工具调用兜底：arguments 里往往就是我们要的 JSON
        const args = response.tool_calls?.[0]?.function?.arguments;
        if (typeof args === 'string' && args) return args;

        // ⑥ 再深一层（少数代理套了两层 data）
        const fromData = response.data?.choices?.[0]?.message?.content;
        if (typeof fromData === 'string' && fromData) return fromData;
    }

    return '';
}

/**
 * 把用户填的地址规整成 OpenAI 兼容的 chat completions 端点。
 *
 * 用户会填成各种样子，都要能用：
 *   `https://api.x.com/v1`                    → `https://api.x.com/v1/chat/completions`
 *   `https://api.x.com/v1/`                   → `https://api.x.com/v1/chat/completions`
 *   `https://api.x.com/v1/chat/completions`   → 原样
 *   `https://api.x.com/v1/models`             → `https://api.x.com/v1/chat/completions`
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function buildChatEndpoint(apiUrl) {
    const raw = toText(apiUrl);
    if (!raw) return '';
    const trimmed = raw.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
    if (/\/models$/i.test(trimmed)) return `${trimmed.replace(/\/models$/i, '')}/chat/completions`;
    return `${trimmed}/chat/completions`;
}

/**
 * 把用户填的地址规整成 OpenAI 兼容的模型列表端点。
 *
 * 这一条容易踩坑：**模型列表挂在 base 那一层**，不是 `/v1/chat/completions/models`。
 * 所以先归一到 base，再拼 `/models`。
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function buildModelsEndpoint(apiUrl) {
    const raw = toText(apiUrl);
    if (!raw) return '';
    let base = raw.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) base = base.replace(/\/chat\/completions$/i, '');
    if (/\/models$/i.test(base)) return base;
    return `${base}/models`;
}

/**
 * 从模型列表响应里提取模型名。
 *
 * 兼容四种真实存在的形状（实测会遇到的都在这里）：
 *  - OpenAI 风格： `{ data: [{ id: 'gpt-4o' }, …] }`
 *  - 部分中转：   `{ models: [{ name: 'llama3' }, …] }`
 *  - **Ollama**：  `{ models: [{ name: 'llama3:latest', model: 'llama3:latest' }, …] }`
 *  - 直接数组：   `['a', 'b']` 或 `[{ id: 'a' }]`
 *
 * @param {any} payload
 * @returns {string[]}
 */
export function extractModelIds(payload) {
    if (!payload) return [];
    /** @type {any[]} */
    let list = [];
    if (Array.isArray(payload)) list = payload;
    else if (Array.isArray(payload.data)) list = payload.data;
    else if (Array.isArray(payload.models)) list = payload.models;
    else if (Array.isArray(payload.result)) list = payload.result;
    else return [];

    const names = [];
    for (const item of list) {
        const name =
            typeof item === 'string'
                ? item
                : toText(item?.id ?? item?.name ?? item?.model ?? item?.slug ?? '');
        if (name) names.push(name);
    }
    // 去重 + 排序：长列表里好找
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * 取酒馆助手（TavernHelper / JS-Slash-Runner）的全局对象。
 *
 * 用 `globalThis` 而不是 `window`：浏览器里两者等价，但在**非浏览器环境**
 *（冒烟测试，以及某些把扩展跑在特殊宿主里的实现）只有 `globalThis`。
 *
 * @returns {any}
 */
export function getTavernHelper() {
    try {
        return /** @type {any} */ (globalThis)?.TavernHelper ?? undefined;
    } catch {
        return undefined;
    }
}

/** 带超时的 Promise 包装。成功/失败都会清掉定时器，避免挂住进程。 */
export function withTimeout(promise, ms, label = 'LLM 调用') {
    if (!ms || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`));
        }, ms);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/** 可被中断的 sleep。 */
export function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve(undefined);
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener?.(
            'abort',
            () => {
                clearTimeout(timer);
                resolve(undefined);
            },
            { once: true },
        );
    });
}

/**
 * 单个通道的请求封装。
 */
export class LlmClient {
    /**
     * @param {any} ctx SillyTavern context（可以只在 `_viaProfile` 里用到）
     * @param {any} config `settings.llm`
     * @param {string} [label] 通道名，用于日志与报错
     */
    constructor(ctx, config, label = '贝翠丝辅助通道') {
        this.ctx = ctx;
        this.config = config ?? {};
        this.label = label;
        /** 上一次请求过程中的兼容性提示，由 `complete()` 带进 meta。 */
        this.lastNotice = '';
    }

    /** 当前环境能力探测：哪些模式可用。 */
    static probe(ctx) {
        const helper = getTavernHelper();
        const service = ctx?.ConnectionManagerRequestService;
        return {
            tavernHelper: Boolean(helper && typeof helper.generateRaw === 'function'),
            profileService: Boolean(service && typeof service.sendRequest === 'function'),
            profiles: LlmClient.listProfiles(ctx),
        };
    }

    /** 列出可用的连接配置（Connection Profile）。 */
    static listProfiles(ctx) {
        try {
            const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
            if (!Array.isArray(profiles)) return [];
            return profiles
                .filter((p) => p && p.id)
                .map((p) => ({
                    id: String(p.id),
                    name: toText(p.name) || toText(p.model) || String(p.id),
                    api: toText(p.api),
                    model: toText(p.model),
                }));
        } catch {
            return [];
        }
    }

    /**
     * 从某个连接配置里读它记住的模型名。
     *
     * 用途：用户选了「连接配置」通道时，「拉取模型」这个动作仍然要有意义 ——
     * 我们可以拿到那个配置的**地址与 Key**，然后自己去问 `/models`。
     * 注意 ST 把 Key 存在 secrets.json 里，**扩展拿不到明文**，
     * 所以对 profile 我们只能拿地址去问（有些中转的 /models 不需要鉴权）。
     *
     * @param {any} ctx
     * @param {string} profileId
     * @returns {{apiUrl: string, model: string, api: string}}
     */
    static describeProfile(ctx, profileId) {
        try {
            const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
            const p = Array.isArray(profiles) ? profiles.find((x) => x?.id === profileId) : null;
            if (!p) return { apiUrl: '', model: '', api: '' };
            return {
                apiUrl: toText(p['api-url'] ?? p.apiUrl ?? p.url ?? ''),
                model: toText(p.model ?? ''),
                api: toText(p.api ?? ''),
            };
        } catch {
            return { apiUrl: '', model: '', api: '' };
        }
    }

    /**
     * 拉取可用的模型列表。
     *
     * 这是「先填地址和 Key，再把模型变成下拉选择」的那一步。
     * 自己手打模型名是最容易出错的地方（大小写、`-preview` 后缀、中转的别名），
     * 能拉列表就不该让人手打。
     *
     * ⚠️ 走的是**直连 fetch**，因为 `/models` 这个端点不在酒馆的任何封装里。
     * 所以只有「直连」模式的配置才拉得到；「连接配置」模式下 Key 拿不到明文，
     * 能否成功取决于那个中转的 /models 是否需要鉴权。
     *
     * @param {{apiUrl: string, apiKey?: string, signal?: AbortSignal}} opts
     * @returns {Promise<{ok: boolean, models: string[], error?: string, endpoint?: string}>}
     */
    static async fetchModels({ apiUrl, apiKey, signal }) {
        const url = buildModelsEndpoint(apiUrl);
        if (!url) return { ok: false, models: [], error: '还没填 API 地址' };

        /** @type {Record<string, string>} */
        const headers = { Accept: 'application/json' };
        const key = toText(apiKey);
        if (key) headers.Authorization = `Bearer ${key}`;

        try {
            const res = await fetch(url, { method: 'GET', headers, signal });
            const text = await res.text().catch(() => '');
            if (!res.ok) {
                return {
                    ok: false,
                    models: [],
                    endpoint: url,
                    error: `HTTP ${res.status}${text ? ` — ${String(text).slice(0, 200)}` : ''}`,
                };
            }
            let payload;
            try {
                payload = JSON.parse(text);
            } catch (e) {
                return { ok: false, models: [], endpoint: url, error: `返回的不是合法 JSON：${describeError(e)}` };
            }
            const models = extractModelIds(payload);
            if (!models.length) {
                return {
                    ok: false,
                    models: [],
                    endpoint: url,
                    error: '响应里没有找到模型名（该端点可能不支持 /models）',
                };
            }
            return { ok: true, models, endpoint: url };
        } catch (e) {
            return {
                ok: false,
                models: [],
                endpoint: url,
                error: `${describeError(e)}（可能是 CORS 或地址不对）`,
            };
        }
    }

    /**
     * 发一次请求。
     *
     * 两种调用方式（都支持）：
     *  - `{ messages: [{role, content}, …] }` —— 完整消息数组，人设分段走这条
     *  - `{ system, user }` —— 简写，内部拼成两条
     *
     * @param {{messages?: Array<{role: string, content: string}>, system?: string, user?: string, jsonSchema?: {name: string, description?: string, value: object, strict?: boolean}, maxTokens?: number, temperature?: number, signal?: AbortSignal}} req
     * @returns {Promise<{ok: boolean, text: string, error?: string, meta: object, aborted?: boolean}>}
     */
    async complete(req) {
        const signal = /** @type {AbortSignal|undefined} */ (req.signal);

        /** @type {Array<{role: string, content: string}>} */
        let messages;
        if (Array.isArray(req.messages) && req.messages.length) {
            messages = req.messages
                .filter((m) => m && typeof m.content === 'string' && m.content.trim())
                .map((m) => ({ role: String(m.role ?? 'system'), content: String(m.content) }));
        } else {
            messages = [];
            if (req.system) messages.push({ role: 'system', content: req.system });
            if (req.user) messages.push({ role: 'user', content: req.user });
        }
        if (!messages.length) {
            return { ok: false, text: '', error: '没有可发送的消息内容', meta: {} };
        }

        const baseTokens = Number(req.maxTokens ?? this.config.maxTokens) || 400;
        const structuredBudget = req.jsonSchema ? Number(this.config.structuredMaxTokens) || 0 : 0;
        const maxTokens = Math.max(32, Math.min(32768, Math.max(baseTokens, structuredBudget)));
        const configuredTemperature = Number(req.temperature ?? this.config.temperature);
        const temperature = Number.isFinite(configuredTemperature) ? configuredTemperature : 1.0;
        const timeoutMs = Math.max(3000, Number(this.config.timeoutMs) || 45000);
        const meta = { mode: this.config.mode, maxTokens, temperature, attempts: 0 };
        const report = beginRequestReport(this.label, this.config, { maxTokens, temperature, timeoutMs, schema: req.jsonSchema });
        let reportStatus = 'failed';

        // 超时与外部取消汇入请求自己的 controller，绝不修改调用方 controller。
        // 即使宿主忽略 signal，也停止等待并拒绝迟到结果。
        const controller = new AbortController();
        let timeoutError;
        let timer;
        const forwardAbort = () => controller.abort(signal?.reason);
        let onAbort;
        this.lastNotice = '';
        try {
            const cancelled = new Promise((_, reject) => {
                onAbort = () => reject(timeoutError ?? Object.assign(new Error(ABORT_MESSAGE), { name: 'AbortError' }));
                controller.signal.addEventListener('abort', onAbort, { once: true });
                signal?.addEventListener('abort', forwardAbort, { once: true });
                if (signal?.aborted) forwardAbort();
                else timer = setTimeout(() => {
                    timeoutError = new Error(`${this.label} 超时（${Math.round(timeoutMs / 1000)} 秒）`);
                    controller.abort(timeoutError);
                }, timeoutMs);
            });
            const dispatch = controller.signal.aborted ? cancelled : this._dispatch(messages, {
                maxTokens, temperature, jsonSchema: req.jsonSchema, signal: controller.signal,
                onAttempt: () => { meta.attempts++; },
                onNotice: (notice) => { meta.notice = notice; this.lastNotice = notice; report.compatibilityFallback = true; },
                onResponse: info => { report.response = info; },
            });
            const text = await Promise.race([dispatch, cancelled]);
            if (!text || !text.trim()) {
                return { ok: false, text: '', error: '模型返回了空内容', meta };
            }
            reportStatus = 'success';
            return { ok: true, text, meta };
        } catch (e) {
            reportStatus = timeoutError ? 'timeout' : (isAbortError(e) || signal?.aborted ? 'aborted' : 'failed');
            const message = describeError(e);
            report.failureCode = /推理耗尽/.test(message) ? 'reasoning_budget_exhausted' : /为空|空内容|结构不认识/.test(message) ? 'empty_or_unknown_content' : /不是合法 JSON/.test(message) ? 'invalid_json' : /^HTTP \d+/.test(message) ? 'http_error' : reportStatus === 'failed' ? 'transport_error' : reportStatus;
            if (timeoutError) return { ok: false, text: '', error: timeoutError.message, meta };
            if (isAbortError(e) || signal?.aborted) {
                return { ok: false, text: '', error: ABORT_MESSAGE, meta, aborted: true };
            }
            return { ok: false, text: '', error: describeError(e) || '请求失败（异常对象没有可读信息）', meta };
        } finally {
            finishRequestReport(report, reportStatus, meta);
            clearTimeout(timer);
            signal?.removeEventListener('abort', forwardAbort);
            controller.signal.removeEventListener('abort', onAbort);
        }
    }

    /**
     * 按配置分发到具体传输方式。
     * @param {Array<{role: string, content: string}>} messages
     * @param {{maxTokens: number, temperature: number, jsonSchema?: object, signal?: AbortSignal}} opts
     * @returns {Promise<string>}
     */
    async _dispatch(messages, opts) {
        const mode = this.config.mode || 'profile';
        switch (mode) {
            case 'profile':
                return this._viaProfile(messages, opts);
            case 'tavern-helper':
                return this._viaTavernHelper(messages, opts, true);
            case 'main':
                return this._viaTavernHelper(messages, opts, false);
            case 'custom':
                return this._viaFetch(messages, opts);
            default:
                throw new Error(`未知的通道模式：${mode}`);
        }
    }

    /**
     * 走连接配置（ConnectionManagerRequestService）—— 默认通道。
     * @param {Array<{role: string, content: string}>} messages
     * @param {{maxTokens: number, signal?: AbortSignal}} opts
     * @returns {Promise<string>}
     */
    async _viaProfile(messages, opts) {
        const service = this.ctx?.ConnectionManagerRequestService;
        if (!service || typeof service.sendRequest !== 'function') {
            throw new Error('当前酒馆不支持连接配置服务（ConnectionManagerRequestService）');
        }
        const profileId = toText(this.config.profileId);
        if (!profileId) {
            throw new Error('通道模式是「连接配置」但没选具体配置 —— 请到扩展设置里选一个');
        }

        // 第 4 参是可选配置包。不同酒馆版本支持的字段不一致，
        // 所以只在确实要中断时才传，避免老版本因为多一个参数报错。
        const extra = opts.signal ? { signal: opts.signal } : undefined;
        let response;
        try {
            opts.onAttempt?.();
            response = extra
                ? await service.sendRequest(profileId, messages, opts.maxTokens, extra)
                : await service.sendRequest(profileId, messages, opts.maxTokens);
        } catch (e) {
            // 有些版本不接受第 4 参，去掉再试一次（只在确实多传了参数时）。
            // 中止绝不能走这个兼容回退：否则会立刻发起一个没有 signal 的新请求。
            if (extra && !opts.signal?.aborted && !isAbortError(e) && hintsProfileSignatureProblem(e)) {
                this.lastNotice = '该酒馆的 sendRequest 不接受中断参数，已退回三参调用';
                opts.onNotice?.(this.lastNotice);
                opts.onAttempt?.();
                response = await service.sendRequest(profileId, messages, opts.maxTokens);
            } else {
                throw e;
            }
        }
        // 少数宿主不会 reject 已中止的请求，而是照常 resolve；不能把这种迟到结果当成功。
        if (opts.signal?.aborted) {
            throw Object.assign(new Error(ABORT_MESSAGE), { name: 'AbortError' });
        }
        const text = extractContent(response);
        opts.onResponse?.({ shape: responseShape(response), extractedChars: text.length });
        if (!text) throw new Error('连接配置返回内容为空（可能是该配置的模型不支持当前请求）');
        return text;
    }

    /**
     * 走酒馆助手 generateRaw。
     * @param {Array<{role: string, content: string}>} messages
     * @param {{maxTokens: number, temperature: number, jsonSchema?: object, signal?: AbortSignal}} opts
     * @param {boolean} useCustomApi
     * @returns {Promise<string>}
     */
    async _viaTavernHelper(messages, opts, useCustomApi) {
        const helper = getTavernHelper();
        if (!helper || typeof helper.generateRaw !== 'function') {
            throw new Error('未检测到酒馆助手（TavernHelper），请安装 JS-Slash-Runner 扩展，或把通道模式改成「连接配置」');
        }

        /** @type {Record<string, any>} */
        const params = {
            ordered_prompts: messages.map((m) => ({ role: m.role, content: m.content })),
            should_silence: true,
            should_stream: false,
        };
        if (opts.signal) params.signal = opts.signal;
        if (opts.jsonSchema) params.json_schema = opts.jsonSchema;

        if (useCustomApi) {
            const url = toText(this.config.custom?.url);
            const model = toText(this.config.custom?.model);
            if (url && model) {
                params.custom_api = {
                    apiurl: url,
                    key: toText(this.config.custom?.key),
                    model,
                    source: 'custom',
                    max_tokens: opts.maxTokens,
                    temperature: opts.temperature,
                };
            }
        }

        opts.onAttempt?.();
        const response = await helper.generateRaw(params);
        const text = extractContent(response);
        if (!text) throw new Error('酒馆助手返回内容为空（可能是模型拒绝或 schema 不匹配）');
        return text;
    }

    /**
     * 直连 OpenAI 兼容端点。
     *
     * 带一个重要的兼容处理：很多服务商**不支持 `response_format: json_schema`**
     *（典型是 Gemini 系，以及不少第三方中转），收到会直接 400。
     * 这种情况自动去掉该参数重试一次 —— 提示词本来就要求「只输出 JSON」，
     * 只是少了服务端强约束，解析成功率低一点但仍可用。
     *
     * @param {Array<{role: string, content: string}>} messages
     * @param {{maxTokens: number, temperature: number, jsonSchema?: object, signal?: AbortSignal}} opts
     * @returns {Promise<string>}
     */
    async _viaFetch(messages, opts) {
        const url = buildChatEndpoint(this.config.custom?.url);
        if (!url) throw new Error('通道模式为「直连」但没填 API 地址');
        const model = toText(this.config.custom?.model);
        if (!model) throw new Error('通道模式为「直连」但没填模型名');

        /** @type {Record<string, string>} */
        const headers = { 'Content-Type': 'application/json' };
        const key = toText(this.config.custom?.key);
        if (key) headers.Authorization = `Bearer ${key}`;

        /**
         * 发一次请求，返回原始 Response（不抛 HTTP 错误，交给调用方判断）。
         * @param {boolean} withJsonSchema
         */
        const send = async (withJsonSchema) => {
            /** @type {Record<string, any>} */
            const body = {
                model,
                messages,
                max_tokens: opts.maxTokens,
                temperature: opts.temperature,
                stream: false,
            };
            if (withJsonSchema && opts.jsonSchema) {
                body.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name: opts.jsonSchema.name,
                        schema: opts.jsonSchema.value,
                        strict: opts.jsonSchema.strict !== false,
                    },
                };
            }
            if (opts.signal?.aborted) throw Object.assign(new Error(ABORT_MESSAGE), { name: 'AbortError' });
            opts.onAttempt?.();
            const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
            opts.onResponse?.({ httpStatus: response.status, ok: response.ok, schemaSent: withJsonSchema && Boolean(opts.jsonSchema) });
            return response;
        };

        /** 读错误详情（截断，避免把整个 HTML 错误页塞进日志）。 */
        const readError = async (/** @type {Response} */ res) => {
            try {
                const text = await res.text();
                return String(text ?? '').slice(0, 400);
            } catch {
                return '';
            }
        };

        let res = await send(true);
        if (!res.ok) {
            const detail = await readError(res);
            // 只有「400/422 + 错误文本提到 response_format/json_schema」才降级，
            // 免得把「模型名写错了」「额度用完」也当成 schema 问题掩盖掉。
            if (opts.jsonSchema && !opts.signal?.aborted && (res.status === 400 || res.status === 422) && hintsJsonSchemaProblem(detail)) {
                this.lastNotice = '该端点不支持 response_format: json_schema，已自动降级为纯提示词约束';
                opts.onNotice?.(this.lastNotice);
                res = await send(false);
                if (!res.ok) {
                    const detail2 = await readError(res);
                    throw new Error(`HTTP ${res.status}${detail2 ? ` — ${detail2}` : ''}`);
                }
            } else {
                throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
            }
        }

        let payload;
        try {
            payload = await res.json();
        } catch (e) {
            opts.onResponse?.({ httpStatus: res.status, ok: res.ok, json: false });
            throw new Error(`端点返回的不是合法 JSON：${describeError(e)}`);
        }
        const text = extractContent(payload);
        opts.onResponse?.({ httpStatus: res.status, ok: res.ok, json: true, shape: responseShape(payload), extractedChars: text.length });
        const shape = responseShape(payload);
        if (shape.finishReason === 'length' && text) {
            throw new Error(`${this.label || 'API 请求'}输出被截断（实际输出预算 ${opts.maxTokens} token，finish_reason=length）；返回内容不完整，已停止后续处理。请提高该阶段 API 预设的输出预算或结构化请求输出预算；不会自动重试，也不会把推理文本当答案。`);
        }
        if (!text) {
            if (shape.finishReason === 'length' && (shape.reasoningChars > 0 || shape.usage.reasoning > 0)) {
                throw new Error(`${this.label || 'API 请求'}：推理耗尽输出预算（${opts.maxTokens} token），最终答案为空；请提高该阶段 API 预设的输出预算或结构化请求输出预算。不会自动重试。`);
            }
            throw new Error('端点返回内容为空或结构不认识（请在诊断页复制错误报告）');
        }
        return text;
    }
}

/** 只接受明确的本地签名 TypeError；鉴权、网络及服务端异常不能重发。 */
function hintsProfileSignatureProblem(error) {
    if (error?.name !== 'TypeError') return false;
    const text = String(error.message ?? '');
    if (/HTTP\s*\d{3}|network|fetch failed|failed to fetch/i.test(text)) return false;
    return /(?:fourth|4th|4|extra)\s+(?:argument|parameter).*?(?:unsupported|not supported|not accepted|unexpected)/i.test(text)
        || /(?:unsupported|unexpected|unrecognized|unknown)\s+(?:fourth|4th|4|extra)\s+(?:argument|parameter)\b/i.test(text)
        || /(?:unsupported|unexpected|unrecognized|unknown)\s+(?:argument|parameter|option)\b.*?\bsignal\b/i.test(text)
        || /(?:accepts?|expects?|takes?)\s+(?:exactly\s+|only\s+|at most\s+)?3\s+(?:arguments|parameters).*?(?:4|four)\b/i.test(text);
}

/** 必须同时指出 schema 键与参数问题，泛化 unsupported/invalid_argument 不够。 */
function hintsJsonSchemaProblem(detail) {
    const text = String(detail ?? '').toLowerCase();
    return /response_format|json_schema|json schema/.test(text)
        && /unsupported|not supported|does not support|unknown|unrecognized|unexpected|not permitted|not allowed|invalid|not available/.test(text);
}
