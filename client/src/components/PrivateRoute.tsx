import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ReactNode } from 'react';

interface PrivateRouteProps {
  children: ReactNode;
  requireSuperAdmin?: boolean;
}

function PrivateRoute({ children, requireSuperAdmin = false }: PrivateRouteProps) {
  const { isAuthenticated, isSuperAdmin, isLoading } = useAuth();

  // Chờ AuthContext kiểm tra localStorage xong trước khi redirect
  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: 'var(--text-light, #6b7280)'
      }}>
        <span>Loading...</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/admin" replace />;
  }

  if (requireSuperAdmin && !isSuperAdmin) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  return <>{children}</>;
}

export default PrivateRoute;
