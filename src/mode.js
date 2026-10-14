/** Reversible realm helpers: these never mutate either persona's settings. */
export function isVoid(settings) {
    return settings?.realm === 'void';
}

export function guideName(settings) {
    if (isVoid(settings)) return '人神';
    return String(settings?.persona?.name ?? '贝翠丝').trim() || '贝翠丝';
}

/** Resolve bundled assets relative to this module, including renamed installations. */
export function modeImageUrl(settings, kind = 'floating') {
    if (isVoid(settings)) return new URL('../assets/hitogami.jpg', import.meta.url).href;
    if (kind === 'floating') {
        const custom = String(settings?.ui?.customImageSrc ?? '').trim();
        if (custom) return custom;
        return new URL('../assets/beatrice.png', import.meta.url).href;
    }
    return new URL('../assets/guidance-avatar.jpg', import.meta.url).href;
}
