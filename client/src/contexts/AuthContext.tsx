import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { adminApi } from '../services/api';

interface AuthContextType {
  token: string | null;
  role: string | null;
  userId: number | null;
  isAdmin: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session từ localStorage khi app mount
  useEffect(() => {
    const stored = localStorage.getItem('adminToken');
    const expiresAt = localStorage.getItem('adminTokenExpiry');

    if (stored && expiresAt) {
      // Kiểm tra token có còn hạn không
      if (new Date(expiresAt) > new Date()) {
        setToken(stored);
        setRole(localStorage.getItem('adminRole'));
        const storedUserId = localStorage.getItem('adminUserId');
        setUserId(storedUserId ? parseInt(storedUserId) : null);
      } else {
        // Token đã hết hạn — xóa đi
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminTokenExpiry');
        localStorage.removeItem('adminRole');
        localStorage.removeItem('adminUserId');
      }
    }
    setIsLoading(false);
  }, []);

  const login = async (username: string, password: string) => {
    const res = await adminApi.login(username, password);
    const { token: newToken, expiresAt, role: newRole, userId: newUserId } = res.data;

    localStorage.setItem('adminToken', newToken);
    localStorage.setItem('adminTokenExpiry', expiresAt);
    localStorage.setItem('adminRole', newRole || 'admin');
    if (newUserId !== undefined && newUserId !== null) {
      localStorage.setItem('adminUserId', String(newUserId));
    }
    setToken(newToken);
    setRole(newRole || 'admin');
    setUserId(newUserId ?? null);
  };

  const logout = () => {
    adminApi.logout().catch(() => {}); // Fire and forget
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminTokenExpiry');
    localStorage.removeItem('adminRole');
    localStorage.removeItem('adminUserId');
    setToken(null);
    setRole(null);
    setUserId(null);
  };

  return (
    <AuthContext.Provider
      value={{
        token,
        role,
        userId,
        isAdmin: role === 'admin',
        isAuthenticated: !!token,
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
