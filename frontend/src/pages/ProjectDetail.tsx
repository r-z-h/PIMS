import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Progress, Space, Table, Tag, Typography } from 'antd';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  ReloadOutlined,
  StopOutlined,
  UndoOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useNavigate, useParams } from 'react-router-dom';
import DataTable from '../components/DataTable';
import EllipsisText from '../components/EllipsisText';
import MoneyText from '../components/MoneyText';
import PageToolbar from '../components/PageToolbar';
import ProjectFormDrawer, { confirmDeleteProject } from '../components/ProjectFormDrawer';
import {
  ProjectLockBanner,
  ProjectLockedHint,
  ProjectLockTag,
  useProjectLockActions,
} from '../components/ProjectLockActions';
import { inventoryApi } from '../api/inventory';
import { laborApi } from '../api/labor';
import { normalizeMembers, projectApi } from '../api/projects';
import { useDateRange } from '../hooks/useDateRange';
import { useAppStore } from '../store/app';
import type {
  CostType,
  InventoryBalance,
  LaborSettle,
  ProjectOverview,
} from '../types';
import { addMoney, fmtQty, isNegative, toScaled } from '../utils/money';
import { COST_TYPES, COST_TYPE_LABEL, PROJECT_STATUS_LABEL, SETTLE_STATUS_LABEL } from '../utils/enums';

const { Text, Title } = Typography;

const COST_COLOR: Record<CostType, string> = {
  labor: '#1677ff',
  material: '#13c2c2',
  machine: '#722ed1',
  misc: '#fa8c16',
  advance: '#eb2f96',
};

/** 汇总表的分组标题行 */
interface SectionRow {
  kind: 'section';
  key: string;
  label: string;
}
/** 汇总表的指标行 */
interface MetricRow {
  kind: 'metric';
  key: string;
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
}
type SummaryRow = SectionRow | MetricRow;

/**
 * 项目详情：一张一览表看完这个项目的全部内容（需求第 5 条）。
 *
 * 取值一律走 `??` 兜底 / 可选链，**不要**直接写 `overview.funds.total_in` 这类链式访问：
 * 数据尚未加载完时 overview 为 null，会整页白屏
 * （用户实测报过 `Cannot read properties of undefined (reading 'total_in')`）。
 */
