// Schema v4 seals the exact S3 recording manifest before recovery/finalization.
// The runtime must not expose status/reconcile against an older schema because
// it could otherwise mistake a partial set of reservations for a complete exam.
export const MINIMUM_SCHEMA_VERSION = 4;
export const BOOTSTRAP_SCHEMA_VERSION = 4;
export function isSupportedSchemaVersion(version) {
    return version !== null && Number.isInteger(version) && version >= MINIMUM_SCHEMA_VERSION;
}
