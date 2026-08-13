export const BLOCK_REASONS = [
  'timeout',
  'absent_too_long',
  'submitted',
  'concurrent_session',
] as const;

export type BlockReason = (typeof BLOCK_REASONS)[number];

export interface BlockReasonMessage {
  icon: string;
  title: string;
  message: string;
}

const BLOCK_REASON_SET = new Set<string>(BLOCK_REASONS);

export const BLOCK_REASON_MESSAGES: Record<BlockReason, BlockReasonMessage> = {
  timeout: {
    icon: '⏰',
    title: 'Time\'s Up',
    message: 'Your exam time has expired. Your answers have been automatically submitted.',
  },
  absent_too_long: {
    icon: '🚫',
    title: 'Session Expired',
    message: 'You were absent for more than 2 minutes. Your exam has been automatically submitted to prevent cheating.',
  },
  submitted: {
    icon: '✅',
    title: 'Exam Already Submitted',
    message: 'Your exam has already been submitted. You cannot re-enter the exam.',
  },
  concurrent_session: {
    icon: '🛡️',
    title: 'Concurrent Session Detected',
    message: 'Your exam has been automatically submitted because simultaneous exam activity was detected from another session.',
  },
};

/**
 * The API response is untrusted runtime data. Keep the UI on a known, safe
 * screen if an older/newer backend returns a missing or unsupported reason.
 */
export function normalizeBlockReason(reason: unknown): BlockReason {
  return typeof reason === 'string' && BLOCK_REASON_SET.has(reason)
    ? reason as BlockReason
    : 'submitted';
}

export function getBlockReasonMessage(reason: unknown): BlockReasonMessage {
  return BLOCK_REASON_MESSAGES[normalizeBlockReason(reason)];
}
