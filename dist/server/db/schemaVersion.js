// Schema v6 adds the independent live_enabled batch flag. This flag requires
// screen sharing for live viewing without persisting a recording.
// The runtime must not expose status/reconcile against an older schema because
// it could otherwise mistake a partial set of reservations for a complete exam.
export const MINIMUM_SCHEMA_VERSION = 6;
export const BOOTSTRAP_SCHEMA_VERSION = 6;
export function isSupportedSchemaVersion(version) {
    return version !== null && Number.isInteger(version) && version >= MINIMUM_SCHEMA_VERSION;
}
