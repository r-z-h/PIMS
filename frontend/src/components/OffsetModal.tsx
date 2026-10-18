import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Divider, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import MoneyInput from './MoneyInput';
import MoneyText from './MoneyText';
import DictSelect from './DictSelect';
import { arapApi } from '../api/arap';
import { fundsApi } from '../api/funds';
import type { ArApItem, ArApType, FundBizType, PayMethod } from '../types';
import { addMoney, subMoney, toScaled } from '../utils/money';
import {
  ARAP_TYPE_LABEL,
  FUND_BIZ_TYPE_LABEL,
  OUT_BIZ_TYPES,
  PAY_METHODS,
  PAY_METHOD_LABEL,
  RECEIVABLE_BIZ_TYPES,
  toOptions,
} from '../utils/enums';

export interface OffsetModalProps {
  open: boolean;
  onClose: () => void;
  /** 冲销成功后回调（页面刷新列表） */
  onDone?: (result?: OffsetApplyResult) => void;
  /** 冲销单据类型：收 → receivable / 付 → payable */
  type: ArApType;
  projectId: number | null;
  /** 已存在的收付款流水 id（流水页「立即冲销」传）；不传则在弹窗内新建流水 */
  fundsFlowId?: number | null;
  /** 已有流水金额（决定本次冲销上限） */
  flowAmount?: number | null;
  flowDate?: string | null;
  flowPartner?: string | null;
  /** 预选要冲销的单据（应收/应付行内点「收款/付款」时传入） */
  presetArApId?: number | null;
  /**
   * 预冲方案（需求 T4）：保存付款后按「同项目、同业务类型、日期最早优先」算出的建议冲销明细。
   * 传入时弹窗当作「预冲窗口」用：勾选与金额都按方案预填，**用户可自行增删改**，确认后才真冲。
   */
  presetOffsets?: Array<{ ar_ap_id: number; amount: number }> | null;
  /** 预冲方案的说明文案（显示在弹窗顶部，让用户知道系统是按什么规则算的） */
  planHint?: string | null;
}

interface FlowFormValues {
  amount: number | null;
  biz_date: string;
  partner?: string;
  pay_method?: PayMethod;
  biz_type: FundBizType;
  remark?: string;
}

/** 冲销成功后回传给调用方的结果（用于结果窗，需求 T4） */
export interface OffsetApplyResult {
  funds_flow_id: number;
  /** 本次新建的冲销记录 id（「撤销并重选」按这些 id 撤销） */
  offset_ids: number[];
  offset_amount: number;
  /** 冲完仍留在流水上的可冲余额 */
  flow_offset_remaining: number;
  items: Array<{
    ar_ap_id: number;
    biz_date: string;
    biz_type_label: string;
    partner?: string | null;
    amount: number;
  }>;
}

/** 从后端返回里挑出冲销记录 id（后端字段名是 offset_ids） */
function pickIds(raw: unknown): number[] {
  const data = (raw ?? {}) as { offset_ids?: unknown; offsets?: unknown };
  const source = Array.isArray(data.offset_ids)
    ? data.offset_ids
    : Array.isArray(data.offsets)
      ? data.offsets
      : [];
  return source
    .map((item) => (typeof item === 'number' ? item : Number((item as { id?: number })?.id ?? NaN)))
    .filter((id) => Number.isFinite(id));
}

/** 后端没给剩余金额时按「本次金额 − 已冲销合计」兜底 */
function pickRemaining(raw: unknown, fallback: number): number {
  const data = (raw ?? {}) as { flow_offset_remaining?: unknown; unoffset_amount?: unknown };
  const value = data.flow_offset_remaining ?? data.unoffset_amount;
  return value === undefined || value === null ? fallback : Number(value);
}

/**
 * 冲销弹窗：待结单据手工勾选 + 填本次冲销金额。
 * 默认仍是**手工勾选**（00-需求冻结 R9）；传入 presetOffsets 时作为「预冲窗口」使用：
 * 按后端算好的方案预填（需求 T4），用户可自行增删改，点确认才真冲。
 * 校验：单张冲销额 ≤ 单据未结额；冲销合计 ≤ 本次收付金额。
 */
