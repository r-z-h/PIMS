import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Result,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { ColumnsType } from 'antd/es/table';
import DataTable from '../components/DataTable';
import MoneyText from '../components/MoneyText';
import PageToolbar from '../components/PageToolbar';
import { queryApi, type QueryBlock, type QueryColumn, type QueryRow, type QueryTypeInfo } from '../api/query';
import { useAppStore } from '../store/app';
import { useDateRange } from '../hooks/useDateRange';
import { ARAP_STATUS_LABEL } from '../utils/enums';
import { fmtMoney, toScaled } from '../utils/money';
import type { Money } from '../types';

const { Text } = Typography;

/** 查询编码 → 结果块的跳转目标（点卡片右上角「去处理」用） */
const LINK_BY_TYPE: Record<string, { path: string; label: string }> = {
  labor_unsettled: { path: '/labor-settle', label: '去结算' },
  arap_unsettled: { path: '/arap', label: '看往来' },
  cost_budget: { path: '/costs', label: '看成本' },
};

/** 金额/百分比等右对齐的列类型 */
const ALIGN_RIGHT = new Set(['money', 'qty', 'percent']);

/** 金额转整数分做比较（禁止浮点比较，与本项目前端金额规范一致） */
const cents = (value: unknown): number => toScaled(value as Money, 2);

// --------------------------------------------------------------------------- 单元格渲染

function renderCell(column: QueryColumn, value: QueryRow[string]) {
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: '#bfbfbf' }}>—</span>;
  }
  switch (column.type) {
    case 'money':
      return <MoneyText value={value as Money} />;
    case 'percent':
      return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(value as Money)}%</span>;
    case 'qty':
      return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{String(value)}</span>;
    case 'status': {
      const raw = String(value);
      const label = (ARAP_STATUS_LABEL as Record<string, string>)[raw] ?? raw;
      const color = raw === 'closed' ? 'green' : raw === 'partial' ? 'orange' : 'red';
      return <Tag color={color}>{label}</Tag>;
    }
    default:
      return <span>{String(value)}</span>;
  }
}

/**
 * 列定义 → antd 列。
 *
 * **排序由后端做**（`query_service` 里每个查询返回前已 sort 好），
 * 前端只负责渲染，不提供表头排序——保持"所见即后端返回的顺序"。
 */
function buildColumns(columns: QueryColumn[]): ColumnsType<QueryRow> {
  return columns.map((column) => ({
    title: column.title,
    dataIndex: column.key,
    key: column.key,
    width: column.width,
    align: ALIGN_RIGHT.has(column.type) ? ('right' as const) : undefined,
    render: (value: QueryRow[string]) => renderCell(column, value),
  })) as ColumnsType<QueryRow>;
}

// --------------------------------------------------------------------------- 汇总条

const SUMMARY_LABELS: Record<string, string> = {
  total_due: '应付合计',
  total_paid: '已付合计',
  total_unsettled: '还欠合计',
  worker_count: '工人数',
  receivable_unsettled: '应收未收',
  payable_unsettled: '应付未付',
  count: '单据数',
  actual_cost: '实际成本',
  cost_budget: '成本预算',
  budget_left: '预算余额',
  budget_usage_rate: '预算使用率',
  client_budget: '甲方预算',
  settle_profit: '结算利润',
};

function SummaryBar({ entries }: { entries: [string, unknown][] }) {
  if (entries.length === 0) return null;

  const boolEntries = entries.filter(([, value]) => typeof value === 'boolean');
  const numEntries = entries.filter(([, value]) => typeof value !== 'boolean');

  return (
    <Space size={28} wrap>
      {numEntries.map(([key, value]) => (
        <Statistic
          key={key}
          title={SUMMARY_LABELS[key] ?? key}
          value={Number(value ?? 0)}
          precision={key === 'worker_count' || key === 'count' ? 0 : 2}
          valueStyle={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}
          suffix={key === 'budget_usage_rate' ? '%' : undefined}
        />
      ))}
      {boolEntries.map(([key, value]) => (
        <span key={key}>
          {key === 'over_budget' ? (
            value ? (
              <Tag color="red">已超成本预算</Tag>
            ) : (
              <Tag color="green">未超成本预算</Tag>
            )
          ) : (
            <Tag>{`${key}: ${String(value)}`}</Tag>
          )}
        </span>
      ))}
    </Space>
  );
}

