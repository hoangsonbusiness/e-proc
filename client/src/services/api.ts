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
    const token = localStorage.getItem('adminToken');
    if (token && config.url?.includes('/admin/')) {
      config.headers.Authorization = `Bearer ${token}`;
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

  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/admin/change-password', { currentPassword, newPassword }),

  // --- Question endpoints ---
  importQuestions: (formData: FormData) =>
    api.post('/admin/questions/import', formData),
  
  getQuestions: () =>
    api.get('/admin/questions'),
  
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
  
  exportStudents: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/students/export`, { responseType: 'blob' }),
  
  // --- Results endpoints ---
  getResults: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/results`),
  
  updateResult: (studentId: number, data: any) =>
    api.put(`/admin/results/${studentId}`, data),
  
  exportResults: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/results/export`, { responseType: 'blob' }),

  // --- AI Settings endpoints ---
  getAISettings: () =>
    api.get('/admin/settings/ai'),
  
  saveAISettings: (settings: any) =>
    api.post('/admin/settings/ai', settings),
  
  testAI: (settings: any) =>
    api.post('/admin/settings/ai/test', settings)
};

export const studentApi = {
  verify: (accessCode: string) =>
    api.post('/student/verify', { access_code: accessCode }),
  
  selectEmail: (studentId: number, email: string) =>
    api.post('/student/select-email', { student_id: studentId, email }),
  
  startExam: (studentId: number) =>
    api.post('/student/exam/start', { student_id: studentId }),
  
  getQuestions: (studentId: number) =>
    api.get('/student/exam/questions', { headers: { 'x-student-id': studentId } }),
  
  saveAnswer: (studentId: number, questionOrder: number, answer: string) =>
    api.post('/student/exam/answer', { question_order: questionOrder, answer }, 
      { headers: { 'x-student-id': studentId } }),
  
  submit: (studentId: number) =>
    api.post('/student/exam/submit', {}, { headers: { 'x-student-id': studentId } }),
  
  reportViolation: (studentId: number, type: string) =>
    api.post('/student/violation', { type }, { headers: { 'x-student-id': studentId } }),

  disconnect: (studentId: number) => {
    // Dùng sendBeacon để đảm bảo request được gửi ngay cả khi tab đóng
    const sent = navigator.sendBeacon(
      '/api/student/exam/disconnect',
      new Blob([JSON.stringify({ student_id: studentId })], { type: 'application/json' })
    );
    // Fallback bằng axios nếu sendBeacon thất bại
    if (!sent) {
      return api.post('/student/exam/disconnect', { student_id: studentId },
        { headers: { 'x-student-id': studentId } }
      );
    }
    return Promise.resolve();
  }
};

export default api;
