import { CODE_REVISION } from './config.js';
const requests = [];
let sequence = 0;
const type = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const safeNumber = v => Number.isFinite(v) ? v : null;
/** Retain structure ONLY, never response text/reasoning/error messages. */
export function responseShape(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const choices = Array.isArray(p.choices) ? p.choices : [];
    const message = choices[0]?.message ?? {};
    return {
        type: type(payload), keys: Object.keys(p).filter(k => ['choices','usage','error','id','object','created','model','output','content','data','result','response','message','text','status','candidates'].includes(k)), unknownKeyCount: Object.keys(p).filter(k => !['choices','usage','error','id','object','created','model','output','content','data','result','response','message','text','status','candidates'].includes(k)).length,
        choices: choices.length, contentType: type(message.content), contentChars: typeof message.content === 'string' ? message.content.length : null,
        contentParts: Array.isArray(message.content) ? message.content.length : null,
        reasoningChars: typeof message.reasoning_content === 'string' ? message.reasoning_content.length : null,
        refusalPresent: Boolean(message.refusal), finishReason: ['stop','length','content_filter','tool_calls','function_call'].includes(choices[0]?.finish_reason) ? choices[0].finish_reason : (choices[0]?.finish_reason ? 'other' : null),
        usage: { prompt: safeNumber(p.usage?.prompt_tokens), completion: safeNumber(p.usage?.completion_tokens), total: safeNumber(p.usage?.total_tokens), reasoning: safeNumber(p.usage?.completion_tokens_details?.reasoning_tokens) },
        errorPresent: Boolean(p.error),
    };
}
export function beginRequestReport(label, config, options) {
    const record = { id: ++sequence, at: new Date().toISOString(), label: ['剧情引导','事实观测','共享事实观察','人神对抗观察','剧情定位','原文适用性核查'].includes(label) ? label : '辅助请求', mode: ['custom','profile','main','tavern-helper'].includes(config?.mode) ? config.mode : 'other', maxTokens: options.maxTokens, temperature: options.temperature, timeoutMs: options.timeoutMs, schema: Boolean(options.schema), attempts: 0, status: 'pending' };
    requests.push(record); if (requests.length > 12) requests.shift();
    return record;
}
export function finishRequestReport(record, outcome, meta) {
    record.durationMs = Math.max(0, Date.now() - Date.parse(record.at));
    record.status = outcome; record.attempts = meta.attempts;
}
export function buildErrorReport(app) {
    // No app.state(): that includes story history, settings and raw remote errors.
    const recent = requests.map(r => JSON.parse(JSON.stringify(r)));
    return { reportVersion: 1, version: `1.1.0 (${CODE_REVISION})`, createdAt: new Date().toISOString(),
        privacy: '不含 API 地址/密钥、模型名、正文、世界书、请求提示、响应文本或远端错误正文；只保留状态及结构。',
        enabled: app.settings?.enabled === true, realm: app.settings?.realm === 'void' ? 'void' : 'beatrice',
        adversaryEnabled: app.settings?.adversary?.enabled === true, inflight: Boolean(app.inflight),
        targetIndex: Number.isInteger(app.lastAdversaryStage?.targetIndex) ? app.lastAdversaryStage.targetIndex : null,
        failureCategory: /Stale response/.test(app.lastError ?? '') ? 'stale_guard' : /为空|空内容|结构不认识/.test(app.lastError ?? '') ? 'empty_or_unknown_response' : /JSON|envelope|schema/i.test(app.lastError ?? '') ? 'json_or_schema' : app.lastError ? 'other_failure' : null,
        stage: ({ '共享事实观察': 'facts', '剧情定位': 'locate', '原文适用性核查': 'assess', '人神对抗观察': 'compose' })[recent.at(-1)?.label] ?? 'see_recent_requests',
        recentRequests: recent, note: !recent.length ? '尚无请求记录；请先复现错误，再复制报告。记录仅保存在当前页面内存中。'
            : recent.at(-1)?.response?.shape?.finishReason === 'length' ? '最近请求输出被截断；推理文本不能作为答案。'
            : 'stage 表示最近一次 API 请求，不等同于语义校验通过。HTTP 成功后仍可能因格式或证据核查停止；请结合诊断页日志。' };
}
