import axios from 'axios';

const API_BASE = '/api';

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true
});

// =============================================
// REQUEST INTERCEPTOR — Tự động gắn JWT token
// =============================================
api.interceptors.request.use(
  (config) => {
    // Admin JWT
    const adminToken = localStorage.getItem('adminToken');
    if (adminToken && config.url?.includes('/admin/')) {
      config.headers.Authorization = `Bearer ${adminToken}`;
    }
    // [C-4] Student token — gắn vào tất cả /student/ request
    const studentToken = localStorage.getItem('studentToken');
    if (studentToken && config.url?.includes('/student/')) {
      config.headers.Authorization = `Bearer ${studentToken}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// =============================================
// RESPONSE INTERCEPTOR — Auto logout khi 401
// =============================================
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 401 &&
      window.location.pathname.startsWith('/admin') &&
      !window.location.pathname.includes('/admin/login') &&
      !window.location.pathname.includes('/admin/setup')
    ) {
      localStorage.removeItem('adminToken');
      window.location.href = '/admin';
    }
    return Promise.reject(error);
  }
);

export const adminApi = {
  // --- Auth endpoints ---
  isInitialized: () =>
    api.get('/admin/is-initialized'),

  login: (username: string, password: string) =>
    api.post('/admin/login', { username, password }),

  logout: () =>
    api.post('/admin/logout').finally(() => localStorage.removeItem('adminToken')),

  setup: (username: string, password: string) =>
    api.post('/admin/setup', { username, password }),

  // Quản lý user (chỉ admin)
  getUsers: () => api.get('/admin/users'),
  createUser: (username: string, password: string, role: 'admin' | 'mod') =>
    api.post('/admin/users', { username, password, role }),
  deleteUser: (id: number) => api.delete(`/admin/users/${id}`),

  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/admin/change-password', { currentPassword, newPassword }),

  // --- Question endpoints ---
  importQuestions: (formData: FormData) =>
    api.post('/admin/questions/import', formData),

  importQuizQuestions: (formData: FormData) =>
    api.post('/admin/questions/quiz/import', formData),
  
  getQuestions: () =>
    api.get('/admin/questions'),

  getQuestion: (id: string) =>
    api.get(`/admin/questions/${encodeURIComponent(id)}`),

  checkQuestionId: (id: string) =>
    api.get('/admin/questions/check-id', { params: { id } }),

  createQuestion: (data: any) =>
    api.post('/admin/questions', data),

  updateQuestion: (id: string, data: any) =>
    api.put(`/admin/questions/${encodeURIComponent(id)}`, data),

  getPagedQuestions: (params: { page: number; pageSize: number; module?: string; category?: 'all' | 'essay' | 'quiz' }) =>
    api.get('/admin/questions/paged', { params }),

  getQuestionCatalogSummary: () =>
    api.get('/admin/questions/catalog-summary'),
  
  getModules: () =>
    api.get('/admin/questions/modules'),
  
  getModuleStats: () =>
    api.get('/admin/questions/module-stats'),
  
  getTypeStats: () =>
    api.get('/admin/questions/type-stats'),
  
  getModuleTypeStats: () =>
    api.get('/admin/questions/module-type-stats'),
  
  deleteQuestion: (id: string) =>
    api.delete(`/admin/questions/${id}`),
  
  deleteQuestions: (ids: string[]) =>
    api.post('/admin/questions/bulk-delete', { ids }),
  
  // --- Batch endpoints ---
  createBatch: (data: any) =>
    api.post('/admin/batches', data),
  
  getBatches: () =>
    api.get('/admin/batches'),
  
  getBatch: (id: number) =>
    api.get(`/admin/batches/${id}`),
  
  updateBatch: (id: number, data: any) =>
    api.put(`/admin/batches/${id}`, data),
  
  deleteBatch: (id: number) =>
    api.delete(`/admin/batches/${id}`),
  
  checkFeasibility: (id: number, blueprint: any[]) =>
    api.post(`/admin/batches/${id}/check-feasibility`, { blueprint }),
  
  // --- Student endpoints ---
  importStudents: (batchId: number, emails: string[]) =>
    api.post(`/admin/batches/${batchId}/students/import`, { emails }),
  
  getStudents: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/students`),
  
  deleteStudent: (studentId: number) =>
    api.delete(`/admin/students/${studentId}`),

  resetStudentExam: (studentId: number, durationMinutes: number) =>
    api.post(`/admin/students/${studentId}/reset`, { duration_minutes: durationMinutes }),
  
  exportStudents: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/students/export`, { responseType: 'blob' }),
  
  // --- Results endpoints ---
  getResults: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/results`),

  getResultsSummary: (batchId: number, page: number, pageSize: number) =>
    api.get(`/admin/batches/${batchId}/results/summary`, { params: { page, pageSize } }),

  getStudentResultDetail: (studentId: number) =>
    api.get(`/admin/students/${studentId}/result-detail`),
  
  updateResult: (studentId: number, data: any) =>
    api.put(`/admin/results/${studentId}`, data),
  
  exportResults: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/results/export`, { responseType: 'blob' }),

  // --- AI Settings endpoints ---
  getAISettings: () =>
    api.get('/admin/settings/ai'),
  
  saveAISettings: (settings: any) =>
    api.put('/admin/settings/ai', settings),
  
  testAI: (settings: any) =>
    api.post('/admin/settings/ai/test', settings),

  gradeBatchWithAI: (batchId: number) =>
    api.post(`/admin/batches/${batchId}/ai-grade`),

  gradeStudentWithAI: (batchId: number, studentId: number) =>
    api.post(`/admin/batches/${batchId}/students/${studentId}/ai-grade`)
};

export const studentApi = {
  verify: (accessCode: string) =>
    api.post('/student/verify', { access_code: accessCode }),

  selectEmail: (studentId: number, email: string) =>
    api.post('/student/select-email', { student_id: studentId, email }),

  startExam: (studentId: number) =>
    api.post('/student/exam/start', { student_id: studentId }),

  // [C-4] Không còn truyền studentId - token tự động gắn qua interceptor
  getQuestions: () =>
    api.get('/student/exam/questions'),

  saveAnswer: (questionOrder: number, answer: string) =>
    api.post('/student/exam/answer', { question_order: questionOrder, answer }),

  saveAnswers: (answers: Array<{ question_order: number; answer: string }>) =>
    api.post('/student/exam/answers', { answers }),

  submit: (answers: Array<{ question_order: number; answer: string }>) =>
    api.post('/student/exam/submit', { answers }),

  reportViolation: (
    type: string,
    meta?: { contentPreview?: string; textLength?: number; questionId?: string; metadata?: Record<string, number>; eventId?: string }
  ) =>
    api.post('/student/violation', {
      type,
      // [P1-1] event_id sinh MỘT LẦN ở client, giữ nguyên qua mọi retry. Backend dùng
      // unique (student_id, event_id) để idempotent: retry sau khi server đã commit không
      // đếm trùng → không khóa oan. Bắt buộc có khi retry (xem handleViolation).
      event_id: meta?.eventId,
      content_preview: meta?.contentPreview,
      text_length: meta?.textLength,
      question_id: meta?.questionId,
      metadata: meta?.metadata,
    }),

  // Xin presigned PUT URL để upload 1 phần video record thẳng lên S3
  getRecordingUploadUrl: (partIndex: number, contentType: string) =>
    api.post('/student/exam/recording-url', { partIndex, contentType }),

  completeRecordingPart: (partIndex: number, byteSize: number) =>
    api.post('/student/exam/recording-complete', { partIndex, byteSize }),

  finalizeRecording: (finalPartIndex: number) =>
    api.post('/student/exam/recording-finalize', { finalPartIndex }),

  // [C-4] sendBeacon không hỗ trợ custom headers:
  // gửi student_token trong body để studentAuthMiddleware xử lý
  disconnect: () => {
    const studentToken = localStorage.getItem('studentToken');
    const sent = navigator.sendBeacon(
      '/api/student/exam/disconnect',
      new Blob([JSON.stringify({ student_token: studentToken })], { type: 'application/json' })
    );
    // Fallback bằng axios nếu sendBeacon thất bại
    if (!sent) {
      return api.post('/student/exam/disconnect', { student_token: studentToken });
    }
    return Promise.resolve();
  },
};

export default api;
