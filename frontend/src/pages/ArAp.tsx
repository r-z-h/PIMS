import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable';
import DictSelect from '../components/DictSelect';
import MoneyInput from '../components/MoneyInput';
import MoneyText from '../components/MoneyText';
import OffsetModal from '../components/OffsetModal';
import PageToolbar from '../components/PageToolbar';
import ProjectSelect from '../components/ProjectSelect';
import { arapApi } from '../api/arap';
import { useAppStore } from '../store/app';
import { useDateRange } from '../hooks/useDateRange';
import { ApiError } from '../types/api';
import type {
  ArApDetail,
  ArApItem,
  ArApSummary,
  ArApType,
  FundBizType,
  PayMethod,
  SettleType,
} from '../types';
import { addMoney, subMoney } from '../utils/money';
import {
  ARAP_STATUS_LABEL,
  ARAP_TYPE_LABEL,
  FUND_BIZ_TYPE_LABEL,
  PAYABLE_BIZ_TYPES,
  RECEIVABLE_BIZ_TYPES,
  toOptions,
} from '../utils/enums';

const { Text } = Typography;

interface ArApFormValues {
  project_id: number;
  biz_type: FundBizType;
  amount: number | null;
  biz_date: string;
  partner?: string;
  pay_method?: PayMethod;
  remark?: string;
}

/**
 * 应付单的业务类型 → 结算类别。
 *
 * 两者**不是同一套取值**：垫付走账时是 `advance_pay`（垫付），
 * 而结算类别叫 `advance`（与成本类别 cost.type 对齐）。
 * 直接把 biz_type 当 cost_type 传会报
 * 「cost_type Input should be 'labor','material','machine','misc' or 'advance'」。
 */
const SETTLE_TYPE_OF_BIZ: Record<string, SettleType> = {
  labor: 'labor',
  material: 'material',
  machine: 'machine',
  misc: 'misc',
  advance_pay: 'advance',
  advance: 'advance',
};

/**
 * 需求 T7（2026-10-16 扩展）：**所有应付单**的付账都在「结算」页办，本页只做跳转。
 *
 * 五类的结算机制相同（预览 → 结算单 → 发放 → 冲销应付单），只是汇总依据不同，
 * 所以跳转时要带上 `cost_type`（决定结算页切到哪个页签）与 `partner`（定位到哪一行）。
 * 应收单不受影响——那是甲方回款，仍在「收/付款」页收款，本页可查看。
 */
function settleUrl(row: ArApItem): string {
  const partner = row.partner ? `&partner=${encodeURIComponent(row.partner)}` : '';
  // 认不出的业务类型（如 other）兜底成人工，至少能落到一个有效页签而不是报错
  const costType = SETTLE_TYPE_OF_BIZ[row.biz_type] ?? 'labor';
  return `/labor-settle?project_id=${row.project_id}&cost_type=${costType}${partner}`;
}

/** 应付单是否该跳去「结算」页（人工/材料/机械/杂费/垫付 都算） */
function isSettlePayable(row: ArApItem): boolean {
  return row.type === 'payable';
}

/** 往来：应收应付 + 手工冲销（docs/01-开发手册.md 5.6） */
export default function ArAp() {
  const [activeType, setActiveType] = useState<ArApType>('receivable');
  const [refreshKey, setRefreshKey] = useState(0);
  const { dateRange, setDateRange } = useDateRange();
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const showDeleted = useAppStore((s) => s.showDeleted);

  const [summary, setSummary] = useState<ArApSummary>({
    receivable_unsettled: 0,
    payable_unsettled: 0,
  });

  const loadSummary = useCallback(async () => {
    const data = await arapApi.summary({
      project_id: currentProjectId ?? undefined,
      start_date: dateRange.start_date,
      end_date: dateRange.end_date,
    });
    setSummary(data);
  }, [currentProjectId, dateRange.start_date, dateRange.end_date]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary, refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="pims-page">
      <PageToolbar
        showProject
        showDateRange
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        showExport
        actions={
          <Button icon={<ReloadOutlined />} onClick={refresh}>
            刷新
          </Button>
        }
      />
      <div className="pims-page-body">
        <Card styles={{ body: { paddingTop: 0 } }}>
          <Tabs
            activeKey={activeType}
            onChange={(key) => setActiveType(key as ArApType)}
            items={[
              { key: 'receivable', label: '应收单', children: null },
              { key: 'payable', label: '应付单', children: null },
            ]}
          />
          <ArApPanel
            key={`${activeType}-${refreshKey}-${currentProjectId ?? 'all'}`}
            type={activeType}
            projectId={currentProjectId}
            dateRange={dateRange}
            showDeleted={showDeleted}
            onChanged={() => {
              refresh();
              void loadSummary();
            }}
          />
        </Card>
        <div className="pims-total-bar">
          <span>
            该收未收合计：
            <MoneyText value={summary.receivable_unsettled} bold style={{ color: '#cf1322' }} />
          </span>
          <span>
            该付未付合计：
            <MoneyText value={summary.payable_unsettled} bold style={{ color: '#d46b08' }} />
          </span>
          <Text type="secondary" style={{ fontSize: 12 }}>
            应收应付不参与利润计算
          </Text>
        </div>
      </div>
    </div>
  );
}