export function OffsetModal({
  open,
  onClose,
  onDone,
  type,
  projectId,
  fundsFlowId,
  flowAmount,
  flowDate,
  flowPartner,
  presetArApId,
  presetOffsets,
  planHint,
}: OffsetModalProps) {
  const [form] = Form.useForm<FlowFormValues>();
  const [rows, setRows] = useState<ArApItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  const [amounts, setAmounts] = useState<Record<number, number | null>>({});

  const direction: 'in' | 'out' = type === 'receivable' ? 'in' : 'out';
  const flowAmountValue = Form.useWatch('amount', form) as number | null | undefined;
  const flowDateValue = Form.useWatch('biz_date', form) as string | undefined;

  const unsettledOf = useCallback(
    (row: ArApItem) => Number(row.unsettled ?? subMoney(row.amount, row.settled_amount)),
    [],
  );

  const loadPending = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await arapApi.pending(projectId, type);
      setRows(data);
      // 预冲方案优先（需求 T4）：按后端算好的建议预填，用户仍可自行增删改
      if (presetOffsets && presetOffsets.length > 0) {
        const keys: number[] = [];
        const preset: Record<number, number | null> = {};
        presetOffsets.forEach((item) => {
          if (!data.some((r) => r.id === item.ar_ap_id)) return; // 方案里的单据已不在待结列表就跳过
          keys.push(item.ar_ap_id);
          preset[item.ar_ap_id] = Number(item.amount);
        });
        setSelectedKeys(keys);
        setAmounts(preset);
        if (!fundsFlowId) {
          form.setFieldValue(
            'amount',
            presetOffsets.reduce((sum, item) => addMoney(sum, Number(item.amount)), 0),
          );
        }
        return;
      }
      const presetRow = presetArApId ? data.find((r) => r.id === presetArApId) : undefined;
      if (presetRow) {
        const amount = unsettledOf(presetRow);
        setSelectedKeys([presetRow.id]);
        setAmounts({ [presetRow.id]: amount });
        if (!fundsFlowId) form.setFieldValue('amount', amount);
      } else {
        setSelectedKeys([]);
        setAmounts({});
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, type, presetArApId, presetOffsets, fundsFlowId, form, unsettledOf]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      amount: flowAmount ?? null,
      biz_date: flowDate ?? dayjs().format('YYYY-MM-DD'),
      partner: flowPartner ?? undefined,
      pay_method: 'transfer',
      biz_type: type === 'receivable' ? 'progress' : 'material',
    });
    void loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, type]);

  /** 本次收付金额上限（分）；尚无金额时返回 null */
  const capacityCents = useMemo(() => {
    if (fundsFlowId) return toScaled(flowAmount, 2);
    if (flowAmountValue === null || flowAmountValue === undefined) return null;
    return toScaled(flowAmountValue, 2);
  }, [fundsFlowId, flowAmount, flowAmountValue]);

  const selectedTotal = useMemo(
    () => addMoney(...selectedKeys.map((key) => amounts[key] ?? 0)),
    [selectedKeys, amounts],
  );
  const leftCents = capacityCents === null ? null : capacityCents - toScaled(selectedTotal, 2);

  /** 勾选后自动把收付款金额补足到勾选合计（用户填了更大的金额则不动） */
  const syncFlowAmount = (nextAmounts: Record<number, number | null>, nextKeys: number[]) => {
    if (fundsFlowId) return;
    const sum = addMoney(...nextKeys.map((k) => nextAmounts[k] ?? 0));
    const current = form.getFieldValue('amount') as number | null | undefined;
    if (current === null || current === undefined || toScaled(current, 2) < toScaled(sum, 2)) {
      form.setFieldValue('amount', sum);
    }
  };

  const selectRow = (row: ArApItem) => {
    setAmounts((prev) => {
      if (prev[row.id] !== undefined && prev[row.id] !== null) return prev;
      const usedByOthers = addMoney(
        ...selectedKeys.filter((k) => k !== row.id).map((k) => prev[k] ?? 0),
      );
      const capacity = capacityCents === null ? null : capacityCents - toScaled(usedByOthers, 2);
      const target = toScaled(unsettledOf(row), 2);
      const next = {
        ...prev,
        [row.id]: (capacity === null ? target : Math.min(target, Math.max(capacity, 0))) / 100,
      };
      syncFlowAmount(next, [...selectedKeys, row.id]);
      return next;
    });
  };

  const setRowAmount = (id: number, value: number | null) => {
    setAmounts((prev) => {
      const next = { ...prev, [id]: value };
      syncFlowAmount(next, selectedKeys);
      return next;
    });
  };

  const submit = async () => {
    if (!projectId) {
      void message.warning('请先选择项目');
      return;
    }
    const picked = selectedKeys.filter((key) => toScaled(amounts[key] ?? 0, 2) > 0);
    if (picked.length === 0) {
      void message.warning('请至少勾选一张待结单据并填写本次冲销金额');
      return;
    }
    for (const key of picked) {
      const row = rows.find((r) => r.id === key);
      if (row && toScaled(amounts[key] ?? 0, 2) > toScaled(unsettledOf(row), 2)) {
        void message.error(`单据 #${key} 本次冲销金额超过未结金额`);
        return;
      }
    }

    setSubmitting(true);
    try {
      let flowId = fundsFlowId ?? null;
      let offsetDate = flowDate ?? flowDateValue ?? dayjs().format('YYYY-MM-DD');
      let totalFlowAmount = flowAmount ?? 0;

      if (!flowId) {
        const values = await form.validateFields();
        const created = await fundsApi.create({
          project_id: projectId,
          direction,
          biz_type: values.biz_type,
          amount: values.amount ?? 0,
          biz_date: values.biz_date,
          partner: values.partner ?? null,
          pay_method: values.pay_method ?? null,
          remark: values.remark ?? null,
        });
        flowId = created.id;
        offsetDate = values.biz_date;
        totalFlowAmount = values.amount ?? 0;
      }

      if (toScaled(selectedTotal, 2) > toScaled(totalFlowAmount, 2)) {
        void message.error('冲销合计不得超过本次收付金额');
        return;
      }

      const offsetResult = await arapApi.offset({
        funds_flow_id: flowId,
        offsets: picked.map((key) => ({ ar_ap_id: key, amount: amounts[key] ?? 0 })),
        offset_date: offsetDate,
        remark: null,
      });
      void message.success(`冲销成功，本次冲销合计 ${selectedTotal.toFixed(2)} 元`);
      // 把结果交给调用方（需求 T4：结果窗要列出冲了哪几张、还剩多少，并支持「撤销并重选」）
      onDone?.({
        funds_flow_id: flowId,
        offset_ids: pickIds(offsetResult),
        offset_amount: selectedTotal,
        flow_offset_remaining: pickRemaining(offsetResult, totalFlowAmount - selectedTotal),
        items: picked.map((key) => {
          const row = rows.find((r) => r.id === key);
          return {
            ar_ap_id: key,
            biz_date: row?.biz_date ?? '',
            biz_type_label: row?.biz_type_label ?? '',
            partner: row?.partner ?? null,
            amount: amounts[key] ?? 0,
          };
        }),
      });
      onClose();
    } catch {
      /* 错误已由响应拦截器统一提示 */
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<ArApItem> = [
    { title: '日期', dataIndex: 'biz_date', width: 110 },
    {
      title: '类型',
      dataIndex: 'biz_type',
      width: 90,
      render: (value: FundBizType) => FUND_BIZ_TYPE_LABEL[value] ?? value,
    },
    { title: '对方', dataIndex: 'partner', width: 150, render: (v: string) => v || '-' },
    {
      title: '单据金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (value: number) => <MoneyText value={value} />,
    },
    {
      title: '未结金额',
      dataIndex: 'unsettled',
      width: 120,
      align: 'right',
      render: (_: unknown, row) => <MoneyText value={unsettledOf(row)} bold />,
    },
    {
      title: '本次冲销',
      key: 'offset_amount',
      width: 160,
      render: (_: unknown, row) => {
        const checked = selectedKeys.includes(row.id);
        const over = toScaled(amounts[row.id] ?? 0, 2) > toScaled(unsettledOf(row), 2);
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <MoneyInput
              size="small"
              disabled={!checked}
              value={checked ? (amounts[row.id] ?? null) : null}
              onChange={(value) => setRowAmount(row.id, value)}
            />
            {over && <span style={{ color: '#cf1322', fontSize: 12 }}>超过未结金额</span>}
          </Space>
        );
      },
    },
  ];

  const bizTypeOptions = toOptions(
    FUND_BIZ_TYPE_LABEL,
    direction === 'in' ? RECEIVABLE_BIZ_TYPES : OUT_BIZ_TYPES,
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      width={920}
      destroyOnClose
      title={`${ARAP_TYPE_LABEL[type]}冲销 · ${direction === 'in' ? '收款' : '付款'}`}
      okText="确认冲销"
    >
      {/* 预冲方案说明（需求 T4）：让用户知道系统是按什么规则算出来的，且可以自己改 */}
      {planHint ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="已按规则自动勾选，确认前你可以自己增删或改金额"
          description={<span style={{ fontSize: 12 }}>{planHint}</span>}
        />
      ) : null}
      {!fundsFlowId ? (
        <>
          <Divider orientation="left" plain>
            收付款信息
          </Divider>
          <Form<FlowFormValues> form={form} layout="vertical">
            <Space size={12} wrap align="start">
              <Form.Item
                label="本次收付金额"
                name="amount"
                rules={[{ required: true, message: '请填写金额' }]}
                style={{ width: 190 }}
              >
                <MoneyInput />
              </Form.Item>
              <Form.Item
                label="日期"
                name="biz_date"
                rules={[{ required: true, message: '请选择日期' }]}
                style={{ width: 170 }}
              >
                <Input placeholder="YYYY-MM-DD" />
              </Form.Item>
              <Form.Item label="业务类型" name="biz_type" style={{ width: 150 }}>
                <Select options={bizTypeOptions} />
              </Form.Item>
              <Form.Item label="对方" name="partner" style={{ width: 220 }}>
                <DictSelect dictType="partner" inputMode="free" placeholder="付给谁 / 收自谁（可直接输入）" />
              </Form.Item>
              <Form.Item label="支付方式" name="pay_method" style={{ width: 130 }}>
                <Select options={toOptions(PAY_METHOD_LABEL, PAY_METHODS)} />
              </Form.Item>
              <Form.Item label="备注" name="remark" style={{ width: 200 }}>
                <Input placeholder="选填" />
              </Form.Item>
            </Space>
          </Form>
        </>
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`本次${direction === 'in' ? '收款' : '付款'}金额 ${Number(flowAmount ?? 0).toFixed(2)} 元`}
          description="勾选下方待结单据并填写本次冲销金额；也可少于本次收付金额，余额作为预收/预付挂在流水上。"
        />
      )}

      <Divider orientation="left" plain>
        待结单据（手工勾选）
      </Divider>
      <Table<ArApItem>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ y: 260, x: 780 }}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: (keys) => {
            const next = keys.map((k) => Number(k));
            const added = next.find((k) => !selectedKeys.includes(k));
            const removed = selectedKeys.find((k) => !next.includes(k));
            setSelectedKeys(next);
            if (added !== undefined) {
              const row = rows.find((r) => r.id === added);
              if (row) selectRow(row);
            }
            if (removed !== undefined) {
              setAmounts((prev) => ({ ...prev, [removed]: null }));
            }
          },
        }}
        locale={{ emptyText: '该项目下暂无待冲销单据' }}
      />

      <div style={{ marginTop: 12, textAlign: 'right' }}>
        <Space size={16} wrap>
          <span>
            本次冲销合计：<MoneyText value={selectedTotal} bold />
          </span>
          <span>
            本次收付金额：
            <MoneyText value={fundsFlowId ? (flowAmount ?? 0) : (flowAmountValue ?? 0)} />
          </span>
          <span>
            剩余（预收/预付）：
            <MoneyText value={leftCents === null ? 0 : leftCents / 100} colorPositive />
          </span>
          {selectedKeys.length > 0 && <Tag color="blue">已选 {selectedKeys.length} 张</Tag>}
        </Space>
      </div>
    </Modal>
  );
}

export default OffsetModal;
