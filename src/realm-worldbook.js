import { isVoid } from './mode.js';

export const RULE_BOOK = '人神对抗规则';
/** Scanner exclusions tolerate surrounding whitespace, never fuzzy names. */
export function isRuleBook(name) {
    return typeof name === 'string' && name.trim() === RULE_BOOK;
}

const SOURCES = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];

/** Runtime-only guard: no book saves, selector writes, or injected attachments. */
export function installRealmWorldbookGuard(getContext, getSettings) {
    let supported = false;
    let disposed = false;
    let source;
    let event;
    let remove;
    let error = '';
    let last = null;
    let warned = false;

    function fail(cause) {
        supported = false;
        error = String(cause?.message ?? cause);
        if (!warned) {
            warned = true;
            console.warn('[Beatrice] 人神对抗规则 runtime guard unavailable:', error);
        }
    }

    function readCurrent() {
        const context = getContext();
        if (!context) throw new Error('Host context is unavailable');
        const settings = getSettings(context);
        if (!settings) throw new Error('Current realm settings are unavailable');
        return { context, realm: isVoid(settings) ? 'void' : 'beatrice' };
    }

    function listener(payload) {
        if (disposed || !supported) return;
        let filtered = 0;
        let current;
        try {
            current = readCurrent();
            if (current.realm !== 'void') {
                // Validate the host contract before changing any array.
                for (const key of SOURCES) {
                    if (!Array.isArray(payload?.[key])) throw new Error(`Missing mutable lore array: ${key}`);
                }
                for (const key of SOURCES) {
                    const entries = payload[key];
                    for (let i = entries.length - 1; i >= 0; i--) {
                        // Deliberately stricter than scanner exclusions: exact attached book only.
                        if (entries[i]?.world === RULE_BOOK) {
                            entries.splice(i, 1);
                            filtered++;
                        }
                    }
                }
            }
            last = { realm: current.realm, filtered, chatId: current.context.chatId ?? null, ok: true };
        } catch (cause) {
            last = { realm: current?.realm ?? null, filtered, chatId: current?.context?.chatId ?? null, ok: false };
            fail(cause);
        }
    }

    try {
        const { context } = readCurrent();
        source = context.eventSource;
        event = context.eventTypes?.WORLDINFO_ENTRIES_LOADED;
        const register = typeof source?.makeLast === 'function' ? source.makeLast : source?.on;
        remove = typeof source?.removeListener === 'function' ? source.removeListener : source?.off;
        if (!event || typeof register !== 'function' || typeof remove !== 'function') {
            throw new Error('Host lacks removable WORLDINFO_ENTRIES_LOADED support');
        }
        register.call(source, event, listener);
        supported = true;
    } catch (cause) {
        fail(cause);
    }

    return {
        get supported() { return supported && !disposed; },
        status() {
            let realm = null;
            if (!disposed) {
                try { realm = readCurrent().realm; } catch (cause) { fail(cause); }
            }
            return {
                supported: supported && !disposed,
                active: supported && !disposed && realm === 'beatrice',
                realm,
                filtered: last?.filtered ?? 0,
                last: last ? { ...last } : null,
                error,
            };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            supported = false;
            if (source && event && typeof remove === 'function') {
                try { remove.call(source, event, listener); } catch (cause) { fail(cause); }
            }
        },
    };
}
