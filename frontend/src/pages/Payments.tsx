import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import DataTable from '../components/DataTable';
import DictSelect from '../components/DictSelect';
import MoneyInput from '../components/MoneyInput';
import MoneyText from '../components/MoneyText';
import OffsetModal from '../components/OffsetModal';
import type { OffsetApplyResult } from '../components/OffsetModal';
import PageToolbar from '../components/PageToolbar';
import ProjectSelect from '../components/ProjectSelect';
import { arapApi } from '../api/arap';
import { fundsApi } from '../api/funds';
import { useAppStore } from '../store/app';
import { useDateRange } from '../hooks/useDateRange';
import { ApiError } from '../types/api';
import type { ArApType, FundsFlow, FundsSummary, FundBizType, FundDirection, PayMethod } from '../types';
import {
  FUND_BIZ_TYPE_LABEL,
  IN_BIZ_TYPES,
  OUT_BIZ_TYPES,
  PAY_METHODS,
  PAY_METHOD_LABEL,
  toOptions,
} from '../utils/enums';

const { Text } = Typography;

interface FundsFormValues {
  project_id: number;
  biz_type: FundBizType;
  amount: number | null;
  biz_date: string;
  partner?: string;
  pay_method?: PayMethod;
  remark?: string;
}

/** 收/付款：资金收付流水（docs/01-开发手册.md 5.4）
 *
 * 模块改名说明：这个页面以前叫「记账」，按需求改名为「收/付款」——它记的是钱的进出，
 * 不参与利润；决定利润的五类成本录入在「记账」页。系统不提供「现金结余」指标。
 */
