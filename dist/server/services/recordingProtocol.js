export const RECORDING_COMPLETION_PROTOCOL_VERSION = 2;
/**
 * A completion request is an acknowledgement, not an S3 existence probe.
 * Requiring an explicit versioned marker prevents a page loaded from the old
 * HeadObject-era bundle from being interpreted as a successful PUT observer
 * during a rolling deployment.
 */
export function isRecordingPutAcknowledgementPayload(value) {
    if (!value || typeof value !== 'object')
        return false;
    const payload = value;
    return payload.protocolVersion === RECORDING_COMPLETION_PROTOCOL_VERSION
        && payload.putAcknowledged === true
        && typeof payload.uploadId === 'string';
}
