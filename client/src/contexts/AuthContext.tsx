import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { adminApi } from '../services/api';

interface AuthContextType {
  token: string | null;
  role: string | null;
  isAuthenticated: boolean;
  isSuperAdmin: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session từ localStorage khi app mount
  useEffect(() => {
    const stored = localStorage.getItem('adminToken');
    const expiresAt = localStorage.getItem('adminTokenExpiry');
    const storedRole = localStorage.getItem('adminRole');

    if (stored && expiresAt) {
      // Kiểm tra token có còn hạn không
      if (new Date(expiresAt) > new Date()) {
        setToken(stored);
        setRole(storedRole);
      } else {
        // Token đã hết hạn — xóa đi
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminTokenExpiry');
        localStorage.removeItem('adminRole');
      }
    }
    setIsLoading(false);
  }, []);

  const login = async (username: string, password: string) => {
    const res = await adminApi.login(username, password);
    const { token: newToken, expiresAt, role: newRole } = res.data;

    localStorage.setItem('adminToken', newToken);
    localStorage.setItem('adminTokenExpiry', expiresAt);
    localStorage.setItem('adminRole', newRole || 'admin');
    setToken(newToken);
    setRole(newRole || 'admin');
  };

  const logout = () => {
    adminApi.logout().catch(() => {}); // Fire and forget
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminTokenExpiry');
    localStorage.removeItem('adminRole');
    setToken(null);
    setRole(null);
  };

  return (
    <AuthContext.Provider
      value={{
        token,
        role,
        isAuthenticated: !!token,
        isSuperAdmin: role === 'superadmin',
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
