import { useEffect, useState } from 'react';
import { Alert, Form, Input, Modal, Select, Space, Typography, message } from 'antd';
import MoneyInput from './MoneyInput';
import MoneyText from './MoneyText';
import { costApi } from '../api/costs';
import type { CostPayableSummary, PayMethod } from '../types';
import { addMoney, fmtMoney } from '../utils/money';
import { PAY_METHOD_LABEL, PAY_METHODS } from '../utils/enums';

const { Text } = Typography;

export interface CostPaymentModalProps {
  open: boolean;
  /** 刚录入的那笔成本 id（null 表示不展示） */
  costId: number | null;
  /** 该笔成本的名称，用于标题（如「材料 · 水泥」） */
  costLabel?: string;
  onClose: () => void;
  /** 登记完成或直接关闭后回调（用于刷新列表） */
  onDone?: () => void;
}

/**
 * 录完成本后的「登记已付」弹窗。
 *
 * 口径（与需求方确认）：
 * - 四个字段**全部选填**，可以一次填完，也可以只填已付金额，也可以直接关掉
 * - 填了已付金额 > 0 → 生成一笔付款流水，并自动冲销这张应付单
 * - 直接关掉 / 不填金额 → 当作已付 0，应付单全额挂账，以后在「往来」页完善
 *
 * 应付单本身在录成本时就已经由后端生成，这个弹窗只是**顺手登记付款**，不是必填步骤。
 */
export function CostPaymentModal({ open, costId, costLabel, onClose, onDone }: CostPaymentModalProps) {
  const [form] = Form.useForm<{
    paid_amount?: number | null;
    pay_method?: PayMethod;
    pay_date?: string;
    remark?: string;
  }>();
  const [summary, setSummary] = useState<CostPayableSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !costId) {
      setSummary(null);
      return;
    }
    setLoading(true);
    costApi
      .payable(costId)
      .then((data) => {
        setSummary(data);
        // 付款日期默认今天；已付金额留空（由用户决定）
        form.setFieldsValue({ pay_date: new Date().toISOString().slice(0, 10) });
      })
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, [open, costId, form]);

  const submit = async () => {
    if (!costId) return;
    const values = form.getFieldsValue();
    setSubmitting(true);
    try {
      const result = await costApi.pay(costId, {
        paid_amount: values.paid_amount ?? null,
        pay_method: values.pay_method ?? null,
        pay_date: values.pay_date ?? null,
        remark: values.remark ?? null,
      });

      if (result.recorded) {
        void message.success(
          `已登记付款 ${fmtMoney(result.paid_amount ?? 0)}；对应应付单未结 ${fmtMoney(result.arap?.unsettled ?? 0)}`,
        );
        if (result.flow_unapplied_hint) {
          void message.info(result.flow_unapplied_hint);
        }
      } else {
        void message.info(result.reason ?? '未填已付金额，应付单全额挂账');
      }
      onDone?.();
      onClose();
      form.resetFields();
    } catch {
      /* 错误提示由响应拦截器统一处理（例如已付超过未结的 400） */
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    const paid = form.getFieldValue('paid_amount');
    if (paid) {
      void message.info('未提交，已付金额没有登记；应付单仍为全额挂账');
    } else {
      void message.info('未填已付金额，应付单全额挂账，以后可在「往来」页完善');
    }
    onDone?.();
    onClose();
    form.resetFields();
  };

  const amount = Number(summary?.arap?.amount ?? 0);
  const paid = Number(summary?.paid_total ?? 0);
  const unsettled = Number(summary?.unsettled ?? amount);

  return (
    <Modal
      title={costLabel ? `已记账：${costLabel} —— 登记已付（可跳过）` : '登记已付（可跳过）'}
      open={open}
      onCancel={handleClose}
      onOk={() => void submit()}
      okText="登记"
      cancelText="稍后再说"
      confirmLoading={submitting}
      maskClosable={false}
      destroyOnClose
      width={560}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <Space size={6} wrap>
            <Text>已自动生成应付单：</Text>
            <Text strong>
              <MoneyText value={amount} />
            </Text>
            <Text type="secondary">（金额＝成本全额）</Text>
          </Space>
        }
        description={
          <Text type="secondary" style={{ fontSize: 12 }}>
            下面四项都是选填：可以一次填完，也可以只填已付金额，或者直接点「稍后再说」——
            不填就当作已付 0，应付单全额挂账，以后在「往来」页的「再付一笔」里完善。
            {paid > 0 && ` 当前已付 ${fmtMoney(paid)}，未结 ${fmtMoney(unsettled)}。`}
          </Text>
        }
      />
      <Form form={form} layout="vertical" disabled={loading}>
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item label="已付金额" name="paid_amount" style={{ width: 200 }}>
            <MoneyInput placeholder="选填，例如 3000" />
          </Form.Item>
          <Form.Item label="支付方式" name="pay_method" style={{ width: 150 }}>
            <Select
              allowClear
              placeholder="选填"
              options={PAY_METHODS.map((m) => ({ value: m, label: PAY_METHOD_LABEL[m] }))}
            />
          </Form.Item>
          <Form.Item label="付款日期" name="pay_date" style={{ width: 160 }}>
            <Input type="date" />
          </Form.Item>
        </Space>
        <Form.Item label="备注" name="remark">
          <Input.TextArea rows={2} placeholder="选填" />
        </Form.Item>
      </Form>
      <Text type="secondary" style={{ fontSize: 12 }}>
        填了已付金额后会生成一笔付款流水并自动冲销这张应付单（可在「收/付款」和「往来」页看到）；
        金额上限是这张应付单的未结金额。
      </Text>
      {costId && (
        <div style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            未结金额：
            <MoneyText value={addMoney(unsettled)} /> （成本 #{costId}）
          </Text>
        </div>
      )}
    </Modal>
  );
}

export default CostPaymentModal;
