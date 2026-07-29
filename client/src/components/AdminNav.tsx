import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// Thanh điều hướng admin dùng chung cho mọi trang admin.
// Link "Users" chỉ hiện với role admin (mod không thấy).
function AdminNav() {
  const { isAdmin } = useAuth();
  return (
    <div className="nav">
      <Link to="/admin/dashboard">Dashboard</Link>
      <Link to="/admin/questions">Question Bank</Link>
      <Link to="/admin/batches">Batches</Link>
      <Link to="/admin/settings">AI Settings</Link>
      {isAdmin && <Link to="/admin/users">Users</Link>}
    </div>
  );
}

export default AdminNav;
