import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import PrivateRoute from './components/PrivateRoute';
import AdminLogin from './pages/AdminLogin';
import AdminSetup from './pages/AdminSetup';
import AdminDashboard from './pages/AdminDashboard';
import QuestionBank from './pages/QuestionBank';
import BatchManagement from './pages/BatchManagement';
import StudentManagement from './pages/StudentManagement';
import Results from './pages/Results';
import AISettings from './pages/AISettings';
import StudentLogin from './pages/StudentLogin';
import StudentExam from './pages/StudentExam';
import StudentConfirm from './pages/StudentConfirm';
import StudentSubmit from './pages/StudentSubmit';

function App() {
  return (
    <AuthProvider>
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
        <Route path="/admin/batches" element={<PrivateRoute><BatchManagement /></PrivateRoute>} />
        <Route path="/admin/batches/:id/students" element={<PrivateRoute><StudentManagement /></PrivateRoute>} />
        <Route path="/admin/batches/:id/results" element={<PrivateRoute><Results /></PrivateRoute>} />
        <Route path="/admin/settings" element={<PrivateRoute><AISettings /></PrivateRoute>} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
