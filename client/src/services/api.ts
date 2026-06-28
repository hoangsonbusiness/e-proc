import axios from 'axios';

const API_BASE = '/api';

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true
});

export const adminApi = {
  importQuestions: (formData: FormData) =>
    api.post('/admin/questions/import', formData),
  
  getQuestions: () =>
    api.get('/admin/questions'),
  
  getModules: () =>
    api.get('/admin/questions/modules'),
  
  getModuleStats: () =>
    api.get('/admin/questions/module-stats'),
  
  deleteQuestion: (id: string) =>
    api.delete(`/admin/questions/${id}`),
  
  deleteQuestions: (ids: string[]) =>
    api.post('/admin/questions/bulk-delete', { ids }),
  
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
  
  importStudents: (batchId: number, emails: string[]) =>
    api.post(`/admin/batches/${batchId}/students/import`, { emails }),
  
getStudents: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/students`),
  
  deleteStudent: (studentId: number) =>
    api.delete(`/admin/students/${studentId}`),
  
  exportStudents: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/students/export`, { responseType: 'blob' }),
  
  getResults: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/results`),
  
  updateResult: (studentId: number, data: any) =>
    api.put(`/admin/results/${studentId}`, data),
  
  exportResults: (batchId: number) =>
    api.get(`/admin/batches/${batchId}/results/export`, { responseType: 'blob' }),

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
    api.post('/student/violation', { type }, { headers: { 'x-student-id': studentId } })
};

export default api;
