export const API_STAGES = [
    { id: 'facts', label: '事实观测' }, { id: 'locate', label: '剧情定位' },
    { id: 'assess', label: '原文适用性核查' }, { id: 'compose', label: '引导 / 吐槽 / 私有计划生成' },
];
const clone = v => JSON.parse(JSON.stringify(v));
export function normalizeApiConfig(value = {}) {
    const num = (v, min, max, fallback) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
    const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
    return { mode: ['custom','profile','main','tavern-helper'].includes(value.mode) ? value.mode : 'profile',
        profileId: text(value.profileId, 500), custom: { url: text(value.custom?.url, 4000), key: text(value.custom?.key, 8000), model: text(value.custom?.model, 500),
            modelList: Array.isArray(value.custom?.modelList) ? [...new Set(value.custom.modelList.filter(x => typeof x === 'string').slice(0, 500))] : [] },
        temperature: num(value.temperature,0,2,1), maxTokens: Math.floor(num(value.maxTokens,32,32768,800)),
        structuredMaxTokens: Math.floor(num(value.structuredMaxTokens,0,32768,8192)), timeoutMs: Math.floor(num(value.timeoutMs,3000,300000,45000)) };
}
export function normalizeApiPresets(settings) {
    const ids = new Set();
    settings.apiPresets = (Array.isArray(settings.apiPresets) ? settings.apiPresets : []).filter(p => p && typeof p.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(p.id) && typeof p.name === 'string' && p.name.trim() && p.llm && typeof p.llm === 'object' && !Array.isArray(p.llm)).slice(0,30).filter(p => { if(ids.has(p.id))return false;ids.add(p.id);return true; }).map(p => ({id:p.id,name:p.name.trim().slice(0,80),llm:normalizeApiConfig(p.llm)}));
    const routes = settings.apiRoutes ?? {};
    const normalizedRoutes = Object.fromEntries(API_STAGES.map(({id}) => [id, typeof routes[id] === 'string' ? routes[id].slice(0,100) : '']));
    if (routes && typeof routes === 'object' && !Array.isArray(routes)) {
        for (const key of Object.keys(routes)) if (!API_STAGES.some(s => s.id === key)) delete routes[key];
        Object.assign(routes, normalizedRoutes); settings.apiRoutes = routes;
    } else settings.apiRoutes = normalizedRoutes;
    return settings;
}
export function saveApiPreset(settings,name,id='') {
    normalizeApiPresets(settings);
    name=typeof name==='string'?name.trim().slice(0,80):'';
    if(!name)return {ok:false,error:'请填写预设名称'};
    let index=id?settings.apiPresets.findIndex(p=>p.id===id):-1;
    if(id && index<0)return {ok:false,error:'预设已不存在，请新建'};
    if(index<0 && settings.apiPresets.length>=30)return {ok:false,error:'最多保存 30 个 API 预设'};
    if(settings.apiPresets.some(p=>p.name===name && p.id!==id))return {ok:false,error:'同名预设已存在，请选择后明确更新'};
    const preset={id:id || `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`,name,llm:normalizeApiConfig(settings.llm)};
    if(index>=0)settings.apiPresets[index]=preset;else settings.apiPresets.push(preset);
    return {ok:true,preset:clone(preset)};
}
export function loadApiPreset(settings,id) {
    const p=settings.apiPresets?.find(p=>p.id===id);if(!p)return {ok:false,error:'预设不存在'};
    settings.llm=normalizeApiConfig(p.llm);return {ok:true};
}
export function deleteApiPreset(settings,id) {
    const i=settings.apiPresets?.findIndex(p=>p.id===id)??-1;if(i<0)return {ok:false,error:'预设不存在'};
    settings.apiPresets.splice(i,1);for(const stage of API_STAGES)if(settings.apiRoutes?.[stage.id]===id)settings.apiRoutes[stage.id]='';
    return {ok:true};
}
export function resolveStageLlm(settings,stage) {
    const id=settings?.apiRoutes?.[stage];
    if(!id)return clone(settings?.llm ?? {});
    const p=settings.apiPresets?.find(p=>p.id===id);
    if(!p)throw new Error(`API 阶段 ${stage} 选择的预设不存在，请在 API 设置中重新选择`);
    return clone(p.llm);
}
export function apiRoutingStamp(settings) { return JSON.stringify([settings?.llm,settings?.apiRoutes,settings?.apiPresets]); }
