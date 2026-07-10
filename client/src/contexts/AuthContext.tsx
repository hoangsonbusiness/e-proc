import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { adminApi } from '../services/api';

interface AuthContextType {
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session từ localStorage khi app mount
  useEffect(() => {
    const stored = localStorage.getItem('adminToken');
    const expiresAt = localStorage.getItem('adminTokenExpiry');

    if (stored && expiresAt) {
      // Kiểm tra token có còn hạn không
      if (new Date(expiresAt) > new Date()) {
        setToken(stored);
      } else {
        // Token đã hết hạn — xóa đi
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminTokenExpiry');
      }
    }
    setIsLoading(false);
  }, []);

  const login = async (username: string, password: string) => {
    const res = await adminApi.login(username, password);
    const { token: newToken, expiresAt } = res.data;

    localStorage.setItem('adminToken', newToken);
    localStorage.setItem('adminTokenExpiry', expiresAt);
    setToken(newToken);
  };

  const logout = () => {
    adminApi.logout().catch(() => {}); // Fire and forget
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminTokenExpiry');
    setToken(null);
  };

  return (
    <AuthContext.Provider
      value={{
        token,
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
