// Schema v5 adds append-only audit rows for WebRTC live-monitor viewing.
// The runtime must not expose status/reconcile against an older schema because
// it could otherwise mistake a partial set of reservations for a complete exam.
export const MINIMUM_SCHEMA_VERSION = 5;
export const BOOTSTRAP_SCHEMA_VERSION = 5;

export function isSupportedSchemaVersion(version: number | null): boolean {
  return version !== null && Number.isInteger(version) && version >= MINIMUM_SCHEMA_VERSION;
}
