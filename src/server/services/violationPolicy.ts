export const CLIENT_REPORTABLE_VIOLATION_TYPES = [
  'tab_switch',
  'fullscreen_exit',
  'copy_attempt',
  'cut_attempt',
  'paste_attempt',
  'devtools_open',
  'view_source',
  'extension_panel',
  'screenshot_attempt',
  'print_attempt',
  'suspicious_paste',
  'focus_lost',
  'recording_stopped',
  'rapid_text_insertion',
  'multiple_display_detected',
] as const;

// These types represent conclusions reached from trusted server-side evidence.
// They must never be accepted as facts merely because a client posts their name.
export const SERVER_OWNED_VIOLATION_TYPES = ['concurrent_session'] as const;

export type ClientReportableViolationType = (typeof CLIENT_REPORTABLE_VIOLATION_TYPES)[number];
export type ServerOwnedViolationType = (typeof SERVER_OWNED_VIOLATION_TYPES)[number];
export type ViolationType = ClientReportableViolationType | ServerOwnedViolationType;

const CLIENT_REPORTABLE_TYPE_SET = new Set<string>(CLIENT_REPORTABLE_VIOLATION_TYPES);
const SERVER_OWNED_TYPE_SET = new Set<string>(SERVER_OWNED_VIOLATION_TYPES);

export function isClientReportableViolation(type: unknown): type is ClientReportableViolationType {
  return typeof type === 'string' && CLIENT_REPORTABLE_TYPE_SET.has(type);
}

export function isServerOwnedViolation(type: unknown): type is ServerOwnedViolationType {
  return typeof type === 'string' && SERVER_OWNED_TYPE_SET.has(type);
}
