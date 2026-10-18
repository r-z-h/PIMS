import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, DollarOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import DataTable from '../components/DataTable';
import MoneyInput from '../components/MoneyInput';
import MoneyText from '../components/MoneyText';
import PageToolbar from '../components/PageToolbar';
import { laborApi } from '../api/labor';
import { useAppStore } from '../store/app';
import { useDateRange } from '../hooks/useDateRange';
import type {
  LaborPreview,
  LaborPreviewItem,
  LaborSettle,
  PayMethod,
  SettleOverview,
  SettleOverviewItem,
  SettleType,
  SettleTypeInfo,
} from '../types';
import { addMoney, fmtDecimal, fmtMoney, subMoney } from '../utils/money';
import { PAY_METHODS, PAY_METHOD_LABEL, SETTLE_STATUS_LABEL, toOptions } from '../utils/enums';

const { Text } = Typography;

/** 兜底：后端 /labor/types 没回来时也要能渲染（顺序与后端一致） */
const FALLBACK_TYPES: SettleTypeInfo[] = [
  { cost_type: 'labor', cost_type_label: '人工', group_label: '按工人姓名' },
  { cost_type: 'material', cost_type_label: '材料', group_label: '按供应商' },
  { cost_type: 'machine', cost_type_label: '机械', group_label: '按出租方' },
  { cost_type: 'misc', cost_type_label: '杂费', group_label: '按杂费小类' },
  { cost_type: 'advance', cost_type_label: '垫付', group_label: '按垫付人' },
];

const VALID_TYPES: string[] = FALLBACK_TYPES.map((item) => item.cost_type);

/** URL 里的 cost_type 先校验再用：传了不认的值（如 other / advance_pay）一律落回人工，避免页签全灭 */
function safeSettleType(raw: string | null): SettleType {
  return raw && VALID_TYPES.includes(raw) ? (raw as SettleType) : 'labor';
}

/**
 * 结算：**五类成本都在这里结算发放**（2026-10-16 需求）。
 *
 * 五类的流程完全一样（预览 → 保存结算单 → 登记发放 → 自动冲销对应应付单），
 * 区别只在**按什么汇总**：人工=姓名、材料=供应商、机械=出租方、杂费=小类、垫付=垫付人。
 */
