/**
 * Accept both the legacy array and the current { blueprintMode, items } shape.
 * PostgreSQL JSONB returns an object while SQLite may return a JSON string.
 */
export function parseBlueprintCompat(raw) {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            return { blueprintMode: 'module', items: [] };
        }
    }
    if (Array.isArray(value)) {
        return { blueprintMode: 'module', items: value };
    }
    if (value && typeof value === 'object') {
        const candidate = value;
        const blueprintMode = candidate.blueprintMode === 'type' ? 'type' : 'module';
        return {
            blueprintMode,
            items: Array.isArray(candidate.items) ? candidate.items : [],
        };
    }
    return { blueprintMode: 'module', items: [] };
}
