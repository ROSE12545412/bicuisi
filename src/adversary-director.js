/** Bounded private director prompt; never edits chat prose. */
export const ADVERSARY_PROMPT_KEY = 'beatrice-guide-adversary';
export function directorStatus(ctx) {
    return { supported: typeof ctx?.setExtensionPrompt === 'function', reason: typeof ctx?.setExtensionPrompt === 'function' ? '可通过酒馆扩展提示词接口安排下一轮尝试；执行结果仍由正文确认。' : '当前宿主没有 setExtensionPrompt：只能观测，不能自动安排使徒行动。' };
}
export function setDirectorPrompt(ctx, text = '') {
    if (!directorStatus(ctx).supported) return false;
    // SillyTavern extension_prompt_types.IN_CHAT = 1; extension_prompt_roles.SYSTEM = 0.
    const position = ctx.extension_prompt_types?.IN_CHAT ?? 1;
    const role = ctx.extension_prompt_roles?.SYSTEM ?? 0;
    try { ctx.setExtensionPrompt(ADVERSARY_PROMPT_KEY, String(text), position, 0, false, role); return true; }
    catch { return false; }
}
