export type BlueprintMode = 'module' | 'type';

export interface BlueprintItem {
  module: string;
  type?: string;
  easy?: number;
  medium?: number;
  hard?: number;
}

export interface ParsedBlueprint {
  blueprintMode: BlueprintMode;
  items: BlueprintItem[];
}

/**
 * Accept both the legacy array and the current { blueprintMode, items } shape.
 * PostgreSQL JSONB returns an object while SQLite may return a JSON string.
 */
export function parseBlueprintCompat(raw: unknown): ParsedBlueprint {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { blueprintMode: 'module', items: [] };
    }
  }

  if (Array.isArray(value)) {
    return { blueprintMode: 'module', items: value as BlueprintItem[] };
  }

  if (value && typeof value === 'object') {
    const candidate = value as { blueprintMode?: unknown; items?: unknown };
    const blueprintMode: BlueprintMode = candidate.blueprintMode === 'type' ? 'type' : 'module';
    return {
      blueprintMode,
      items: Array.isArray(candidate.items) ? candidate.items as BlueprintItem[] : [],
    };
  }

  return { blueprintMode: 'module', items: [] };
}