interface ArApPanelProps {
  type: ArApType;
  projectId: number | null;
  dateRange: { start_date?: string; end_date?: string };
  showDeleted: boolean;
  onChanged: () => void;
}

function ArApPanel({ type, projectId, dateRange, showDeleted, onChanged }: ArApPanelProps) {
  const navigate = useNavigate();
  const [form] = Form.useForm<ArApFormValues>();
  const [rows, setRows] = useState<ArApItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ArApItem | null>(null);
  const [saving, setSaving] = useState(false);

  // 冲销弹窗固定作用在「这张单据所属的项目」上：
  // 不能用全局当前项目 —— 顶部没选项目（或选了别的项目）时，待结单据会查成空列表。
  const [offset, setOffset] = useState<{
    open: boolean;
    presetArApId: number | null;
    projectId: number | null;
  }>({
    open: false,
    presetArApId: null,
    projectId: null,
  });

  const [detail, setDetail] = useState<ArApDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const bizTypeOptions = toOptions(
    FUND_BIZ_TYPE_LABEL,
    type === 'receivable' ? RECEIVABLE_BIZ_TYPES : PAYABLE_BIZ_TYPES,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await arapApi.list({
        type,
        page,
        page_size: pageSize,
        project_id: projectId ?? undefined,
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
        status,
        keyword: keyword || undefined,
        include_deleted: showDeleted,
      });
      setRows(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch {
      /* 拦截器已提示 */
    } finally {
      setLoading(false);
    }
  }, [type, page, pageSize, projectId, dateRange.start_date, dateRange.end_date, status, keyword, showDeleted]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      project_id: projectId ?? undefined,
      biz_type: type === 'receivable' ? 'progress' : 'material',
      biz_date: dayjs().format('YYYY-MM-DD'),
      amount: null,
    });
    setModalOpen(true);
  };

  const openEdit = (row: ArApItem) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      project_id: row.project_id,
      biz_type: row.biz_type,
      amount: Number(row.amount ?? 0),
      biz_date: row.biz_date,
      partner: row.partner ?? undefined,
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
        type,
        biz_type: values.biz_type,
        amount: values.amount ?? 0,
        biz_date: values.biz_date,
        partner: values.partner ?? null,
        remark: values.remark ?? null,
      };
      if (editing) {
        await arapApi.update(editing.id, payload);
        void message.success('单据已更新');
      } else {
        await arapApi.create(payload);
        void message.success(type === 'receivable' ? '应收单已录入' : '应付单已录入');
      }
      setModalOpen(false);
      await load();
      onChanged();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (row: ArApItem) => {
    Modal.confirm({
      title: '删除这张单据？',
      okType: 'danger',
      content: '软删除后列表默认不再显示；已产生冲销记录的单据需先撤销冲销。',
      onOk: async () => {
        try {
          await arapApi.remove(row.id);
          void message.success('已删除');
          await load();
          onChanged();
        } catch (error) {
          if (error instanceof ApiError && error.code === 409) {
            void message.warning('该单据已有冲销记录，请先在「冲销历史」中撤销');
          }
        }
      },
    });
  };

  const openDetail = async (row: ArApItem) => {
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      setDetail(await arapApi.detail(row.id));
    } finally {
      setDetailLoading(false);
    }
  };

  const revokeOffset = (offsetId: number) => {
    Modal.confirm({
      title: '撤销这条冲销？',
      content: '撤销后单据未结金额与状态会回滚（不影响成本与利润）。',
      onOk: async () => {
        await arapApi.revokeOffset(offsetId);
        void message.success('已撤销冲销');
        if (detail) setDetail(await arapApi.detail(detail.item.id));
        await load();
        onChanged();
      },
    });
  };

  const columns: ColumnsType<ArApItem> = [
    { title: '日期', dataIndex: 'biz_date', width: 96, fixed: 'left' },
    { title: '项目', dataIndex: 'project_name', width: 120, ellipsis: true, render: (v: string) => v || '-' },
    {
      title: '类型',
      dataIndex: 'biz_type',
      width: 90,
      render: (value: FundBizType) => FUND_BIZ_TYPE_LABEL[value] ?? value,
    },
    { title: '对方', dataIndex: 'partner', width: 110, ellipsis: true, render: (v: string) => v || '-' },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 110,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '已冲销',
      dataIndex: 'settled_amount',
      width: 100,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '未结',
      key: 'unsettled',
      width: 100,
      align: 'right',
      render: (_: unknown, row) => (
        <MoneyText value={row.unsettled ?? subMoney(row.amount, row.settled_amount)} bold />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (value: ArApItem['status']) => (
        <Tag color={value === 'closed' ? 'green' : value === 'partial' ? 'orange' : 'default'}>
          {ARAP_STATUS_LABEL[value] ?? value}
        </Tag>
      ),
    },
    // 备注不在此列表展示（手册 5.6 的列清单里没有它），详情抽屉里可看，避免操作列被挤到换行/溢出
    {
      title: '操作',
      key: 'action',
      width: 290,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Space size={0}>
          {isSettlePayable(row) ? (
            // 需求 T7：应付单的付账统一走「结算」页（五类都算），这里不再直接付，只做跳转。
            // 理由：人工费有两个付款口子会互相打架（结算页说已发、往来页说还欠着）；
            // 往来页保留这张单是为了"我欠谁的全面清单"能对上总数。
            <Tooltip title="付账统一在「结算」页按对象发放，点此跳转">
              <Button
                type="link"
                size="small"
                icon={<TeamOutlined />}
                disabled={row.status === 'closed'}
                onClick={() => navigate(settleUrl(row))}
              >
                去结算
              </Button>
            </Tooltip>
          ) : (
            <Button
              type="link"
              size="small"
              icon={<SwapOutlined />}
              disabled={row.status === 'closed'}
              onClick={() => setOffset({ open: true, presetArApId: row.id, projectId: row.project_id })}
            >
              {type === 'receivable' ? '收款' : '付款'}
            </Button>
          )}
          <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => void openDetail(row)}>
            冲销历史
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

  const unsettledTotal = useMemo(
    () => addMoney(...rows.map((row) => row.unsettled ?? subMoney(row.amount, row.settled_amount))),
    [rows],
  );

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap' }} size={12}>
        <Space size={8} wrap>
          <Select
            placeholder="全部状态"
            allowClear
            style={{ width: 130 }}
            value={status}
            options={toOptions(ARAP_STATUS_LABEL)}
            onChange={(value) => {
              setPage(1);
              setStatus(value);
            }}
          />
          <Input.Search
            placeholder="搜索对方 / 备注"
            allowClear
            style={{ width: 220 }}
            onSearch={(value) => {
              setPage(1);
              setKeyword(value.trim());
            }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            当前筛选未结合计 <MoneyText value={unsettledTotal} bold />
          </Text>
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增{ARAP_TYPE_LABEL[type]}单
        </Button>
      </Space>

      <DataTable<ArApItem>
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
        scroll={{ x: 1060 }}
        locale={{ emptyText: `暂无${ARAP_TYPE_LABEL[type]}单` }}
      />

      <Modal
        title={editing ? `编辑${ARAP_TYPE_LABEL[type]}单` : `新增${ARAP_TYPE_LABEL[type]}单`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={saving}
        destroyOnClose
        width={560}
      >
        <Form<ArApFormValues> form={form} layout="vertical">
          <Form.Item label="项目" name="project_id" rules={[{ required: true, message: '请选择项目' }]}>
            <ProjectSelect allowAll={false} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item
              label="金额"
              name="amount"
              rules={[{ required: true, message: '请填写金额' }]}
              style={{ width: 200 }}
              extra={editing ? '金额不得小于已冲销额' : undefined}
            >
              <MoneyInput />
            </Form.Item>
            <Form.Item
              label="单据日期"
              name="biz_date"
              rules={[{ required: true, message: '请填写日期' }]}
              style={{ width: 170 }}
            >
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item label="业务类型" name="biz_type" style={{ width: 160 }}>
              <Select options={bizTypeOptions} />
            </Form.Item>
          </Space>
          <Form.Item label="对方" name="partner">
            <DictSelect
              dictType="partner"
              inputMode="free"
              placeholder={type === 'receivable' ? '甲方 / 业主（可直接输入）' : '供应商 / 工人（可直接输入）'}
            />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>

      <OffsetModal
        open={offset.open}
        onClose={() => setOffset({ open: false, presetArApId: null, projectId: null })}
        onDone={() => {
          void load();
          onChanged();
        }}
        type={type}
        projectId={offset.projectId ?? projectId}
        presetArApId={offset.presetArApId}
      />

      <Drawer
        title={`${ARAP_TYPE_LABEL[type]}单冲销历史`}
        width={520}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        loading={detailLoading}
      >
        {detail && (
          <>
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'date', label: '单据日期', children: detail.item.biz_date },
                {
                  key: 'type',
                  label: '业务类型',
                  children: FUND_BIZ_TYPE_LABEL[detail.item.biz_type] ?? detail.item.biz_type,
                },
                { key: 'partner', label: '对方', children: detail.item.partner || '-' },
                {
                  key: 'amount',
                  label: '单据金额',
                  children: <MoneyText value={detail.item.amount} />,
                },
                {
                  key: 'settled',
                  label: '已冲销',
                  children: <MoneyText value={detail.item.settled_amount} />,
                },
                {
                  key: 'unsettled',
                  label: '未结',
                  children: (
                    <MoneyText value={detail.item.unsettled ?? subMoney(detail.item.amount, detail.item.settled_amount)} bold />
                  ),
                },
                {
                  key: 'status',
                  label: '状态',
                  children: ARAP_STATUS_LABEL[detail.item.status] ?? detail.item.status,
                },
              ]}
            />
            <Space style={{ margin: '12px 0', width: '100%', justifyContent: 'space-between' }}>
              <Text strong>冲销记录</Text>
              {isSettlePayable(detail.item) ? (
                // 需求 T7：应付单不在本页付，跳到「结算」页按对象发放（并定位到该行）
                <Tooltip title="付账统一在「结算」页按对象发放，点此跳转">
                  <Button
                    size="small"
                    icon={<TeamOutlined />}
                    disabled={detail.item.status === 'closed'}
                    onClick={() => {
                      setDetailOpen(false);
                      navigate(settleUrl(detail.item));
                    }}
                  >
                    去结算
                  </Button>
                </Tooltip>
              ) : (
                <Button
                  size="small"
                  icon={<SwapOutlined />}
                  disabled={detail.item.status === 'closed'}
                  onClick={() => {
                    setDetailOpen(false);
                    setOffset({ open: true, presetArApId: detail.item.id, projectId: detail.item.project_id });
                  }}
                >
                  {type === 'receivable' ? '再收一笔' : '再付一笔'}
                </Button>
              )}
            </Space>
            {detail.offsets.length === 0 ? (
              <Text type="secondary">暂无冲销记录</Text>
            ) : (
              <DataTable
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={detail.offsets}
                scroll={undefined}
                columns={[
                  { title: '冲销日期', dataIndex: 'offset_date', width: 110 },
                  {
                    title: '金额',
                    dataIndex: 'amount',
                    width: 120,
                    align: 'right',
                    render: (value: number) => <MoneyText value={value} />,
                  },
                  { title: '备注', dataIndex: 'remark', render: (v: string) => v || '-' },
                  {
                    title: '操作',
                    key: 'action',
                    width: 80,
                    render: (_: unknown, row: { id: number }) => (
                      <Button type="link" size="small" danger onClick={() => revokeOffset(row.id)}>
                        撤销
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </>
        )}
      </Drawer>
    </>
  );
}