// --------------------------------------------------------------------------- 各卡片筛选

/** 工人未结款：付款状态分档（基于 已付 vs 累计应付） */
type PayState = 'unpaid' | 'partial' | 'paid';

const PAY_STATE_OPTIONS: { value: PayState; label: string }[] = [
  { value: 'unpaid', label: '一分没付' },
  { value: 'partial', label: '部分已付' },
  { value: 'paid', label: '全部付清' },
];

const PAY_STATE_ALL: PayState[] = ['unpaid', 'partial', 'paid'];

function payStateOf(row: QueryRow): PayState {
  const due = cents(row.amount_due);
  const paid = cents(row.paid_amount);
  if (paid <= 0) return 'unpaid';
  if (due > 0 && paid >= due) return 'paid';
  return 'partial';
}

/** 把后端的行按「还欠」降序排（并列时按累计应付降序），对应需求 #6e */
function sortByUnsettled(rows: QueryRow[]): QueryRow[] {
  return [...rows].sort(
    (a, b) => cents(b.unsettled) - cents(a.unsettled) || cents(b.amount_due) - cents(a.amount_due),
  );
}

interface LaborFilterProps {
  rows: QueryRow[];
}

/**
 * 工人未结款的卡片内筛选（需求 #5 + 排序 #6e）。
 *
 * 全部在前端做：后端返回该项目全量工人，筛选即时生效、不重新请求后端。
 * 付款状态**至少保留一项**：取消最后一项时不生效并提示。
 *
 * 返回 `filtered` 供卡片直接渲染（不经过 state 回传，避免首帧空表）。
 */
function useLaborFilters({ rows }: LaborFilterProps) {
  const [states, setStates] = useState<PayState[]>(PAY_STATE_ALL);
  const [workers, setWorkers] = useState<string[]>([]);
  /** 工人下拉是否处于「全部」状态（未动过 = 全部） */
  const [workerTouched, setWorkerTouched] = useState(false);

  /** 下拉选项：从当前结果里取出现过的工人 */
  const workerOptions = useMemo(() => {
    const names = new Set<string>();
    rows.forEach((row) => {
      if (row.partner) names.add(String(row.partner));
    });
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map((name) => ({ value: name, label: name }));
  }, [rows]);

  const filtered = useMemo(() => {
    const picked = workerTouched && workers.length > 0 ? new Set(workers) : null;
    return sortByUnsettled(
      rows.filter((row) => {
        if (!states.includes(payStateOf(row))) return false;
        if (picked && !picked.has(String(row.partner))) return false;
        return true;
      }),
    );
  }, [rows, states, workers, workerTouched]);

  /** 付款状态变化：不允许把三项全取消 */
  const changeStates = (next: PayState[]) => {
    if (next.length === 0) return false;
    setStates(next);
    return true;
  };

  /**
   * 付款状态在框里显示什么：
   * - 三档全选 → 「全部」
   * - 选中一部分 → 直接列出档位名（如「部分已付 / 全部付清」），
   *   而不是 antd 默认的「+2 …」或「已选 2 项」，否则看不出选了什么。
   */
  const stateSummary =
    states.length === PAY_STATE_ALL.length
      ? '全部'
      : PAY_STATE_OPTIONS.filter((item) => states.includes(item.value))
          .map((item) => item.label)
          .join(' / ');

  const node = (
    <Space size={8} wrap>
      <Select<PayState[]>
        mode="multiple"
        allowClear={false}
        value={states}
        maxTagCount={0}
        maxTagPlaceholder={() => stateSummary}
        style={{ minWidth: 190 }}
        options={PAY_STATE_OPTIONS}
        placeholder="付款状态"
        onChange={(next) => {
          if (!changeStates(next)) {
            void import('antd').then(({ message }) => message.warning('请至少勾选一种付款状态'));
          }
        }}
      />
      <Select<string[]>
        mode="multiple"
        allowClear
        value={workerTouched ? workers : undefined}
        placeholder="全部工人"
        style={{ minWidth: 160 }}
        maxTagCount="responsive"
        optionFilterProp="label"
        options={workerOptions}
        onChange={(next) => {
          setWorkerTouched(true);
          setWorkers(next ?? []);
        }}
      />
    </Space>
  );

  return { node, filtered };
}

