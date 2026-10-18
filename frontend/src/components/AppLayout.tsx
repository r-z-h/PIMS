import { useMemo } from 'react';
import { Layout, Menu, Space, Tag, Tooltip, Typography, message } from 'antd';
import {
  AccountBookOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  HomeOutlined,
  LogoutOutlined,
  PayCircleOutlined,
  PieChartOutlined,
  ProjectOutlined,
  SettingOutlined,
  SwapOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import ProjectSelect from './ProjectSelect';
import DateRangeBar from './DateRangeBar';
import ProjectLockGate from './ProjectLockGate';
import { authApi } from '../api/auth';
import { USE_MOCK } from '../api/client';
import { useEnterToConfirm } from '../hooks/useEnterToConfirm';
import { useAppStore } from '../store/app';

const { Header, Sider, Content } = Layout;

const MENU_ITEMS = [
  { key: '/', icon: <HomeOutlined />, label: '首页' },
  { key: '/projects', icon: <ProjectOutlined />, label: '项目' },
  { key: '/bookkeeping', icon: <AccountBookOutlined />, label: '记账' },
  { key: '/payments', icon: <PayCircleOutlined />, label: '收/付款' },
  { key: '/costs', icon: <PieChartOutlined />, label: '成本' },
  { key: '/arap', icon: <SwapOutlined />, label: '往来' },
  { key: '/inventory', icon: <DatabaseOutlined />, label: '库存' },
  { key: '/labor-settle', icon: <TeamOutlined />, label: '结算' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
];

/** 全局布局：左侧菜单 + 顶部当前项目选择器 + 时间段选择器（位置固定） */
export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const setCurrentProjectId = useAppStore((s) => s.setCurrentProjectId);
  const dateRange = useAppStore((s) => s.dateRange);
  const setDateRange = useAppStore((s) => s.setDateRange);
  const reset = useAppStore((s) => s.reset);

  // 全局回车确认（2026-10-16 需求）：弹窗里按回车 = 点主按钮；搜索框里按回车 = 搜索
  useEnterToConfirm();

  const selectedKey = useMemo(() => {
    const path = location.pathname;
    if (path === '/') return '/';
    const matched = MENU_ITEMS.map((item) => item.key)
      .filter((key) => key !== '/' && path.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    return matched ?? '/';
  }, [location.pathname]);

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } catch {
      /* 忽略退出异常，本地状态照样清理 */
    }
    reset();
    void message.success('已退出登录');
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={180} theme="dark" breakpoint="lg" collapsedWidth={64}>
        <div className="pims-layout-logo">
          <AppstoreOutlined />
          <span>工程一体化</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header className="pims-header" style={{ height: 56, lineHeight: '56px' }}>
          <Space size={12} wrap>
            <ProjectSelect
              value={currentProjectId}
              allowAll
              allLabel="全部项目"
              style={{ minWidth: 200 }}
              onChange={(id) => setCurrentProjectId(id)}
            />
            <DateRangeBar value={dateRange} onChange={setDateRange} />
          </Space>
          <div className="pims-header-user">
            {USE_MOCK && (
              <Tooltip title="接口由 src/api/mock 本地应答；关闭 VITE_USE_MOCK 即切到真实 /api">
                <Tag color="purple">Mock 模式</Tag>
              </Tooltip>
            )}
            <Typography.Text type="secondary">
              <UserOutlined /> 老板
            </Typography.Text>
            <Typography.Link onClick={() => navigate('/settings')}>设置</Typography.Link>
            <Typography.Link onClick={handleLogout}>
              <LogoutOutlined /> 退出
            </Typography.Link>
          </div>
        </Header>
        <Content style={{ background: '#f5f5f5' }}>
          <Outlet />
        </Content>
        {/* 项目完工锁的密码闸门：所有写操作被锁时统一在这里解锁并自动重试 */}
        <ProjectLockGate />
      </Layout>
    </Layout>
  );
}
