import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// Thanh điều hướng admin dùng chung cho mọi trang admin.
// Link "User Management" chỉ hiện với role superadmin (admin thường không thấy).
function AdminNav() {
  const { isSuperAdmin } = useAuth();
  return (
    <div className="nav">
      <Link to="/admin/dashboard">Dashboard</Link>
      <Link to="/admin/questions">Question Bank</Link>
      <Link to="/admin/batches">Batches</Link>
      <Link to="/admin/practice">Practice</Link>
      <Link to="/admin/settings">AI Settings</Link>
      {isSuperAdmin && <Link to="/admin/users">User Management</Link>}
    </div>
  );
}

export default AdminNav;
