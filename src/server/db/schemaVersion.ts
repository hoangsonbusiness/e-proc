// Transitional compatibility: release code works against the pre-cleanup schema (v1)
// and the legacy-free schema (v2). Fresh/local bootstrap always records v2.
export const MINIMUM_SCHEMA_VERSION = 1;
export const BOOTSTRAP_SCHEMA_VERSION = 2;

export function isSupportedSchemaVersion(version: number | null): boolean {
  return version !== null && Number.isInteger(version) && version >= MINIMUM_SCHEMA_VERSION;
}
