/** Character setting provenance, not volatile host bookkeeping.
 * Chat/card identity is guarded separately by each caller. saveChat updates
 * date_last_chat even when no character setting has been edited.
 */
const FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'system_prompt', 'post_history_instructions', 'alternate_greetings', 'character_book', 'talkativeness'];
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
}
export function characterSourceStamp(ctx) {
    const character = ctx?.characters?.[ctx?.characterId];
    if (!character) return JSON.stringify([ctx?.characterId ?? null, ctx?.name2 ?? '']);
    const data = character.data ?? {};
    const selected = { avatar: character.avatar ?? null };
    // Keep both forms: hosts can expose mirrored v1/v2 values during edits.
    for (const field of FIELDS) selected[field] = [character[field] ?? null, data[field] ?? null];
    const extensions = data.extensions ?? {};
    selected.extensions = {
        world: extensions.world ?? null, depth_prompt: extensions.depth_prompt ?? null,
        group_only_greetings: extensions.group_only_greetings ?? null,
    };
    return JSON.stringify(canonical(selected));
}
