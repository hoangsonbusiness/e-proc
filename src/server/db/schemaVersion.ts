// Schema v7 adds per-batch VMware checking and per-attempt environment audit.
// The runtime must not expose status/reconcile against an older schema because
// it could otherwise mistake a partial set of reservations for a complete exam.
export const MINIMUM_SCHEMA_VERSION = 7;
export const BOOTSTRAP_SCHEMA_VERSION = 7;

export function isSupportedSchemaVersion(version: number | null): boolean {
  return version !== null && Number.isInteger(version) && version >= MINIMUM_SCHEMA_VERSION;
}
