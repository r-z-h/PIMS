import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, List, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable';
import MoneyText from '../components/MoneyText';
import PageToolbar from '../components/PageToolbar';
import { dashboardApi } from '../api/dashboard';
import { useDateRange } from '../hooks/useDateRange';
import { useAppStore } from '../store/app';
import ProjectDateFieldSelect from '../components/ProjectDateFieldSelect';
import type { DashboardRow, DashboardTotal, RecentActivity } from '../types';
import { addMoney } from '../utils/money';
import { PROJECT_STATUS_LABEL } from '../utils/enums';

const { Text } = Typography;

/** 首页：项目盈亏总表（docs/01-开发手册.md 5.2） */
export default function Dashboard() {
  const navigate = useNavigate();
  const { dateRange, setDateRange } = useDateRange();
  /** 日期按什么筛项目：与项目列表共用同一个设置（2026-10-17 需求） */
  const projectDateField = useAppStore((s) => s.projectDateField);
  const [rows, setRows] = useState<DashboardRow[]>([]);
  const [total, setTotal] = useState<DashboardTotal | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<RecentActivity[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await dashboardApi.projects({
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
        date_field: projectDateField,
      });
      setRows(data.items ?? []);
      setTotal(data.total ?? null);
    } catch {
      /* 拦截器已提示 */
    } finally {
      setLoading(false);
    }
  }, [dateRange.start_date, dateRange.end_date, projectDateField]);

  const loadRecent = useCallback(async () => {
    try {
      setRecent(await dashboardApi.recent());
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  /** 合计行：优先用后端 total，缺的字段按整数分本地加总（绝不浮点累加） */
  const totalRow = useMemo<DashboardTotal>(() => {
    const fallback = {
      client_budget: addMoney(...rows.map((r) => r.client_budget)),
      cost_budget: addMoney(...rows.map((r) => r.cost_budget)),
      expect_profit: addMoney(...rows.map((r) => r.expect_profit)),
      actual_cost: addMoney(...rows.map((r) => r.actual_cost)),
      settle_profit: addMoney(...rows.map((r) => r.settle_profit)),
      budget_left: addMoney(...rows.map((r) => r.budget_left)),
      received: addMoney(...rows.map((r) => r.received)),
      unreceived: addMoney(...rows.map((r) => r.unreceived)),
      paid: addMoney(...rows.map((r) => r.paid)),
      unpaid: addMoney(...rows.map((r) => r.unpaid)),
    };
    return { ...fallback, ...(total ?? {}) };
  }, [rows, total]);

  const columns: ColumnsType<DashboardRow> = [
    {
      title: '项目',
      dataIndex: 'name',
      width: 140,
      fixed: 'left',
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{value}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            #{row.project_id}
          </Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 64,
      render: (value: DashboardRow['status']) => (
        <Tag color={value === 'finished' ? 'default' : 'processing'}>{PROJECT_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '甲方预算',
      dataIndex: 'client_budget',
      width: 96,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '我方成本预算',
      dataIndex: 'cost_budget',
      width: 100,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '预计利润',
      dataIndex: 'expect_profit',
      width: 96,
      align: 'right',
      render: (value: number) => <MoneyText value={value} bold />,
    },
    {
      title: '实际成本',
      dataIndex: 'actual_cost',
      width: 96,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '结算利润',
      dataIndex: 'settle_profit',
      width: 96,
      align: 'right',
      render: (value: number) => <MoneyText value={value} bold />,
    },
    {
      title: '成本预算余额',
      dataIndex: 'budget_left',
      width: 100,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '已收',
      dataIndex: 'received',
      width: 96,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '未收',
      dataIndex: 'unreceived',
      width: 96,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '已付',
      dataIndex: 'paid',
      width: 96,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '未付',
      dataIndex: 'unpaid',
      width: 96,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
  ];

  const summaryCells: Array<{ key: keyof DashboardTotal; align?: 'right' }> = [
    { key: 'client_budget', align: 'right' },
    { key: 'cost_budget', align: 'right' },
    { key: 'expect_profit', align: 'right' },
    { key: 'actual_cost', align: 'right' },
    { key: 'settle_profit', align: 'right' },
    { key: 'budget_left', align: 'right' },
    { key: 'received', align: 'right' },
    { key: 'unreceived', align: 'right' },
    { key: 'paid', align: 'right' },
    { key: 'unpaid', align: 'right' },
  ];

  return (
    <div className="pims-page">
      <PageToolbar
        showDateRange
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        showExport
        exportProjectId={null}
        extra={<ProjectDateFieldSelect />}
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />
      <div className="pims-page-body">
        <Card
          title="项目盈亏总表"
          extra={
            <Tooltip title="预计利润 ＝ 甲方预算 − 我方成本预算；结算利润 ＝ 甲方预算 − 实际成本（五类成本之和）">
              <Text type="secondary" style={{ fontSize: 12 }}>
                口径：利润只看合同额与成本，资金流水/应收应付不参与
              </Text>
            </Tooltip>
          }
          styles={{ body: { padding: 0 } }}
        >
          <DataTable<DashboardRow>
            rowKey="project_id"
            loading={loading}
            columns={columns}
            dataSource={rows}
            pagination={false}
            scroll={{ x: 1172 }}
            rowClassName={() => 'pims-clickable-row'}
            onRow={(row) => ({
              onClick: () => navigate(`/projects/${row.project_id}`),
            })}
            locale={{ emptyText: <Empty description="暂无项目，请先到「项目」页新建" /> }}
            summary={() => (
              <Table.Summary fixed>
                <Table.Summary.Row style={{ background: '#fafafa', fontWeight: 600 }}>
                  <Table.Summary.Cell index={0} colSpan={2}>
                    合计（{rows.length} 个项目）
                  </Table.Summary.Cell>
                  {summaryCells.map((cell, index) => (
                    <Table.Summary.Cell key={cell.key} index={index + 2} align={cell.align}>
                      <MoneyText value={totalRow[cell.key]} bold />
                    </Table.Summary.Cell>
                  ))}
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />
        </Card>

        <Card title="最近动态" style={{ marginTop: 16 }} size="small">
          {recent.length === 0 ? (
            <Empty description="暂无业务动态" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              size="small"
              dataSource={recent}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Text key="amount" strong>
                      <MoneyText value={item.amount ?? 0} />
                    </Text>,
                  ]}
                >
                  <Space size={8}>
                    <Tag>{item.biz_date || '-'}</Tag>
                    <Text>{item.title}</Text>
                  </Space>
                </List.Item>
              )}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
