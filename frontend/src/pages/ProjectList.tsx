import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Input, Select, Space, Typography } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  UndoOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable';
import MoneyText from '../components/MoneyText';
import PageToolbar from '../components/PageToolbar';
import ProjectFormDrawer, { confirmDeleteProject } from '../components/ProjectFormDrawer';
import { ProjectLockTag, useProjectLockActions } from '../components/ProjectLockActions';
import ProjectDateFieldSelect from '../components/ProjectDateFieldSelect';
import { dashboardApi } from '../api/dashboard';
import { projectApi } from '../api/projects';
import { useDateRange } from '../hooks/useDateRange';
import { useAppStore } from '../store/app';
import type { DashboardRow, Project } from '../types';
import { PROJECT_STATUS_LABEL, toOptions } from '../utils/enums';

const { Text } = Typography;

/**
 * 项目档案：列表 + 新建/编辑抽屉（docs/01-开发手册.md 5.3）。
 *
 * 2026-10-16 改动：去掉「详情」按钮，除操作列外**点行的任何位置都进详情**
 * （详情页里也能编辑与删除，见 ProjectDetail）。
 */
export default function ProjectList() {
  const navigate = useNavigate();
  const { dateRange } = useDateRange();

  const [rows, setRows] = useState<Project[]>([]);
  const [metrics, setMetrics] = useState<Record<number, DashboardRow>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  /** 日期按什么筛项目（开工日期 / 有业务数据），与首页共用同一个 store 值 */
  const projectDateField = useAppStore((s) => s.projectDateField);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, board] = await Promise.all([
        projectApi.list({
          page,
          page_size: pageSize,
          keyword: keyword || undefined,
          status,
          // 2026-10-17 需求：名字 + 日期都能筛项目（日期口径由下拉决定）
          start_date: dateRange.start_date,
          end_date: dateRange.end_date,
          date_field: projectDateField,
        }),
        dashboardApi.projects({
          start_date: dateRange.start_date,
          end_date: dateRange.end_date,
          date_field: projectDateField,
        }),
      ]);
      setRows(list.items ?? []);
      setTotal(list.total ?? 0);
      const map: Record<number, DashboardRow> = {};
      (board.items ?? []).forEach((item) => {
        map[item.project_id] = item;
      });
      setMetrics(map);
    } catch {
      /* 拦截器已提示 */
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, keyword, status, dateRange.start_date, dateRange.end_date, projectDateField]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setDrawerOpen(true);
  };

  const openEdit = (project: Project) => {
    setEditing(project);
    setDrawerOpen(true);
  };

  const handleDelete = (project: Project) => {
    confirmDeleteProject(project, () => {
      void load();
    });
  };

  /** 完工锁（2026-10-17）：完工 / 撤销完工 / 解锁 / 重新锁定 */
  const lockActions = useProjectLockActions(() => {
    void load();
  });

  const columns: ColumnsType<Project> = useMemo(
    () => [
      { title: '项目名称', dataIndex: 'name', width: 190, fixed: 'left' },
      { title: '甲方', dataIndex: 'client_name', width: 160, render: (v: string) => v || '-' },
      { title: '地点', dataIndex: 'location', width: 140, render: (v: string) => v || '-' },
      { title: '负责人', dataIndex: 'manager', width: 90, render: (v: string) => v || '-' },
      { title: '开工日期', dataIndex: 'start_date', width: 110, render: (v: string) => v || '-' },
      {
        title: '状态',
        dataIndex: 'status',
        width: 110,
        render: (_: unknown, row: Project) => <ProjectLockTag project={row} />,
      },
      {
        title: '甲方预算',
        dataIndex: 'client_budget',
        width: 130,
        align: 'right',
        render: (value: number) => <MoneyText value={value} />,
      },
      {
        title: '我方成本预算',
        dataIndex: 'cost_budget',
        width: 140,
        align: 'right',
        render: (value: number) => <MoneyText value={value} />,
      },
      {
        title: '预计利润',
        key: 'expect_profit',
        width: 130,
        align: 'right',
        render: (_: unknown, row) =>
          metrics[row.id] ? <MoneyText value={metrics[row.id].expect_profit} bold /> : <Text type="secondary">-</Text>,
      },
      {
        title: '实际成本',
        key: 'actual_cost',
        width: 130,
        align: 'right',
        render: (_: unknown, row) =>
          metrics[row.id] ? <MoneyText value={metrics[row.id].actual_cost} /> : <Text type="secondary">-</Text>,
      },
      {
        title: '结算利润',
        key: 'settle_profit',
        width: 130,
        align: 'right',
        render: (_: unknown, row) =>
          metrics[row.id] ? <MoneyText value={metrics[row.id].settle_profit} bold /> : <Text type="secondary">-</Text>,
      },
      {
        title: '操作',
        key: 'action',
        width: 260,
        fixed: 'right',
        render: (_: unknown, row: Project) => (
          <Space size={0}>
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
              编辑
            </Button>
            {/* 完工锁：在建 → 「完工」；完工 → 「撤销完工」/「解锁」/「重新锁定」 */}
            {row.status === 'ongoing' ? (
              <Button type="link" size="small" icon={<StopOutlined />} onClick={() => lockActions.finish(row)}>
                完工
              </Button>
            ) : (
              <>
                <Button type="link" size="small" icon={<UndoOutlined />} onClick={() => lockActions.reopen(row)}>
                  撤销完工
                </Button>
                {row.is_locked ? (
                  <Button type="link" size="small" icon={<UnlockOutlined />} onClick={() => lockActions.unlock(row)}>
                    解锁
                  </Button>
                ) : null}
              </>
            )}
            <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row)}>
              删除
            </Button>
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [metrics],
  );

  return (
    <div className="pims-page">
      <PageToolbar
        showDateRange
        dateRange={dateRange}
        showExport
        exportProjectId={null}
        extra={
          <Space size={8}>
            <Input.Search
              placeholder="搜索项目名称 / 甲方 / 负责人"
              allowClear
              style={{ width: 240 }}
              onSearch={(value) => {
                setPage(1);
                setKeyword(value.trim());
              }}
            />
            <Select
              placeholder="全部状态"
              allowClear
              style={{ width: 130 }}
              value={status}
              options={toOptions(PROJECT_STATUS_LABEL)}
              onChange={(value) => {
                setPage(1);
                setStatus(value);
              }}
            />
            {/* 日期按什么筛项目（与首页共用同一个设置） */}
            <ProjectDateFieldSelect />
          </Space>
        }
        actions={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建项目
            </Button>
          </>
        }
      />
      <div className="pims-page-body">
        <Card styles={{ body: { padding: 0 } }}>
          <DataTable<Project>
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={rows}
            total={total}
            page={page}
            pageSize={pageSize}
            onPageChange={(nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            }}
            scroll={{ x: 1700 }}
            // 需求（2026-10-16）：除操作列外，点行的任何位置都进详情
            onRow={(row) => ({
              onClick: (event) => {
                // 操作列（编辑/删除）自己处理点击，不要连带跳转
                if ((event.target as HTMLElement).closest('td:last-child')) return;
                navigate(`/projects/${row.id}`);
              },
              style: { cursor: 'pointer' },
            })}
          />
        </Card>
      </div>

      <ProjectFormDrawer
        open={drawerOpen}
        project={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          void load();
        }}
      />

      {/* 完工锁的密码弹窗（撤销完工 / 解锁） */}
      {lockActions.passwordModal}
    </div>
  );
}