export default function LaborSettle() {
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const setCurrentProjectId = useAppStore((s) => s.setCurrentProjectId);
  const { dateRange, setDateRange } = useDateRange();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * 从「往来」页应付单跳过来时带 `?project_id=&cost_type=&partner=`（需求 T7/T8）：
   * 自动切到该项目、切到对应类别页签、只显示这一行。
   */
  const [settleType, setSettleType] = useState<SettleType>(safeSettleType(searchParams.get('cost_type')));
  const [focusPartner, setFocusPartner] = useState<string | null>(searchParams.get('partner'));
  const [typeInfos, setTypeInfos] = useState<SettleTypeInfo[]>(FALLBACK_TYPES);

  const [preview, setPreview] = useState<LaborPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [settles, setSettles] = useState<LaborSettle[]>([]);
  const [settlesLoading, setSettlesLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 欠款总览（一对象一行，累计口径）——「已付」来自应付单的冲销记录 */
  const [overview, setOverview] = useState<SettleOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  /** 默认只看还欠钱的；打开后连已结清的一起显示 */
  const [showSettled, setShowSettled] = useState(false);

  const [payOpen, setPayOpen] = useState(false);
  /** 发放对象：总览里的一行（带正确的"还欠"上限） */
  const [payTarget, setPayTarget] = useState<SettleOverviewItem | null>(null);
  const [payForm] = Form.useForm<{ amount: number | null; pay_date: string; pay_method: PayMethod; remark?: string }>();

  /** 当前类别的汇总依据名（"按供应商"这类），用于界面提示 */
  const groupLabel =
    typeInfos.find((item) => item.cost_type === settleType)?.group_label ??
    FALLBACK_TYPES.find((item) => item.cost_type === settleType)?.group_label ??
    '';
  const typeLabel =
    typeInfos.find((item) => item.cost_type === settleType)?.cost_type_label ??
    FALLBACK_TYPES.find((item) => item.cost_type === settleType)?.cost_type_label ??
    settleType;

  // 类别清单（一次性）
  useEffect(() => {
    laborApi
      .types()
      .then((items) => {
        if (items.length > 0) setTypeInfos(items);
      })
      .catch(() => undefined);
  }, []);

  // 带着 project_id 进来时切到该项目（否则看的是别的项目的数据）
  useEffect(() => {
    const raw = searchParams.get('project_id');
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0 && parsed !== currentProjectId) {
      setCurrentProjectId(parsed);
    }
    if (!searchParams.get('partner') && !searchParams.get('project_id') && !searchParams.get('cost_type')) return;
    // 参数只用于"指路"，消费掉，避免刷新后又被切走
    const next = new URLSearchParams(searchParams);
    next.delete('partner');
    next.delete('project_id');
    next.delete('cost_type');
    setSearchParams(next, { replace: true });
    // 只在首次进入时消费
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSettles = useCallback(async () => {
    if (!currentProjectId) {
      setSettles([]);
      return;
    }
    setSettlesLoading(true);
    try {
      const data = await laborApi.settles({
        project_id: currentProjectId,
        cost_type: settleType,
        page: 1,
        page_size: 200,
      });
      setSettles(data.items ?? []);
    } finally {
      setSettlesLoading(false);
    }
  }, [currentProjectId, settleType]);

  /** 欠款总览：进来就要有数，不依赖「生成结算预览」 */
  const loadOverview = useCallback(async () => {
    if (!currentProjectId) {
      setOverview(null);
      return;
    }
    setOverviewLoading(true);
    try {
      const data = await laborApi.overview({
        project_id: currentProjectId,
        cost_type: settleType,
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
      });
      setOverview(data);
    } catch {
      /* 拦截器已提示 */
    } finally {
      setOverviewLoading(false);
    }
  }, [currentProjectId, settleType, dateRange.start_date, dateRange.end_date]);

  useEffect(() => {
    void loadSettles();
    void loadOverview();
  }, [loadSettles, loadOverview]);

  // 切项目或切类别都要把上一次的预览清掉（否则会拿人工的预览去保存材料的结算单）
  useEffect(() => {
    setPreview(null);
  }, [currentProjectId, settleType]);

  const generatePreview = async () => {
    if (!currentProjectId) {
      void message.warning('请先选择项目');
      return;
    }
    setPreviewLoading(true);
    try {
      const data = await laborApi.preview({
        project_id: currentProjectId,
        cost_type: settleType,
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
      });
      setPreview(data);
      if ((data.items ?? []).length === 0) {
        void message.info(`该项目在本时间段内没有「${typeLabel}」成本，请先到「记账」页录入`);
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  const saveSettle = async () => {
    if (!currentProjectId || !preview) return;
    setSaving(true);
    try {
      const result = await laborApi.settle({
        project_id: currentProjectId,
        cost_type: settleType,
        settle_date: dayjs().format('YYYY-MM-DD'),
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
      });
      void message.success(`已保存 ${result.items?.length ?? 0} 条「${typeLabel}」结算单（不新增成本）`);
      await loadSettles();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  };

  /**
   * 打开「登记发放」。
   *
   * 发放是按**对象**（总览里的一行）来的，不是按结算单：
   * 因为上限要用"真实还欠多少"（= 应付 − 已付），而那个数只有总览才有。
   * 结算单只是"本期该结多少"的快照，发钱不依赖它。
   */
  const openPay = (row: SettleOverviewItem) => {
    setPayTarget(row);
    payForm.resetFields();
    payForm.setFieldsValue({
      amount: Number(row.unsettled ?? 0),
      pay_date: dayjs().format('YYYY-MM-DD'),
      pay_method: 'wechat',
    });
    setPayOpen(true);
  };

  const submitPay = async () => {
    if (!payTarget || !currentProjectId) return;
    const values = await payForm.validateFields();
    setSaving(true);
    try {
      // 后端按「项目 + 类别 + 对象」找到快照并发放；没有快照会自动补一张
      const result = await laborApi.payByPartner({
        project_id: currentProjectId,
        cost_type: settleType,
        partner: payTarget.partner,
        amount: values.amount ?? 0,
        pay_date: values.pay_date,
        pay_method: values.pay_method,
        remark: values.remark ?? null,
      });
      void message.success('发放已登记');
      setPayOpen(false);
      await Promise.all([loadSettles(), loadOverview()]);
      // 需求 T6：发放同时生成了付款流水并冲销了该工人的应付单，必须告知，
      // 否则用户以为"只记了一笔发放"，不知道往来页的欠款已经跟着少了
      const offset = result?.offset;
      if (offset?.applied) {
        Modal.info({
          title: '发放已登记，并已冲销对应应付单',
          width: 520,
          okText: '知道了',
          content: (
            <Space direction="vertical" size={6}>
              <Text>
                本次发放 <MoneyText value={values.amount ?? 0} bold />，已生成一笔付款流水，
                并冲销该对象对应的应付单 <Text strong>{offset.offset_ids?.length ?? 0}</Text> 张，
                合计 <MoneyText value={offset.plan_total ?? 0} bold />。
              </Text>
              {Number(offset.remaining ?? 0) > 0 ? (
                <Text type="warning">
                  还有 <MoneyText value={offset.remaining} /> 未能冲销（该对象未结的应付单不足），
                  已留在本笔付款流水上作为可冲余额。请到「往来」页核对是否多付了。
                </Text>
              ) : null}
              <Text type="secondary" style={{ fontSize: 12 }}>
                「结算」与「往来」是同一本账：这里发了多少，往来页就少欠多少。
              </Text>
            </Space>
          ),
        });
      } else {
        Modal.info({
          title: '发放已登记',
          width: 480,
          okText: '知道了',
          content: (
            <Text>
              本次发放 <MoneyText value={values.amount ?? 0} bold /> 已生成付款流水。
              {offset?.message ? ` ${offset.message}` : ' 未找到该对象可冲销的应付单。'}
            </Text>
          ),
        });
      }
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  };

  /** 人工才有"工天"；其他类别列名用该类别的汇总依据（供应商/出租方/小类/垫付人） */
  const isLabor = settleType === 'labor';
  const partnerTitle = isLabor ? '姓名' : groupLabel.replace(/^按/, '') || '对象';

  const previewColumns: ColumnsType<LaborPreviewItem> = [
    { title: partnerTitle, dataIndex: 'partner', width: 160, ellipsis: true },
    ...(isLabor
      ? [
          {
            title: '总工天',
            dataIndex: 'total_days',
            width: 110,
            align: 'right' as const,
            render: (value: number) => fmtDecimal(value),
          },
        ]
      : [
          {
            title: '笔数',
            dataIndex: 'cost_count',
            width: 90,
            align: 'right' as const,
            render: (value?: number) => value ?? '-',
          },
        ]),
    {
      title: '应发金额',
      dataIndex: 'amount_due',
      width: 140,
      align: 'right',
      render: (value: number) => <MoneyText value={value} bold />,
    },
    {
      title: '已发',
      key: 'paid',
      width: 130,
      align: 'right',
      render: (_: unknown, row) => <MoneyText value={row.paid_amount ?? 0} />,
    },
    {
      title: '未发',
      key: 'unpaid',
      width: 130,
      align: 'right',
      render: (_: unknown, row) => (
        <MoneyText value={subMoney(row.amount_due, row.paid_amount ?? 0)} />
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_: unknown, row) => {
        const status = row.status ?? 'unpaid';
        return (
          <Tag color={status === 'paid' ? 'green' : status === 'partial' ? 'orange' : 'default'}>
            {SETTLE_STATUS_LABEL[status]}
          </Tag>
        );
      },
    },
  ];

  /**
   * 本期结算单快照列表：**只表达"这一期该结多少"**。
   *
   * 已付/还欠不在这里——那要看上面的欠款总览（来自应付单的冲销记录），
   * 否则钱从别的入口付了就看不出来（用户实测踩过这个坑）。
   */
  const settleColumns: ColumnsType<LaborSettle> = [
    {
      title: partnerTitle,
      dataIndex: 'partner',
      width: 170,
      ellipsis: true,
      render: (value: string | undefined, row) => value || row.worker_name,
    },
    ...(isLabor
      ? [
          {
            title: '总工天',
            dataIndex: 'total_days',
            width: 100,
            align: 'right' as const,
            render: (value: number) => fmtDecimal(value),
          },
        ]
      : []),
    {
      title: '本期应结',
      dataIndex: 'amount_due',
      width: 140,
      align: 'right',
      render: (value: number) => <MoneyText value={value} bold />,
    },
    { title: '结算日期', dataIndex: 'settle_date', width: 110, render: (v: string) => v || '-' },
    { title: '最后发放', dataIndex: 'pay_date', width: 110, render: (v: string) => v || '-' },
    {
      title: '发放方式',
      dataIndex: 'pay_method',
      width: 100,
      render: (v: PayMethod | null) => (v ? PAY_METHOD_LABEL[v] : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Button
          type="link"
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => {
            Modal.confirm({
              title: `删除「${row.partner || row.worker_name}」的本期结算单？`,
              content:
                '只删除"这一期该结多少"这张快照；已经付出去的钱在付款流水与冲销记录里，不受影响。',
              okType: 'danger',
              onOk: async () => {
                await laborApi.removeSettle(row.id);
                void message.success('已删除');
                void loadSettles();
              },
            });
          }}
        >
          删除
        </Button>
      ),
    },
  ];

  /** 从「往来」跳过来时只看这一个对象（需求 T7/T8）；清掉筛选即恢复全部 */
  const previewItems = useMemo(
    () => (focusPartner ? (preview?.items ?? []).filter((i) => i.partner === focusPartner) : (preview?.items ?? [])),
    [preview, focusPartner],
  );
  const settledItems = useMemo(
    () => (focusPartner ? settles.filter((s) => (s.partner ?? s.worker_name) === focusPartner) : settles),
    [settles, focusPartner],
  );

  const previewTotal = useMemo(
    () => (focusPartner ? addMoney(...previewItems.map((i) => i.amount_due)) : (preview?.total_amount ?? 0)),
    [preview, previewItems, focusPartner],
  );

  /** 总览行：默认只看还欠钱的（勾选"含已结清"看全部）；从往来跳过来时只看那一项 */
  const overviewItems = useMemo(() => {
    let list = overview?.items ?? [];
    if (focusPartner) list = list.filter((item) => item.partner === focusPartner);
    else if (!showSettled) list = list.filter((item) => Number(item.unsettled ?? 0) > 0);
    return list;
  }, [overview, focusPartner, showSettled]);

  /** 本期结算单快照的合计（只统计"这一期该结"） */
  const periodTotal = useMemo(
    () => addMoney(...settledItems.map((s) => s.amount_due)),
    [settledItems],
  );

  const overviewColumns: ColumnsType<SettleOverviewItem> = [
    { title: partnerTitle, dataIndex: 'partner', width: 150, ellipsis: true },
    {
      title: '应付金额（累计）',
      dataIndex: 'amount_due',
      width: 140,
      align: 'right',
      render: (value: number) => <MoneyText value={value} bold />,
    },
    {
      title: '已付（累计）',
      dataIndex: 'paid_amount',
      width: 130,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '还欠',
      dataIndex: 'unsettled',
      width: 130,
      align: 'right',
      render: (value: number) => <MoneyText value={value} bold style={{ color: '#cf1322' }} />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: SettleOverviewItem['status']) => (
        <Tag color={value === 'closed' ? 'green' : value === 'partial' ? 'orange' : 'default'}>
          {value === 'closed' ? '已结清' : value === 'partial' ? '部分' : '未付'}
        </Tag>
      ),
    },
    {
      title: '付款方式构成',
      key: 'paid_methods',
      width: 210,
      render: (_: unknown, item: SettleOverviewItem) => {
        if (!item.paid_methods || item.paid_methods.length === 0) return <Text type="secondary">-</Text>;
        return (
          <span>
            {item.paid_methods.map((m, index) => (
              <span key={m.pay_method}>
                {index > 0 ? <Text type="secondary"> + </Text> : null}
                <Text>{m.pay_method_label}</Text> <MoneyText value={m.amount} />
              </span>
            ))}
          </span>
        );
      },
    },
    {
      title: '本期该结',
      dataIndex: 'period_amount',
      width: 120,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      fixed: 'right',
      render: (_: unknown, item: SettleOverviewItem) => (
        <Button
          type="link"
          size="small"
          icon={<DollarOutlined />}
          disabled={Number(item.unsettled ?? 0) <= 0}
          onClick={() => openPay(item)}
        >
          登记发放
        </Button>
      ),
    },
  ];

  return (
    <div className="pims-page">
      <PageToolbar
        showProject
        allowAllProjects={false}
        showDateRange
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        showExport
        exportProjectId={currentProjectId}
        actions={
          <>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void loadSettles();
                void loadOverview();
              }}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={previewLoading}
              disabled={!currentProjectId}
              onClick={() => void generatePreview()}
            >
              生成结算预览
            </Button>
          </>
        }
      />
      <div className="pims-page-body">
        {!currentProjectId && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="请先在顶部选择项目"
            description="五类成本都在这里结算发放；每类按自己的依据汇总（人工按姓名、材料按供应商、机械按出租方、杂费按小类、垫付按垫付人）。"
          />
        )}

        <Card style={{ marginBottom: 12 }} styles={{ body: { paddingTop: 8, paddingBottom: 0 } }}>
          <Tabs
            activeKey={settleType}
            onChange={(key) => {
              setSettleType(key as SettleType);
              setFocusPartner(null); // 换类别时清掉上一个类别的定位
            }}
            items={typeInfos.map((info) => ({
              key: info.cost_type,
              label: (
                <Space size={4}>
                  <span>{info.cost_type_label}</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {info.group_label}
                  </Text>
                </Space>
              ),
            }))}
          />
        </Card>

        {focusPartner && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`已从「往来」跳到「${typeLabel}」的 ${focusPartner}，下面只显示这一项`}
            description={`${typeLabel}统一在这里按${groupLabel.replace(/^按/, '')}发放；发放时会自动生成付款流水并冲销对应的应付单。`}
            action={
              <Button size="small" onClick={() => setFocusPartner(null)}>
                显示全部
              </Button>
            }
          />
        )}

        {/* 欠款总览：一对象一行，累计口径。发放就在这里做（这里才有正确的"还欠"上限） */}
        <Card
          title={`欠款总览（${typeLabel} · 累计口径）`}
          style={{ marginBottom: 16 }}
          extra={
            <Space size={12} wrap>
              <Text type="secondary">
                应付合计 <MoneyText value={overview?.total_due ?? 0} />
              </Text>
              <Text type="secondary">
                已付合计 <MoneyText value={overview?.total_paid ?? 0} />
              </Text>
              <Text>
                还欠合计 <MoneyText value={overview?.total_unsettled ?? 0} bold />
              </Text>
              <label style={{ fontSize: 12, color: '#666' }}>
                <input
                  type="checkbox"
                  checked={showSettled}
                  onChange={(e) => setShowSettled(e.target.checked)}
                  style={{ marginRight: 4 }}
                />
                含已结清
              </label>
            </Space>
          }
          styles={{ body: { padding: 0 } }}
        >
          <DataTable<SettleOverviewItem>
            rowKey="partner"
            loading={overviewLoading}
            columns={overviewColumns}
            dataSource={overviewItems}
            pagination={false}
            locale={{
              emptyText: currentProjectId
                ? showSettled
                  ? `该项目暂无「${typeLabel}」成本`
                  : `该项目「${typeLabel}」当前没有欠款（勾选「含已结清」可看全部）`
                : '请先选择项目',
            }}
            scroll={{ x: 1000 }}
          />
          <div style={{ padding: '8px 16px' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {overview?.note ??
                '已付＝该对象名下应付单的全部冲销记录之和（不管钱从「收/付款」「冲销弹窗」「登记已付」还是这里发放，都算在内）'}
            </Text>
          </div>
        </Card>

        <Card
          title={`结算预览（${typeLabel} · ${groupLabel}，不写库、不新增成本）`}
          style={{ marginBottom: 16 }}
          extra={
            <Space>
              <Text type="secondary">合计应发：</Text>
              <MoneyText value={previewTotal} bold />
              <Button
                type="primary"
                disabled={!preview || (preview.items ?? []).length === 0}
                loading={saving}
                onClick={() => void saveSettle()}
              >
                保存结算单
              </Button>
            </Space>
          }
          styles={{ body: { padding: 0 } }}
        >
          <DataTable<LaborPreviewItem>
            rowKey="partner"
            loading={previewLoading}
            columns={previewColumns}
            dataSource={previewItems}
            pagination={false}
            locale={{ emptyText: currentProjectId ? '点击右上角「生成结算预览」' : '请先选择项目' }}
            scroll={undefined}
          />
          <div style={{ padding: '8px 16px' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {preview?.note ?? '口径：成本在记账时实时计入，结算只做汇总与发放，绝不重复计入成本（00-需求冻结 R6）。'}
            </Text>
          </div>
        </Card>

        <Card
          title={`${typeLabel}本期结算单（只记"这一期该结多少"）`}
          extra={
            <Text type="secondary">
              本期应结合计：<MoneyText value={periodTotal} bold />
            </Text>
          }
          styles={{ body: { padding: 0 } }}
        >
          <DataTable<LaborSettle>
            rowKey="id"
            loading={settlesLoading}
            columns={settleColumns}
            dataSource={settledItems}
            pagination={false}
            locale={{ emptyText: '暂无结算单，请先生成预览并保存' }}
            scroll={{ x: isLabor ? 1200 : 1100 }}
          />
        </Card>
      </div>

      <Modal
        title={payTarget ? `登记发放：${payTarget.partner}` : '登记发放'}
        open={payOpen}
        onCancel={() => setPayOpen(false)}
        onOk={() => void submitPay()}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={payForm} layout="vertical">
          <Form.Item
            label="本次发放金额"
            name="amount"
            rules={[{ required: true, message: '请填写发放金额' }]}
            extra={
              payTarget
                ? `应付 ${fmtMoney(payTarget.amount_due)}　已付 ${fmtMoney(payTarget.paid_amount)}　` +
                  `最多可发 ${fmtMoney(payTarget.unsettled)}（填多了会被拦住）`
                : undefined
            }
          >
            <MoneyInput />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item
              label="发放日期"
              name="pay_date"
              rules={[{ required: true, message: '请填写发放日期' }]}
              style={{ width: 180 }}
            >
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item label="发放方式" name="pay_method" style={{ width: 160 }}>
              <Select options={toOptions(PAY_METHOD_LABEL, PAY_METHODS)} />
            </Form.Item>
          </Space>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