export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const navigate = useNavigate();
  const { dateRange, setDateRange } = useDateRange();
  /** 顶部「当前项目」选择器与全局 store 是同一份状态 */
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const setCurrentProjectId = useAppStore((s) => s.setCurrentProjectId);

  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [settles, setSettles] = useState<LaborSettle[]>([]);
  /** 需求（2026-10-16）：详情页直接改项目 */
  const [editOpen, setEditOpen] = useState(false);

  /**
   * 双向联动（2026-10-17 用户反馈「在顶部切换项目，详情页不跟着变」）。
   *
   * ① **URL 是准**：进详情 / URL 变了 → 把顶部选择器同步成本项目，
   *    否则出现"顶部显示 A、页面是 B"的错位。
   * ② **顶部切换 → 页面跟着跳**：在顶部选了别的项目，就跳到那个项目的详情。
   *
   * 坑（踩过一次）：两个 effect 会互相触发 —— ① 改 store 会让 ② 看到"store 变了"，
   * 于是又按旧的 store 值把 URL 跳回去，表现就是"切了项目又被弹回原项目"。
   * 所以用 `syncingFromUrl` 标记把「① 同步引起的变化」和「用户主动切换」区分开。
   */
  const syncingFromUrl = useRef(false);

  useEffect(() => {
    if (projectId && currentProjectId !== projectId) {
      syncingFromUrl.current = true;
      setCurrentProjectId(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const skipFirstSwitch = useRef(true);
  useEffect(() => {
    if (skipFirstSwitch.current) {
      skipFirstSwitch.current = false;
      return;
    }
    // 这次 store 变化是 ① 同步出来的，不是用户切换 → 不跳
    if (syncingFromUrl.current) {
      syncingFromUrl.current = false;
      return;
    }
    // 选「全部项目」时不强制跳走（用户可能只是想清掉选择，页面留在原地更安全）
    if (!currentProjectId || !projectId) return;
    if (currentProjectId !== projectId) {
      navigate(`/projects/${currentProjectId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  /** 完工锁（2026-10-17）：完工 / 撤销完工 / 解锁 / 重新锁定 */
  const lockActions = useProjectLockActions(() => {
    void load();
  });

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await projectApi.detail(projectId, {
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
      });
      setOverview(data);
    } finally {
      setLoading(false);
    }
  }, [projectId, dateRange.start_date, dateRange.end_date]);

  const loadRelated = useCallback(async () => {
    if (!projectId) return;
    const [inventory, settleList] = await Promise.all([
      inventoryApi.balances(projectId).catch(() => [] as InventoryBalance[]),
      laborApi
        .settles({ project_id: projectId, page: 1, page_size: 200 })
        .catch(() => ({ items: [] as LaborSettle[] })),
    ]);
    setBalances(inventory);
    setSettles(settleList.items ?? []);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadRelated();
  }, [loadRelated]);

  /* ---------- 取值：全部走受保护的取数函数 ---------- */
  const project = overview?.project;
  const metrics = overview?.metrics;
  const costByType = overview?.cost_by_type ?? {};
  const funds = overview?.funds;
  const arAp = overview?.ar_ap;

  const costRows = useMemo(
    () =>
      COST_TYPES.map((type) => ({
        type,
        label: COST_TYPE_LABEL[type],
        amount: Number(costByType[type] ?? 0),
      })),
    [costByType],
  );

  const costTotal = useMemo(() => addMoney(...costRows.map((r) => r.amount)), [costRows]);

  const inventoryQty = useMemo(
    () => balances.reduce((sum, row) => sum + Number(row.balance ?? 0), 0),
    [balances],
  );

  const usageRate = Number(metrics?.budget_usage_rate ?? 0);
  const actualCost = Number(metrics?.actual_cost ?? 0);
  const settleProfit = Number(metrics?.settle_profit ?? 0);

  const pieOption = useMemo(
    () => ({
      tooltip: { trigger: 'item', valueFormatter: (value: number) => `${Number(value).toFixed(2)} 元` },
      legend: { bottom: 0 },
      series: [
        {
          name: '五类成本构成',
          type: 'pie',
          radius: ['40%', '65%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: '#fff', borderWidth: 1 },
          label: { formatter: '{b}\n{d}%' },
          data: costRows
            .filter((r) => r.amount > 0)
            .map((r) => ({ name: r.label, value: r.amount, itemStyle: { color: COST_COLOR[r.type] } })),
        },
      ],
    }),
    [costRows],
  );

  /* ---------- 一览汇总表的行 ---------- */
  const summaryRows = useMemo<SummaryRow[]>(() => {
    const rows: SummaryRow[] = [];

    rows.push({ kind: 'section', key: 's-info', label: '项目信息' });
    rows.push({
      kind: 'metric',
      key: 'name',
      label: '项目名称',
      value: project?.name || '-',
      note: project ? PROJECT_STATUS_LABEL[project.status] : undefined,
    });
    rows.push({ kind: 'metric', key: 'client', label: '甲方（业主）', value: project?.client_name || '-' });
    rows.push({
      kind: 'metric',
      key: 'location',
      label: '地点',
      value: <EllipsisText value={project?.location} maxChars={20} modalTitle="地点" />,
    });
    rows.push({ kind: 'metric', key: 'manager', label: '负责人', value: project?.manager || '-' });
    rows.push({ kind: 'metric', key: 'start', label: '开工日期', value: project?.start_date || '-' });
    rows.push({
      kind: 'metric',
      key: 'members',
      label: '成员名单',
      value: <EllipsisText value={normalizeMembers(project?.members).join('、')} maxChars={28} modalTitle="成员名单" />,
    });
    rows.push({
      kind: 'metric',
      key: 'remark',
      label: '备注',
      value: <EllipsisText value={project?.remark} maxChars={28} modalTitle="备注" />,
    });

    rows.push({ kind: 'section', key: 's-budget', label: '预算与利润' });
    rows.push({
      kind: 'metric',
      key: 'client_budget',
      label: '甲方预算（合同额）',
      value: <MoneyText value={project?.client_budget ?? 0} />,
    });
    rows.push({
      kind: 'metric',
      key: 'cost_budget',
      label: '我方成本预算',
      value: <MoneyText value={project?.cost_budget ?? 0} />,
    });
    rows.push({
      kind: 'metric',
      key: 'actual_cost',
      label: '实际成本（五类之和）',
      value: <MoneyText value={actualCost} />,
    });
    rows.push({
      kind: 'metric',
      key: 'expect_profit',
      label: '预计利润',
      value: <MoneyText value={metrics?.expect_profit ?? 0} bold />,
      note: '甲方预算 − 我方成本预算',
    });
    rows.push({
      kind: 'metric',
      key: 'settle_profit',
      label: '结算利润',
      value: <MoneyText value={settleProfit} bold />,
      note: '甲方预算 − 实际成本',
    });
    rows.push({
      kind: 'metric',
      key: 'budget_left',
      label: '成本预算余额',
      value: <MoneyText value={metrics?.budget_left ?? 0} />,
      note: '我方成本预算 − 实际成本',
    });
    rows.push({
      kind: 'metric',
      key: 'usage',
      label: '预算使用率',
      value: (
        <Space size={6}>
          <Text strong>{usageRate.toFixed(2)}%</Text>
          {usageRate > 100 && <Tag color="red">已超成本预算</Tag>}
        </Space>
      ),
      note: '实际成本 ÷ 我方成本预算（辅助指标，不参与利润）',
    });

    rows.push({ kind: 'section', key: 's-cost', label: '实际成本明细（五类）' });
    costRows.forEach((row) => {
      rows.push({
        kind: 'metric',
        key: `cost-${row.type}`,
        label: row.label,
        value: <MoneyText value={row.amount} />,
        note: toScaled(costTotal, 2) > 0 ? `占 ${((row.amount / costTotal) * 100).toFixed(2)}%` : '-',
      });
    });
    rows.push({
      kind: 'metric',
      key: 'cost-total',
      label: '合计',
      value: <MoneyText value={costTotal} bold />,
    });

    rows.push({ kind: 'section', key: 's-funds', label: '资金收付' });
    rows.push({
      kind: 'metric',
      key: 'total_in',
      label: '已收',
      value: <MoneyText value={funds?.total_in ?? 0} colorPositive />,
    });
    rows.push({
      kind: 'metric',
      key: 'total_out',
      label: '已付',
      value: <MoneyText value={funds?.total_out ?? 0} />,
    });
    rows.push({
      kind: 'metric',
      key: 'net',
      label: '收付净额',
      value: <MoneyText value={addMoney(funds?.total_in ?? 0, -(funds?.total_out ?? 0))} />,
      note: '仅反映钱的进出，不影响利润',
    });

    rows.push({ kind: 'section', key: 's-arap', label: '该收该付' });
    rows.push({
      kind: 'metric',
      key: 'receivable_unsettled',
      label: '该收未收',
      value: <MoneyText value={arAp?.receivable_unsettled ?? 0} />,
    });
    rows.push({
      kind: 'metric',
      key: 'payable_unsettled',
      label: '该付未付',
      value: <MoneyText value={arAp?.payable_unsettled ?? 0} />,
    });

    rows.push({ kind: 'section', key: 's-inv', label: '库存与人工' });
    rows.push({
      kind: 'metric',
      key: 'inventory',
      label: '库存余量',
      value: balances.length ? `${balances.length} 种材料，合计 ${fmtQty(inventoryQty)}` : '暂无库存记录',
    });
    rows.push({
      kind: 'metric',
      key: 'settle',
      label: '人工结算',
      value: settles.length
        ? `${settles.length} 人已生成结算单，应发合计 ${fmtQty(addMoney(...settles.map((s) => Number(s.amount_due ?? 0))), 2)}`
        : '暂无人工结算单',
    });

    return rows;
  }, [
    project, metrics, costRows, costTotal, funds, arAp,
    balances, settles, inventoryQty, usageRate, actualCost, settleProfit,
  ]);

  const summaryColumns = [
    {
      title: '项目',
      dataIndex: 'label',
      width: 200,
      render: (_: unknown, row: SummaryRow) =>
        row.kind === 'section' ? (
          <Text strong>{row.label}</Text>
        ) : (
          <Text type="secondary">{row.label}</Text>
        ),
    },
    {
      title: '内容',
      dataIndex: 'value',
      render: (_: unknown, row: SummaryRow) => (row.kind === 'section' ? '' : row.value),
    },
    {
      title: '说明',
      dataIndex: 'note',
      width: 260,
      render: (_: unknown, row: SummaryRow) =>
        row.kind === 'section' ? '' : <Text type="secondary">{row.note ?? ''}</Text>,
    },
  ];

  const settleColumns = [
    { title: '姓名', dataIndex: 'worker_name', width: 100 },
    { title: '总工天', dataIndex: 'total_days', width: 90, align: 'right' as const },
    {
      title: '应发金额',
      dataIndex: 'amount_due',
      width: 120,
      align: 'right' as const,
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '已发',
      dataIndex: 'paid_amount',
      width: 120,
      align: 'right' as const,
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '未发',
      key: 'unpaid',
      width: 120,
      align: 'right' as const,
      render: (_: unknown, row: LaborSettle) => (
        <MoneyText value={addMoney(row.amount_due, -Number(row.paid_amount ?? 0))} />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (value: LaborSettle['status']) => (
        <Tag color={value === 'paid' ? 'green' : value === 'partial' ? 'orange' : 'default'}>
          {SETTLE_STATUS_LABEL[value]}
        </Tag>
      ),
    },
  ];

  if (!overview && !loading) {
    return (
      <div className="pims-page">
        <div className="pims-page-body">
          <Alert type="warning" showIcon message="项目不存在或已删除" />
        </div>
      </div>
    );
  }

  return (
    <div className="pims-page">
      <PageToolbar
        showDateRange
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        showExport
        exportProjectId={projectId}
        actions={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/projects')}>
              返回项目档案
            </Button>
            {/* 需求（2026-10-16）：详情页要能直接改和删，不用回列表 */}
            <Button
              icon={<EditOutlined />}
              disabled={!project}
              onClick={() => setEditOpen(true)}
            >
              编辑
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={!project}
              onClick={() => {
                if (!project) return;
                confirmDeleteProject(project, () => navigate('/projects'));
              }}
            >
              删除
            </Button>
            {/* 完工锁（2026-10-17）：完工 / 撤销完工 / 重新锁定 */}
            {project && project.status === 'ongoing' ? (
              <Button icon={<StopOutlined />} onClick={() => lockActions.finish(project)}>
                完工
              </Button>
            ) : null}
            {project && project.status === 'finished' ? (
              <>
                <Button icon={<UndoOutlined />} onClick={() => lockActions.reopen(project)}>
                  撤销完工
                </Button>
                {project.is_locked ? (
                  <Button icon={<UnlockOutlined />} onClick={() => lockActions.unlock(project)}>
                    解锁
                  </Button>
                ) : (
                  <Button icon={<LockOutlined />} onClick={() => lockActions.lock(project)}>
                    重新锁定
                  </Button>
                )}
              </>
            ) : null}
            <Button onClick={() => navigate('/bookkeeping')}>去记账（录入成本）</Button>
            <Button onClick={() => navigate('/payments')}>去收/付款</Button>
            <Button onClick={() => navigate('/costs')}>看成本汇总</Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void load();
                void loadRelated();
              }}
              loading={loading}
            >
              刷新
            </Button>
          </>
        }
      />
      <div className="pims-page-body">
        <Card loading={loading && !overview} style={{ marginBottom: 16 }} styles={{ body: { padding: 0 } }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>
            <Space align="center" size={12} wrap>
              <Title level={4} style={{ margin: 0 }}>
                {project?.name ?? '项目详情'}
              </Title>
              {project && <ProjectLockTag project={project} />}
              <Text type="secondary" style={{ fontSize: 12 }}>
                时间段筛选只影响成本与收付类指标；预算与预计利润是项目档案属性，不随时间变化
              </Text>
            </Space>
          </div>
          {/* 完工锁：解锁中 / 已锁定 的说明条 */}
          {project ? <ProjectLockBanner project={project} onLock={() => lockActions.lock(project)} /> : null}
          {project ? <ProjectLockedHint project={project} /> : null}
          <Table<SummaryRow>
            size="small"
            rowKey={(row) => row.key}
            columns={summaryColumns}
            dataSource={summaryRows}
            pagination={false}
            onRow={(row) =>
              row.kind === 'section' ? { style: { background: '#fafafa' } } : {}
            }
          />
        </Card>

        <Card title="预算执行" style={{ marginBottom: 16 }}>
          <Space>
            <Text type="secondary">预算使用率</Text>
            <Text strong>{usageRate.toFixed(2)}%</Text>
            {usageRate > 100 && <Tag color="red">已超成本预算</Tag>}
          </Space>
          <Progress
            percent={Math.min(usageRate, 100)}
            status={usageRate > 100 ? 'exception' : 'normal'}
            showInfo={false}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            预算使用率 ＝ 实际成本 ÷ 我方成本预算（辅助指标，不参与利润）
          </Text>
          {isNegative(settleProfit) && (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 12 }}
              message="结算利润为负：实际成本已超过甲方预算，请核对成本录入"
            />
          )}
        </Card>

        <Card title="五类成本构成" style={{ marginBottom: 16 }}>
          {costTotal > 0 ? (
            <ReactECharts option={pieOption} style={{ height: 280 }} notMerge />
          ) : (
            <Empty description="暂无成本数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>

        <Card
          title="库存余量（按项目隔离）"
          style={{ marginBottom: 16 }}
          extra={
            <Button type="link" onClick={() => navigate('/inventory')}>
              管理库存（入库 / 领用）→
            </Button>
          }
          styles={{ body: { padding: 0 } }}
        >
          <DataTable<InventoryBalance>
            rowKey={(row) => `${row.material_name}|${row.unit}`}
            size="small"
            columns={[
              { title: '材料', dataIndex: 'material_name' },
              { title: '单位', dataIndex: 'unit', width: 70 },
              {
                title: '入库',
                dataIndex: 'in_qty',
                width: 100,
                align: 'right',
                render: (value: number) => fmtQty(value),
              },
              {
                title: '领用',
                dataIndex: 'out_qty',
                width: 100,
                align: 'right',
                render: (value: number) => fmtQty(value),
              },
              {
                title: '余量',
                dataIndex: 'balance',
                width: 100,
                align: 'right',
                render: (value: number) => (
                  <Text strong type={toScaled(value, 3) < 0 ? 'danger' : undefined}>
                    {fmtQty(value)}
                  </Text>
                ),
              },
            ]}
            dataSource={balances.slice(0, 8)}
            pagination={false}
            locale={{ emptyText: '该项目暂无库存记录' }}
            scroll={undefined}
          />
        </Card>

        <Card
          title="人工结算"
          extra={
            <Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                结算只汇总与发放，不重复计入成本
              </Text>
              <Button type="link" onClick={() => navigate('/labor-settle')}>
                去结算 →
              </Button>
            </Space>
          }
          styles={{ body: { padding: 0 } }}
        >
          <DataTable<LaborSettle>
            rowKey="id"
            size="small"
            columns={settleColumns}
            dataSource={settles}
            pagination={false}
            locale={{ emptyText: '该项目暂无人工结算单' }}
          />
        </Card>
      </div>

      {/* 需求（2026-10-16）：详情页直接改项目 */}
      <ProjectFormDrawer
        open={editOpen}
        project={project ?? null}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          void load();
        }}
      />

      {/* 完工锁的密码弹窗（撤销完工 / 解锁） */}
      {lockActions.passwordModal}
    </div>
  );
}
