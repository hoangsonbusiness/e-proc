import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { LayoutDashboard, Database, FolderKanban, Settings, Users } from 'lucide-react';
import { prefetchAdminRoute } from '../services/adminRouteLoaders';

function AdminNav() {
  const { isAdmin } = useAuth();
  const location = useLocation();

  const navItems = [
    { path: '/admin/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/admin/questions', label: 'Question Bank', icon: Database },
    { path: '/admin/batches', label: 'Batches', icon: FolderKanban },
    { path: '/admin/settings', label: 'AI Settings', icon: Settings },
  ];

  if (isAdmin) {
    navItems.push({ path: '/admin/users', label: 'Users', icon: Users });
  }

  return (
    <div className="flex flex-wrap gap-2 mb-6 bg-slate-100/80 p-1.5 rounded-xl border border-slate-200/60 shadow-inner">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = location.pathname.startsWith(item.path);
        
        return (
          <Link
            key={item.path}
            to={item.path}
            onMouseEnter={() => prefetchAdminRoute(item.path)}
            onFocus={() => prefetchAdminRoute(item.path)}
            className={`
              flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-all
              ${isActive 
                ? 'bg-white text-blue-700 shadow-sm ring-1 ring-slate-200/50' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }
            `}
          >
            <Icon size={16} className={isActive ? "text-blue-600" : "text-slate-400"} />
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

export default AdminNav;
