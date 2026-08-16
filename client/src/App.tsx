import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import PrivateRoute from './components/PrivateRoute';
import { adminRouteLoaders } from './services/adminRouteLoaders';

const AdminLogin = lazy(() => import('./pages/AdminLogin'));
const AdminSetup = lazy(() => import('./pages/AdminSetup'));
const AdminDashboard = lazy(adminRouteLoaders['/admin/dashboard']);
const QuestionBank = lazy(adminRouteLoaders['/admin/questions']);
const QuestionEdit = lazy(() => import('./pages/QuestionEdit'));
const BatchManagement = lazy(adminRouteLoaders['/admin/batches']);
const StudentManagement = lazy(() => import('./pages/StudentManagement'));
const Results = lazy(() => import('./pages/Results'));
const AISettings = lazy(adminRouteLoaders['/admin/settings']);
const UserManagement = lazy(adminRouteLoaders['/admin/users']);
const StudentLogin = lazy(() => import('./pages/StudentLogin'));
const StudentExam = lazy(() => import('./pages/StudentExam'));
const StudentConfirm = lazy(() => import('./pages/StudentConfirm'));
const StudentSubmit = lazy(() => import('./pages/StudentSubmit'));

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500">
      <div className="flex items-center gap-3" role="status" aria-live="polite">
        <span className="h-5 w-5 rounded-full border-2 border-slate-300 border-t-blue-600 animate-spin" />
        <span className="text-sm font-medium">Loading page...</span>
      </div>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Student routes */}
          <Route path="/" element={<StudentLogin />} />
          <Route path="/confirm" element={<StudentConfirm />} />
          <Route path="/exam" element={<StudentExam />} />
          <Route path="/submit" element={<StudentSubmit />} />

          {/* Admin public routes */}
          <Route path="/admin" element={<AdminLogin />} />
          <Route path="/admin/setup" element={<AdminSetup />} />

          {/* Admin protected routes */}
          <Route path="/admin/dashboard" element={<PrivateRoute><AdminDashboard /></PrivateRoute>} />
          <Route path="/admin/questions" element={<PrivateRoute><QuestionBank /></PrivateRoute>} />
          <Route path="/admin/questions/new" element={<PrivateRoute><QuestionEdit /></PrivateRoute>} />
          <Route path="/admin/questions/:id/edit" element={<PrivateRoute><QuestionEdit /></PrivateRoute>} />
          <Route path="/admin/batches" element={<PrivateRoute><BatchManagement /></PrivateRoute>} />
          <Route path="/admin/batches/:id/students" element={<PrivateRoute><StudentManagement /></PrivateRoute>} />
          <Route path="/admin/batches/:id/results" element={<PrivateRoute><Results /></PrivateRoute>} />
          <Route path="/admin/settings" element={<PrivateRoute><AISettings /></PrivateRoute>} />
          <Route path="/admin/users" element={<PrivateRoute><UserManagement /></PrivateRoute>} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}

export default App;
