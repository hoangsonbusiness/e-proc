const STUDENT_SESSION_KEYS = [
  'studentToken',
  'studentId',
  'studentEmail',
  'duration',
  'recordMode',
  'recordingPassword',
] as const;

export type StudentSessionKey = typeof STUDENT_SESSION_KEYS[number];

export function getStudentSession(key: StudentSessionKey): string | null {
  return sessionStorage.getItem(key);
}

export function setStudentSession(key: StudentSessionKey, value: string): void {
  sessionStorage.setItem(key, value);
}

export function clearStudentSession(): void {
  for (const key of STUDENT_SESSION_KEYS) {
    sessionStorage.removeItem(key);
    // Remove credentials left by pre-fix bundles; current code never reads
    // student identity from shared localStorage.
    localStorage.removeItem(key);
  }
}
