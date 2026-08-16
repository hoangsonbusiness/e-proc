import type { ComponentType } from 'react';

type RouteModule = { default: ComponentType<any> };

export const adminRouteLoaders: Record<string, () => Promise<RouteModule>> = {
  '/admin/dashboard': () => import('../pages/AdminDashboard'),
  '/admin/questions': () => import('../pages/QuestionBank'),
  '/admin/batches': () => import('../pages/BatchManagement'),
  '/admin/settings': () => import('../pages/AISettings'),
  '/admin/users': () => import('../pages/UserManagement'),
};

export function prefetchAdminRoute(path: string): void {
  void adminRouteLoaders[path]?.();
}