export default function Payments() {
  const [form] = Form.useForm<FundsFormValues>();
  const bizDateValue = Form.useWatch('biz_date', form);
  const { dateRange, setDateRange } = useDateRange();
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const showDeleted = useAppStore((s) => s.showDeleted);

  const [rows, setRows] = useState<FundsFlow[]>([]);
  const [summary, setSummary] = useState<FundsSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  /**
   * 当前是「收款」还是「付款」——由顶部切换控件控制，**同时决定列表过滤与新增弹窗口径**。
   * 默认停在「付款」（用户 2026-10-16 指定）。
   */
  const [direction, setDirection] = useState<FundDirection>('out');
  const [bizType, setBizType] = useState<FundBizType | undefined>(undefined);
  const [payMethod, setPayMethod] = useState<PayMethod | undefined>(undefined);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<FundsFlow | null>(null);
  const [modalDirection, setModalDirection] = useState<FundDirection>('in');
  const [saving, setSaving] = useState(false);

  const [offset, setOffset] = useState<{
    open: boolean;
    type: ArApType;
    projectId: number | null;
    fundsFlowId?: number | null;
    amount?: number | null;
    date?: string | null;
    partner?: string | null;
    /** 预冲方案（需求 T4）：交给 OffsetModal 预填，用户可自行增删改 */
    presetOffsets?: Array<{ ar_ap_id: number; amount: number }> | null;
    planHint?: string | null;
  }>({ open: false, type: 'receivable', projectId: null });

  const query = useMemo(    () => ({
      page,
      page_size: pageSize,
      project_id: currentProjectId ?? undefined,
      start_date: dateRange.start_date,
      end_date: dateRange.end_date,
      direction,
      biz_type: bizType,
      pay_method: payMethod,
      keyword: keyword || undefined,
      include_deleted: showDeleted,
    }),
    [page, pageSize, currentProjectId, dateRange.start_date, dateRange.end_date, direction, bizType, payMethod, keyword, showDeleted],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, sum] = await Promise.all([
        fundsApi.list(query),
        fundsApi.summary({
          project_id: currentProjectId ?? undefined,
          start_date: dateRange.start_date,
          end_date: dateRange.end_date,
          // 合计跟着顶部切换走，否则"只看付款"时还显示合计收款，数字对不上
          direction,
        }),
      ]);
      setRows(list.items ?? []);
      setTotal(list.total ?? 0);
      setSummary(sum);
    } catch {
      /* 拦截器已提示 */
    } finally {
      setLoading(false);
    }
  }, [query, currentProjectId, dateRange.start_date, dateRange.end_date, direction]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = (dir: FundDirection) => {
    setEditing(null);
    setModalDirection(dir);
    form.resetFields();
    form.setFieldsValue({
      project_id: currentProjectId ?? undefined,
      biz_type: dir === 'in' ? 'progress' : 'material',
      amount: null,
      biz_date: dayjs().format('YYYY-MM-DD'),
      pay_method: 'transfer',
    });
    setModalOpen(true);
  };

  const openEdit = (row: FundsFlow) => {
    setEditing(row);
    setModalDirection(row.direction);
    form.resetFields();
    form.setFieldsValue({
      project_id: row.project_id,
      biz_type: row.biz_type,
      amount: Number(row.amount ?? 0),
      biz_date: row.biz_date,
      partner: row.partner ?? undefined,
      pay_method: (row.pay_method ?? undefined) as PayMethod | undefined,
      remark: row.remark ?? undefined,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = {
        project_id: values.project_id,
        direction: modalDirection,
        biz_type: values.biz_type,
        amount: values.amount ?? 0,
        biz_date: values.biz_date,
        partner: values.partner ?? null,
        pay_method: values.pay_method ?? null,
        remark: values.remark ?? null,
      };
      if (editing) {
        await fundsApi.update(editing.id, payload);
        void message.success('流水已更新');
        setModalOpen(false);
        await load();
        return;
      }
      const created = await fundsApi.create(payload);
      void message.success(modalDirection === 'in' ? '收款已记录' : '付款已记录');
      setModalOpen(false);
      await load();

      // 保存后自动算出「预冲方案」，弹预冲窗口让用户过一眼再确认（需求 T4）。
      // 规则在后端：同项目、同业务类型、日期最早优先；不够冲一张就形成部分，有余额继续冲下一张。
      const flowId = created.id;
      const arapType: ArApType = modalDirection === 'in' ? 'receivable' : 'payable';
      try {
        const plan = await arapApi.autoOffsetPlan(flowId);
        if (!plan.has_candidate) {
          // 没有可冲单据：正常保存流水，只提示一句，不报错（需求 T4 第 5 条）
          void message.info(plan.message || '本次未找到可冲销的应付单');
          return;
        }
        setOffset({
          open: true,
          type: arapType,
          projectId: created.project_id,
          fundsFlowId: flowId,
          amount: Number(created.amount ?? 0),
          date: created.biz_date,
          partner: created.partner ?? null,
          presetOffsets: plan.plan.map((item) => ({
            ar_ap_id: item.ar_ap_id,
            amount: Number(item.amount_to_offset),
          })),
          planHint: plan.message,
        });
      } catch {
        // 取方案失败不该挡住记账：退回手工冲销入口
        setOffset({
          open: true,
          type: arapType,
          projectId: created.project_id,
          fundsFlowId: flowId,
          amount: Number(created.amount ?? 0),
          date: created.biz_date,
          partner: created.partner ?? null,
        });
      }
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  };

  /**
   * 冲销结果窗（需求 T4）：明确告诉用户冲了哪几张单、每张多少、还剩多少没冲；
   * 并给一个「撤销并重选」——一键撤销本次自动冲销，然后弹回手工勾选窗口。
   */
  const showOffsetResult = (result: OffsetApplyResult, dir: FundDirection) => {
    const type: ArApType = dir === 'in' ? 'receivable' : 'payable';
    const refresh = () => void load();
    const undoAll = async () => {
      try {
        for (const offsetId of result.offset_ids) {
          await arapApi.revokeOffset(offsetId);
        }
        void message.success('已撤销本次冲销，请重新选择要冲销的单据');
        refresh();
        // 撤销后弹回手工勾选（不带预冲方案）
        setOffset({
          open: true,
          type,
          projectId: currentProjectId ?? null,
          fundsFlowId: result.funds_flow_id,
          amount:
            Number(result.offset_amount ?? 0) + Number(result.flow_offset_remaining ?? 0),
          date: null,
          partner: null,
          presetOffsets: null,
          planHint: null,
        });
      } catch {
        /* 拦截器已提示 */
      }
    };

    Modal.info({
      title: '冲销完成',
      width: 560,
      okText: '知道了',
      content: (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <div>
            <Text>
              本次共冲销 <Text strong>{result.items.length}</Text> 张单据，合计{' '}
              <MoneyText value={result.offset_amount} bold />
            </Text>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {result.items.map((item) => (
              <li key={item.ar_ap_id} style={{ fontSize: 13 }}>
                单据 #{item.ar_ap_id}
                {item.biz_type_label ? `（${item.biz_type_label}）` : ''}
                {item.biz_date ? ` ${item.biz_date}` : ''}
                {item.partner ? ` ${item.partner}` : ''} —— 冲销 <MoneyText value={item.amount} />
              </li>
            ))}
          </ul>
          <div>
            {Number(result.flow_offset_remaining ?? 0) > 0 ? (
              <Text>
                还剩 <MoneyText value={result.flow_offset_remaining} bold /> 未冲销，
                已留在本笔流水上作为可冲余额（以后可在「往来」页继续冲）。
              </Text>
            ) : (
              <Text type="secondary">本笔金额已全部冲销。</Text>
            )}
          </div>
          {result.offset_ids.length > 0 && (
            <Button size="small" onClick={() => void undoAll()}>
              撤销并重选
            </Button>
          )}
        </Space>
      ),
    });
  };

  const handleDelete = (row: FundsFlow) => {
    Modal.confirm({
      title: '删除这条流水？',
      okType: 'danger',
      content: '软删除后列表默认不再显示；若已产生冲销记录，需先撤销冲销。',
      onOk: async () => {
        try {
          await fundsApi.remove(row.id);
          void message.success('已删除');
          await load();
        } catch (error) {
          if (error instanceof ApiError && error.code === 409) {
            void message.warning('该流水已产生冲销记录，请先到「往来」页撤销冲销');
          }
        }
      },
    });
  };

  const columns: ColumnsType<FundsFlow> = [
    { title: '日期', dataIndex: 'biz_date', width: 96 },
    { title: '项目', dataIndex: 'project_name', width: 140, render: (v: string) => v || '-' },
    // 不再显示「收付」列：列表已按顶部切换（收款/付款）过滤，每行都是同一种方向，该列没有信息量
    {
      title: '类型',
      dataIndex: 'biz_type',
      width: 90,
      render: (value: FundBizType) => FUND_BIZ_TYPE_LABEL[value] ?? value,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (value: number, row) => (
        <MoneyText value={value} style={{ color: row.direction === 'in' ? '#389e0d' : '#cf1322' }} />
      ),
    },
    { title: '对方', dataIndex: 'partner', width: 130, render: (v: string) => v || '-' },
    {
      title: '支付方式',
      dataIndex: 'pay_method',
      width: 90,
      render: (value: PayMethod | null) => (value ? PAY_METHOD_LABEL[value] : '-'),
    },
    { title: '备注', dataIndex: 'remark', width: 150, render: (v: string) => v || '-' },
    {
      title: '操作',
      key: 'action',
      width: 200,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            icon={<SwapOutlined />}
            onClick={() =>
              setOffset({
                open: true,
                type: row.direction === 'in' ? 'receivable' : 'payable',
                projectId: row.project_id,
                fundsFlowId: row.id,
                amount: Number(row.amount ?? 0),
                date: row.biz_date,
                partner: row.partner ?? null,
              })
            }
          >
            冲销
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const bizTypeOptions = toOptions(
    FUND_BIZ_TYPE_LABEL,
    modalDirection === 'in' ? IN_BIZ_TYPES : OUT_BIZ_TYPES,
  );

  return (
    <div className="pims-page">
      <PageToolbar
        showDateRange
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        showExport
        extra={
          <Space size={8}>
            <Select
              placeholder="业务类型"
              allowClear
              style={{ width: 130 }}
              value={bizType}
              options={toOptions(FUND_BIZ_TYPE_LABEL)}
              onChange={(value) => {
                setPage(1);
                setBizType(value);
              }}
            />
            <Select
              placeholder="支付方式"
              allowClear
              style={{ width: 120 }}
              value={payMethod}
              options={toOptions(PAY_METHOD_LABEL, PAY_METHODS)}
              onChange={(value) => {
                setPage(1);
                setPayMethod(value);
              }}
            />
            <Input.Search
              placeholder="搜索对方 / 备注"
              allowClear
              style={{ width: 200 }}
              onSearch={(value) => {
                setPage(1);
                setKeyword(value.trim());
              }}
            />
          </Space>
        }
        actions={
          <>
            {/* 收款 / 付款 用一个切换控件区分，不再并排两个按钮（需求 T2） */}
            <Segmented<FundDirection>
              value={direction}
              onChange={(value) => {
                setPage(1);
                setBizType(undefined); // 业务类型选项随收/付不同，切换时清掉避免留下非法筛选
                setDirection(value);
              }}
              options={[
                { label: '收款', value: 'in' },
                { label: '付款', value: 'out' },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            {direction === 'in' ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('in')}>
                新增收款
              </Button>
            ) : (
              <Button danger type="primary" icon={<PlusOutlined />} onClick={() => openCreate('out')}>
                新增付款
              </Button>
            )}
          </>
        }
      />
      <div className="pims-page-body">
        <Card styles={{ body: { padding: 0 } }}>
          <DataTable<FundsFlow>
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
            scroll={{ x: 1076 }}
          />
        </Card>
        <div className="pims-total-bar">
          {/* 列表已按顶部切换过滤，合计只显示当前方向，避免"只看付款却还显示合计收款" */}
          {direction === 'in' ? (
            <span>
              合计收款：<MoneyText value={summary?.total_in ?? 0} bold style={{ color: '#389e0d' }} />
            </span>
          ) : (
            <span>
              合计付款：<MoneyText value={summary?.total_out ?? 0} bold style={{ color: '#cf1322' }} />
            </span>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            资金流水只反映钱的进出，不参与利润计算
          </Text>
        </div>
      </div>

      <Modal
        title={editing ? '编辑流水' : modalDirection === 'in' ? '新增收款' : '新增付款'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={saving}
        destroyOnClose
        width={560}
      >
        <Form<FundsFormValues> form={form} layout="vertical">
          <Form.Item label="项目" name="project_id" rules={[{ required: true, message: '请选择项目' }]}>
            <ProjectField />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item
              label="金额"
              name="amount"
              rules={[{ required: true, message: '请填写金额' }]}
              style={{ width: 220 }}
            >
              <MoneyInput />
            </Form.Item>
            <Form.Item
              label="日期"
              name="biz_date"
              rules={[{ required: true, message: '请选择日期' }]}
              style={{ width: 180 }}
              extra={
                bizDateValue && dayjs(bizDateValue).isAfter(dayjs(), 'day') ? (
                  <span style={{ color: '#d46b08' }}>未来日期，确认？</span>
                ) : undefined
              }
            >
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item label="业务类型" name="biz_type" style={{ width: 180 }}>
              <Select options={bizTypeOptions} />
            </Form.Item>
            <Form.Item label="支付方式" name="pay_method" style={{ width: 160 }}>
              <Select options={toOptions(PAY_METHOD_LABEL, PAY_METHODS)} allowClear />
            </Form.Item>
            <Form.Item label="对方" name="partner" style={{ width: 240 }}>
              <DictSelect
                dictType="partner"
                inputMode="free"
                placeholder={modalDirection === 'in' ? '收自谁（可直接输入）' : '付给谁（可直接输入）'}
              />
            </Form.Item>
          </Space>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>

      <OffsetModal
        open={offset.open}
        onClose={() => setOffset((prev) => ({ ...prev, open: false }))}
        onDone={(result) => {
          void load();
          // 冲销完成后弹结果窗：冲了哪几张、每张多少、还剩多少（需求 T4）
          if (result) showOffsetResult(result, offset.type === 'receivable' ? 'in' : 'out');
          setOffset((prev) => ({ ...prev, open: false, presetOffsets: null, planHint: null }));
        }}
        type={offset.type}
        projectId={offset.projectId}
        fundsFlowId={offset.fundsFlowId ?? null}
        flowAmount={offset.amount ?? null}
        flowDate={offset.date ?? null}
        flowPartner={offset.partner ?? null}
        presetOffsets={offset.presetOffsets ?? null}
        planHint={offset.planHint ?? null}
      />
    </div>
  );
}

/** 表单内的项目下拉：选中后同步全局「当前项目」 */
function ProjectField({
  value,
  onChange,
}: {
  value?: number | null;
  onChange?: (value: number | null) => void;
}) {
  const setCurrentProjectId = useAppStore((s) => s.setCurrentProjectId);
  return (
    <ProjectSelect
      value={value ?? null}
      allowAll={false}
      onChange={(id) => {
        onChange?.(id);
        if (id) setCurrentProjectId(id);
      }}
    />
  );
}
