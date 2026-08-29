const validNumber = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
/** Blocks only when both browser-reported resources are below the batch minimum. */
export function evaluateExamEnvironment(input) {
    const ramGiB = validNumber(input.ramGiB, 0.25, 1024);
    const logicalCpuCores = validNumber(input.logicalCpuCores, 1, 1024);
    if (ramGiB === null || logicalCpuCores === null) {
        return { allowed: false, reason: 'environment_unavailable' };
    }
    if (ramGiB < 8 && logicalCpuCores < 4) {
        return { allowed: false, reason: 'insufficient_exam_environment' };
    }
    return { allowed: true, ramGiB, logicalCpuCores };
}
