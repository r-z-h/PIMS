import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Spin } from 'antd';
import { authApi } from './api/auth';
import { registerAuthRedirectHandlers } from './api/client';
import AppLayout from './components/AppLayout';
import { useAppStore } from './store/app';
import Dashboard from './pages/Dashboard';
import ProjectList from './pages/ProjectList';
import ProjectDetail from './pages/ProjectDetail';
import Bookkeeping from './pages/Bookkeeping';
import Payments from './pages/Payments';
import Cost from './pages/Cost';
import ArAp from './pages/ArAp';
import Inventory from './pages/Inventory';
import LaborSettle from './pages/LaborSettle';
import Settings from './pages/Settings';
import Login from './pages/Login';

/** 全局桥接：把 401/403 的跳转与「会话被拒」回调交给 react-router / store */
function RootBridge() {
  const navigate = useNavigate();
  const markSessionExpired = useAppStore((s) => s.markSessionExpired);
  useEffect(() => {
    registerAuthRedirectHandlers({
      onUnauthorized: () => navigate('/login', { replace: true }),
      onForbidden: () => navigate('/security-setup', { replace: true }),
      onSessionExpired: () => markSessionExpired(),
    });
  }, [navigate, markSessionExpired]);
  return <Outlet />;
}

/**
 * 登录 + 密保校验守卫。
 *
 * 关键约定：**未确认本机会话之前不渲染任何受保护子树**（因此也不会发出任何业务请求）。
 *
 * `GET /api/auth/status` 的 `logged_in` 语义是「**本请求**携带的 Cookie 有效」
 * （后端 `auth_service.status` 用 `session_valid(db, request.cookies[cookie_name])` 判定），
 * 所以这里直接以它为准即可：
 *   - 没有 Cookie / Cookie 失效 → logged_in=false → 去登录页，且不会发出任何业务请求；
 *   - 会话中途失效 → 首个 401 触发 sessionExpired 闩锁 → 去登录页，只弹一次提示、不重试。
 *
 * 历史坑：`logged_in` 曾经只表示「服务端存在会话」，不校验请求 Cookie，
 * 于是无 Cookie 的浏览器被告知已登录 → 渲染业务页 → 一串 401 → 弹回登录页 → 再渲染，
 * 形成死循环（实测 18 圈、54 条错误提示把登录按钮盖住）。
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const loggedIn = useAppStore((s) => s.loggedIn);
  const securityReady = useAppStore((s) => s.securityReady);
  const authLoaded = useAppStore((s) => s.authLoaded);
  const sessionExpired = useAppStore((s) => s.sessionExpired);
  const setAuth = useAppStore((s) => s.setAuth);
  const location = useLocation();
  const [checking, setChecking] = useState(!authLoaded);

  useEffect(() => {
    if (authLoaded) {
      setChecking(false);
      return;
    }
    let alive = true;
    authApi
      .status()
      .then((status) => {
        if (alive) setAuth(status);
      })
      .catch(() => {
        if (alive) setAuth({ logged_in: false, security_ready: false, is_initial_password: true });
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [authLoaded, setAuth]);

  if (checking || loggedIn === null) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!loggedIn || sessionExpired) {
    // 不记录来源页：重新登录后统一回首页（见 Login.tsx handleLogin）
    return <Navigate to="/login" replace />;
  }
  if (!securityReady && location.pathname !== '/security-setup') {
    return <Navigate to="/security-setup" replace />;
  }
  return <>{children}</>;
}

export const routes = [
  {
    element: <RootBridge />,
    children: [
      { path: '/login', element: <Login mode="login" /> },
      { path: '/security-setup', element: <Login mode="setup" /> },
      { path: '/forgot-password', element: <Login mode="forgot" /> },
      {
        path: '/',
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Dashboard /> },
          { path: 'projects', element: <ProjectList /> },
          { path: 'projects/:id', element: <ProjectDetail /> },
          { path: 'bookkeeping', element: <Bookkeeping /> },
          { path: 'payments', element: <Payments /> },
          { path: 'costs', element: <Cost /> },
          { path: 'arap', element: <ArAp /> },
          { path: 'inventory', element: <Inventory /> },
          { path: 'labor-settle', element: <LaborSettle /> },
          { path: 'settings', element: <Settings /> },
          // 旧地址兼容：改名前的 /ledger（旧「记账」）
          { path: 'ledger', element: <Navigate to="/payments" replace /> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
];

export default RequireAuth;