// --------------------------------------------------------------------------- 主页面

/**
 * 快速查询（2026-10-19 需求 + 需求补充）。
 *
 * - 勾选要查的内容 → 点「查询」→ **只渲染勾中的那几块**
 * - 每块自带筛选，**三块互相独立**：筛一块不影响另外两块
 * - 筛选全部在前端做：切换即时生效，不重新请求后端
 */
export default function QuickQuery() {
  const navigate = useNavigate();
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const { dateRange, setDateRange } = useDateRange();

  const [types, setTypes] = useState<QueryTypeInfo[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [typesLoaded, setTypesLoaded] = useState(false);
  const [blocks, setBlocks] = useState<QueryBlock[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);

  /** 拉清单：拿到后默认全选 */
  useEffect(() => {
    let alive = true;
    queryApi
      .types()
      .then((data) => {
        if (!alive) return;
        const items = data.items ?? [];
        setTypes(items);
        setSelected(items.filter((item) => item.default_selected).map((item) => item.code));
      })
      .catch(() => {
        if (alive) setTypes([]);
      })
      .finally(() => {
        if (alive) setTypesLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const allCodes = useMemo(() => types.map((item) => item.code), [types]);
  const isAllSelected = allCodes.length > 0 && selected.length === allCodes.length;

  const run = useCallback(async () => {
    if (selected.length === 0 || !currentProjectId) return;
    setLoading(true);
    try {
      const data = await queryApi.run({
        types: selected,
        project_id: currentProjectId,
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
      });
      setBlocks(data.blocks ?? []);
      setRan(true);
    } catch {
      /* 拦截器已提示；保留上次结果 */
    } finally {
      setLoading(false);
    }
  }, [selected, currentProjectId, dateRange.start_date, dateRange.end_date]);

  const toggleAll = () => setSelected(isAllSelected ? [] : [...allCodes]);

  /** 勾选变化后清掉旧结果，避免看到与当前勾选不符的表 */
  const onChangeSelected = (next: string[]) => {
    setSelected(next);
    setBlocks(null);
    setRan(false);
  };

  const noProject = currentProjectId === null;
  const canRun = selected.length > 0 && !noProject;

  return (
    <div className="pims-page">
      <PageToolbar
        showDateRange
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
      />

      <div className="pims-page-body">
        {/* 需求 #4：查询内容保持勾选；「查询」按钮紧跟在「清空」之后 */}
        <Card style={{ marginBottom: 16 }} size="small">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space size={12} wrap>
              <Text strong>查询内容</Text>
              <Checkbox.Group
                value={selected}
                onChange={(values) => onChangeSelected(values as string[])}
                options={types.map((item) => ({
                  value: item.code,
                  label: (
                    <Tooltip title={item.description}>
                      <span>{item.name}</span>
                    </Tooltip>
                  ),
                }))}
                disabled={!typesLoaded}
              />
              <Button size="small" onClick={toggleAll} disabled={!typesLoaded || allCodes.length === 0}>
                {isAllSelected ? '清空' : '全选'}
              </Button>
              <Button
                type="primary"
                size="small"
                icon={<SearchOutlined />}
                loading={loading}
                disabled={!canRun}
                onClick={() => void run()}
              >
                查询
              </Button>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              默认全选。只勾一项就只出那一张表；每张表的筛选互不影响。
            </Text>
          </Space>
        </Card>

        {noProject && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="请先在顶部选择一个项目"
            description="快速查询按项目统计，选择具体项目后才能查询。"
          />
        )}

        {!noProject && selected.length === 0 && (
          <Alert type="info" showIcon style={{ marginBottom: 16 }} message="至少勾选一项查询内容" />
        )}

        {loading && (
          <Card>
            <Spin />
          </Card>
        )}

        {!loading && blocks !== null && blocks.length === 0 && (
          <Card>
            <Empty description="没有返回结果" />
          </Card>
        )}

        {!loading &&
          blocks?.map((block) => (
            <QueryCard
              key={block.type}
              block={block}
              onNavigate={(path) => navigate(`${path}?project_id=${currentProjectId}`)}
            />
          ))}

        {!loading && !ran && blocks === null && typesLoaded && types.length > 0 && (
          <Card>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="勾选要查的内容，点「查询」" />
          </Card>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- 单张结果卡

interface QueryCardProps {
  block: QueryBlock;
  onNavigate: (path: string) => void;
}

/**
 * 一张结果卡。
 *
 * 每张卡的筛选状态都**放在卡片组件内部**，所以三张卡天然互不影响：
 * 卡片互不共享 state，筛一张不会触发另一张的渲染或请求。
 */
function QueryCard({ block, onNavigate }: QueryCardProps) {
  const link = LINK_BY_TYPE[block.type];

  /* ---------- 工人未结款（需求 #5 + #6e）：付款状态 + 工人多选，默认按还欠降序 ---------- */
  const labor = useLaborFilters({ rows: block.rows });

  /* ---------- 往来未结（需求 #2/#3/#6a/#6b）：应收/应付 + 业务类型 + 对方 ---------- */
  type ArapSide = 'all' | 'receivable' | 'payable';
  const [side, setSide] = useState<ArapSide>('all');
  const [bizTypes, setBizTypes] = useState<string[]>([]);
  const [partners, setPartners] = useState<string[]>([]);
  const [bizTouched, setBizTouched] = useState(false);
  const [partnerTouched, setPartnerTouched] = useState(false);

  const arapBizOptions = useMemo(() => {
    const names = new Set<string>();
    block.rows.forEach((row) => {
      if (row.biz_type_label) names.add(String(row.biz_type_label));
    });
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map((name) => ({ value: name, label: name }));
  }, [block.rows]);

  const arapPartnerOptions = useMemo(() => {
    const names = new Set<string>();
    block.rows.forEach((row) => {
      const partner = String(row.partner ?? '');
      if (partner && partner !== '—') names.add(partner);
    });
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map((name) => ({ value: name, label: name }));
  }, [block.rows]);

  const arapFiltered = useMemo(() => {
    const bizSet = bizTouched ? new Set(bizTypes) : null;
    const partnerSet = partnerTouched ? new Set(partners) : null;
    return block.rows.filter((row) => {
      if (side === 'receivable' && row.type_label !== '应收') return false;
      if (side === 'payable' && row.type_label !== '应付') return false;
      if (bizSet && !bizSet.has(String(row.biz_type_label ?? ''))) return false;
      if (partnerSet && !partnerSet.has(String(row.partner ?? ''))) return false;
      return true;
    });
  }, [block.rows, side, bizTypes, bizTouched, partners, partnerTouched]);

  const arapSummary = useMemo(() => {
    const receivable = arapFiltered
      .filter((row) => row.type_label === '应收')
      .reduce((sum, row) => sum + cents(row.unsettled), 0);
    const payable = arapFiltered
      .filter((row) => row.type_label === '应付')
      .reduce((sum, row) => sum + cents(row.unsettled), 0);
    return {
      receivable: receivable / 100,
      payable: payable / 100,
      count: arapFiltered.length,
    };
  }, [arapFiltered]);

  /* ---------- 成本与预算（需求 #6c/#6d）：成本类型多选，占比分母固定为全五类 ---------- */
  const [costTypes, setCostTypes] = useState<string[]>([]);
  const [costTouched, setCostTouched] = useState(false);

  /** 全五类实际成本 = 原始 summary（不随筛选变），作为占比分母 */
  const totalActualCents = useMemo(
    () => cents((block.summary?.actual_cost as Money) ?? 0),
    [block.summary],
  );

  const costOptions = useMemo(
    () =>
      block.rows
        .filter((row) => row.type !== '__total__')
        .map((row) => ({ value: String(row.type), label: String(row.type_label) })),
    [block.rows],
  );

  const costRows = useMemo(() => {
    const picked = costTouched ? new Set(costTypes) : null;
    const detailRows = block.rows.filter((row) => row.type !== '__total__');
    const visible = picked ? detailRows.filter((row) => picked.has(String(row.type))) : detailRows;
    // 「占比」列分母固定为全五类实际成本（需求：#6d 确认 i）
    const withShare: QueryRow[] = visible.map((row) => ({
      ...row,
      share: totalActualCents > 0 ? Math.round((cents(row.amount) / totalActualCents) * 10000) / 100 : 0,
    }));
    const totalCents = withShare.reduce((sum, row) => sum + cents(row.amount), 0);
    return {
      visible: withShare,
      /**
       * 合计行**不进 dataSource**：它是一行汇总，混进去会参与排序
       * （金额最大，必然被排到第一行）。改用 Table.Summary 固定在表尾。
       */
      total: {
        type: '__total__',
        type_label: '合计',
        amount: totalCents / 100,
        share: totalActualCents > 0 ? Math.round((totalCents / totalActualCents) * 10000) / 100 : 0,
      },
    };
  }, [block.rows, costTypes, costTouched, totalActualCents]);

  /* ---------- 按块类型组装 ---------- */
  const isLabor = block.type === 'labor_unsettled';
  const isArap = block.type === 'arap_unsettled';
  const isCost = block.type === 'cost_budget';

  /**
   * 工人卡：用筛选后的行重算汇总（需求 #5：汇总跟着筛选变）。
   *
   * 成本卡的合计行就是 `costRows.total`，直接放在数据最后一行——
   * 后端已排好序，前端不再排序，所以它不会跑到中间去。
   */
  const displayRows = isLabor
    ? labor.filtered
    : isArap
      ? arapFiltered
      : isCost
        ? [...costRows.visible, costRows.total]
        : block.rows;

  const columns = buildColumns(block.columns);

  const laborSummary = useMemo(() => {
    if (!isLabor) return [] as [string, unknown][];
    const rows = labor.filtered;
    const due = rows.reduce((sum, row) => sum + cents(row.amount_due), 0);
    const paid = rows.reduce((sum, row) => sum + cents(row.paid_amount), 0);
    const unsettled = rows.reduce((sum, row) => sum + cents(row.unsettled), 0);
    return [
      ['total_due', due / 100],
      ['total_paid', paid / 100],
      ['total_unsettled', unsettled / 100],
      ['worker_count', rows.length],
    ] as [string, unknown][];
  }, [isLabor, labor.filtered]);

  /* ---------- 卡片头部的筛选控件 ---------- */
  const filters = (
    <Space size={8} wrap>
      {isLabor && labor.node}
      {isArap && (
        <>
          {/* 需求 #2/#3：只有这块结果存在时才出现 */}
          <Segmented<ArapSide>
            value={side}
            onChange={(value) => setSide(value)}
            options={[
              { value: 'all', label: '全部' },
              { value: 'receivable', label: '应收款未收' },
              { value: 'payable', label: '应付未付' },
            ]}
          />
          <Select<string[]>
            mode="multiple"
            allowClear
            value={bizTouched ? bizTypes : undefined}
            placeholder="全部业务类型"
            style={{ minWidth: 150 }}
            maxTagCount="responsive"
            optionFilterProp="label"
            options={arapBizOptions}
            onChange={(next) => {
              setBizTouched(true);
              setBizTypes(next ?? []);
            }}
          />
          <Select<string[]>
            mode="multiple"
            allowClear
            value={partnerTouched ? partners : undefined}
            placeholder="全部对方"
            style={{ minWidth: 150 }}
            maxTagCount="responsive"
            optionFilterProp="label"
            options={arapPartnerOptions}
            onChange={(next) => {
              setPartnerTouched(true);
              setPartners(next ?? []);
            }}
          />
        </>
      )}
      {isCost && (
        <Select<string[]>
          mode="multiple"
          allowClear
          value={costTouched ? costTypes : undefined}
          placeholder="全部成本类型"
          style={{ minWidth: 170 }}
          maxTagCount="responsive"
          optionFilterProp="label"
          options={costOptions}
          onChange={(next) => {
            setCostTouched(true);
            setCostTypes(next ?? []);
          }}
        />
      )}
    </Space>
  );

  /** 顶部汇总：往来卡按筛选后重算；成本卡拆成「全五类」+「筛选后」两行 */
  const summaryNode = isLabor ? (
    <SummaryBar entries={laborSummary} />
  ) : isArap ? (
    <Space size={28} wrap>
      {side !== 'payable' && (
        <Statistic
          title="应收未收"
          value={arapSummary.receivable}
          precision={2}
          valueStyle={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}
        />
      )}
      {side !== 'receivable' && (
        <Statistic
          title="应付未付"
          value={arapSummary.payable}
          precision={2}
          valueStyle={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}
        />
      )}
      <Statistic
        title="单据数"
        value={arapSummary.count}
        valueStyle={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}
      />
    </Space>
  ) : isCost ? (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <SummaryBar entries={Object.entries(block.summary ?? {})} />
      {/* 需求 #6d：新增一行，只显示筛选后的合计 */}
      <Space size={28} wrap>
        <Statistic
          title="筛选后合计"
          value={costRows.total.amount}
          precision={2}
          valueStyle={{ fontSize: 18, color: '#1677ff', fontVariantNumeric: 'tabular-nums' }}
          suffix={
            <Text type="secondary" style={{ fontSize: 12 }}>
              （占全部成本 {fmtMoney(costRows.total.share)}%）
            </Text>
          }
        />
        <Statistic
          title="筛选后类型数"
          value={costRows.visible.length}
          valueStyle={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}
        />
      </Space>
    </Space>
  ) : (
    <SummaryBar entries={Object.entries(block.summary ?? {})} />
  );

  return (
    <Card
      style={{ marginBottom: 16 }}
      title={
        <Space size={12} wrap>
          <span>{block.title}</span>
          <Tag>{displayRows.filter((row) => row.type !== '__total__').length} 条</Tag>
          {filters}
        </Space>
      }
      extra={
        link ? (
          <Button type="link" size="small" onClick={() => onNavigate(link.path)}>
            {link.label} →
          </Button>
        ) : null
      }
    >
      {block.error ? (
        <Result
          status="warning"
          title="这一项查询失败"
          subTitle={block.error}
          style={{ padding: '12px 0' }}
        />
      ) : (
        <>
          {summaryNode}
          <div style={{ height: 12 }} />
          {displayRows.length === 0 ? (
            <Empty description={block.empty_text || '暂无数据'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <>
              <DataTable<QueryRow>
                rowKey={(row, index) => `${block.type}-${row.type ?? row.partner}-${index ?? ''}`}
                columns={columns}
                dataSource={displayRows}
                pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
                stickyHeader={false}
                size="small"
                scroll={{ x: undefined }}
                /* 成本卡的合计行高亮（它由后端排在最后一行） */
                rowClassName={(row) => (row.type === '__total__' ? 'pims-row-focus' : '')}
              />
              {block.note && (
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                  {block.note}
                </Text>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}
