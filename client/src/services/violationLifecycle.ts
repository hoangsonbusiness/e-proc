export interface ClientViolationLifecycle {
  started: boolean;
  locked: boolean;
  submitting: boolean;
  submitCommitted: boolean;
}

/**
 * `recording_stopped` is special while submit is pending: the submit request can
 * still fail, so dropping the event would create an anti-cheat gap. All signals
 * are suppressed after the server commit is confirmed; the backend applies the
 * same terminal-state gate for requests racing across the network.
 */
export function shouldSuppressClientViolation(
  type: string,
  lifecycle: ClientViolationLifecycle,
): boolean {
  return !lifecycle.started
    || lifecycle.locked
    || lifecycle.submitCommitted
    || (lifecycle.submitting && type !== 'recording_stopped');
}

export function hasServerConfirmedTerminalSubmission(
  lifecycle: Pick<ClientViolationLifecycle, 'locked' | 'submitCommitted'>,
): boolean {
  return lifecycle.locked || lifecycle.submitCommitted;
}
