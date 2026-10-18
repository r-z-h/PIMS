import { useCallback, useEffect, useMemo, useState } from 'react';
import { AutoComplete, Form, Input, InputNumber, Modal, Select, Space, Typography, message } from 'antd';
import dayjs from 'dayjs';
import DictSelect from './DictSelect';
import MoneyInput from './MoneyInput';
import MoneyText from './MoneyText';
import ProjectSelect from './ProjectSelect';
import { costApi } from '../api/costs';
import type { CostItem, CostType, MachineMeasure } from '../types';
import { toOptions } from '../utils/enums';
import { MEASURE_LABEL } from '../utils/enums';
import { mulMoney, toScaled } from '../utils/money';

const { Text } = Typography;

export interface CostFormValues {
  project_id: number;
  biz_date: string;
  remark?: string | null;
  amount?: number | null;
  worker_name?: string;
  work_days?: number;
  day_rate?: number;
  material_name?: string;
  unit?: string;
  quantity?: number;
  unit_price?: number;
  supplier?: string | null;
  machine_name?: string;
  measure?: MachineMeasure;
  lessor?: string | null;
  category?: string;
  payer?: string | null;
  purpose?: string | null;
}

export interface CostFormModalProps {
  open: boolean;
  /** 当前表单对应的成本类别（由外层页签决定） */
  type: CostType;
  /** 传了就进入编辑模式，否则是新增 */
  editing?: CostItem | null;
  /** 新增时的默认项目（一般取顶部当前项目） */
  defaultProjectId?: number | null;
  onCancel: () => void;
  /** 保存成功后回调：新增时带上 cost_id 与描述，便于外层弹「登记已付」 */
  onSaved?: (info: { created: boolean; costId?: number; label?: string }) => void;
}

const TYPE_LABEL: Record<CostType, string> = {
  labor: '人工',
  material: '材料',
  machine: '机械',
  misc: '杂费',
  advance: '垫付',
};

/**
 * 五类成本的录入/编辑表单（记账页与成本页**共用**，避免两份实现走偏）。
 *
 * 只负责「填表 → 调接口 → 回调」；应付单由后端在录成本时自动生成，
 * 「登记已付」由外层的 CostPaymentModal 负责。
 */
export function CostFormModal({
  open,
  type,
  editing = null,
  defaultProjectId = null,
  onCancel,
  onSaved,
}: CostFormModalProps) {
  const [form] = Form.useForm<CostFormValues>();
  const [saving, setSaving] = useState(false);
  const [workerNames, setWorkerNames] = useState<string[]>([]);

  const amountValue = Form.useWatch('amount', form);
  const workDays = Form.useWatch('work_days', form);
  const dayRate = Form.useWatch('day_rate', form);
  const quantity = Form.useWatch('quantity', form);
  const unitPrice = Form.useWatch('unit_price', form);
  const bizDateValue = Form.useWatch('biz_date', form);

  const loadWorkerNames = useCallback(async () => {
    try {
      const data = await costApi.list({ type: 'labor', project_id: defaultProjectId ?? undefined, page: 1, page_size: 200 });
      const names = Array.from(new Set((data.items ?? []).map((item) => item.worker_name).filter(Boolean))) as string[];
      setWorkerNames(names);
    } catch {
      setWorkerNames([]);
    }
  }, [defaultProjectId]);

  /** 打开时初始化：新增给默认值，编辑回填 */
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        project_id: editing.project_id,
        biz_date: editing.biz_date,
        remark: editing.remark ?? undefined,
        amount: Number(editing.amount ?? 0),
        worker_name: editing.worker_name ?? undefined,
        work_days: editing.work_days === null || editing.work_days === undefined ? undefined : Number(editing.work_days),
        day_rate: editing.day_rate === null || editing.day_rate === undefined ? undefined : Number(editing.day_rate),
        material_name: editing.material_name ?? undefined,
        unit: editing.unit ?? undefined,
        quantity: editing.quantity === null || editing.quantity === undefined ? undefined : Number(editing.quantity),
        unit_price: editing.unit_price === null || editing.unit_price === undefined ? undefined : Number(editing.unit_price),
        supplier: editing.supplier ?? undefined,
        machine_name: editing.machine_name ?? undefined,
        measure: (editing.measure ?? 'shift') as MachineMeasure,
        lessor: editing.lessor ?? undefined,
        category: editing.category ?? undefined,
        payer: editing.payer ?? '老板',
        purpose: editing.purpose ?? undefined,
      });
    } else {
      form.setFieldsValue({
        project_id: defaultProjectId ?? undefined,
        biz_date: dayjs().format('YYYY-MM-DD'),
        amount: null,
        measure: 'shift',
        payer: '老板',
      });
    }
    void loadWorkerNames();
  }, [open, editing, defaultProjectId, form, loadWorkerNames]);

  /** 工日×工价 / 数量×单价 → 自动算金额（可手改） */
  const autoAmount = useMemo(() => {
    if (type === 'labor' && workDays && dayRate) return mulMoney(workDays, dayRate);
    if ((type === 'material' || type === 'machine') && quantity && unitPrice) return mulMoney(quantity, unitPrice);
    return null;
  }, [type, workDays, dayRate, quantity, unitPrice]);

  useEffect(() => {
    if (!open) return;
    if (autoAmount !== null && autoAmount > 0) {
      form.setFieldValue('amount', autoAmount);
    }
    // 只在自动可算时覆盖金额；用户手改后不再干预（依赖项变化才会重算）
  }, [open, autoAmount, form]);

  const submit = async () => {
    const values = await form.validateFields();
    if (toScaled(values.amount ?? 0, 2) <= 0) {
      void message.error('金额必须大于 0');
      return;
    }
    setSaving(true);
    let created: { id: number; label: string } | null = null;
    try {
      const base = {
        project_id: values.project_id,
        biz_date: values.biz_date,
        remark: values.remark ?? null,
      };
      if (editing) {
        const payload: Record<string, unknown> = { ...base, amount: values.amount ?? 0 };
        if (type === 'labor') {
          Object.assign(payload, { worker_name: values.worker_name, work_days: values.work_days, day_rate: values.day_rate });
        } else if (type === 'material') {
          Object.assign(payload, {
            material_name: values.material_name,
            unit: values.unit,
            quantity: values.quantity,
            unit_price: values.unit_price,
            supplier: values.supplier ?? null,
          });
        } else if (type === 'machine') {
          Object.assign(payload, {
            machine_name: values.machine_name,
            measure: values.measure,
            quantity: values.quantity,
            unit_price: values.unit_price,
            lessor: values.lessor ?? null,
          });
        } else if (type === 'misc') {
          Object.assign(payload, { category: values.category });
        } else {
          Object.assign(payload, { payer: values.payer ?? null, purpose: values.purpose ?? null });
        }
        await costApi.update(editing.id, payload);
        void message.success('已保存，修改记录可在「修改记录」中查看');
      } else if (type === 'labor') {
        const result = await costApi.createLabor({
          ...base,
          worker_name: values.worker_name ?? '',
          work_days: values.work_days ?? 0,
          day_rate: values.day_rate ?? 0,
          amount: values.amount ?? 0,
        });
        void message.success('工天已录入，人工成本实时入账');
        created = { id: result.cost_id, label: `${TYPE_LABEL.labor} · ${values.worker_name ?? ''}` };
      } else if (type === 'material') {
        const result = await costApi.createMaterial({
          ...base,
          material_name: values.material_name ?? '',
          unit: values.unit ?? '',
          quantity: values.quantity ?? 0,
          unit_price: values.unit_price ?? 0,
          amount: values.amount ?? 0,
          supplier: values.supplier ?? null,
        });
        void message.success(`材料采购已入成本，同时入库（当前余量 ${result.inventory_balance}）`);
        created = { id: result.cost_id, label: `${TYPE_LABEL.material} · ${values.material_name ?? ''}` };
      } else if (type === 'machine') {
        const result = await costApi.createMachine({
          ...base,
          machine_name: values.machine_name ?? '',
          measure: (values.measure ?? 'shift') as MachineMeasure,
          quantity: values.quantity ?? 0,
          unit_price: values.unit_price ?? 0,
          amount: values.amount ?? 0,
          lessor: values.lessor ?? null,
        });
        void message.success('机械费已录入');
        created = { id: result.cost_id, label: `${TYPE_LABEL.machine} · ${values.machine_name ?? ''}` };
      } else if (type === 'misc') {
        const result = await costApi.createMisc({
          ...base,
          category: values.category ?? '',
          amount: values.amount ?? 0,
        });
        void message.success('杂费已录入');
        created = { id: result.cost_id, label: `${TYPE_LABEL.misc} · ${values.category ?? ''}` };
      } else {
        const result = await costApi.createAdvance({
          ...base,
          payer: values.payer ?? null,
          purpose: values.purpose ?? null,
          amount: values.amount ?? 0,
        });
        void message.success('垫付已录入');
        created = { id: result.cost_id, label: `${TYPE_LABEL.advance} · ${values.payer ?? '老板'}` };
      }
      onSaved?.(created ? { created: true, costId: created.id, label: created.label } : { created: false });
    } catch {
      /* 错误提示由响应拦截器统一处理 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? `编辑${TYPE_LABEL[type]}` : `新增${TYPE_LABEL[type]}`}
      open={open}
      onCancel={onCancel}
      onOk={() => void submit()}
      confirmLoading={saving}
      destroyOnClose
      width={640}
    >
      <Form<CostFormValues> form={form} layout="vertical">
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item label="项目" name="project_id" rules={[{ required: true, message: '请选择项目' }]}>
            <ProjectSelect allowAll={false} />
          </Form.Item>
          <Form.Item
            label="发生日期"
            name="biz_date"
            rules={[{ required: true, message: '请填写日期' }]}
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

        {type === 'labor' && (
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item label="姓名" name="worker_name" rules={[{ required: true, message: '姓名必填' }]} style={{ width: 190 }}>
              <AutoComplete
                placeholder="手输姓名（可下拉选历史）"
                options={workerNames.map((n) => ({ value: n }))}
                filterOption={(input, option) => String(option?.value ?? '').includes(input)}
              />
            </Form.Item>
            <Form.Item label="工日数" name="work_days" rules={[{ required: true, message: '工日数必填' }]} style={{ width: 140 }}>
              <InputNumber min={0} step={0.5} precision={2} style={{ width: '100%' }} placeholder="1.0" />
            </Form.Item>
            <Form.Item label="日工价" name="day_rate" rules={[{ required: true, message: '日工价必填' }]} style={{ width: 160 }}>
              <MoneyInput />
            </Form.Item>
          </Space>
        )}

        {type === 'material' && (
          <>
            <Space size={12} style={{ display: 'flex' }} align="start">
              <Form.Item
                label="材料名称"
                name="material_name"
                rules={[{ required: true, message: '材料名称必填' }]}
                style={{ width: 220 }}
              >
                <DictSelect dictType="material" placeholder="选择或新增材料" />
              </Form.Item>
              <Form.Item label="数量" name="quantity" rules={[{ required: true, message: '数量必填' }]} style={{ width: 150 }}>
                <InputNumber min={0} step={1} precision={3} style={{ width: '100%' }} placeholder="100" />
              </Form.Item>
              <Form.Item label="单位" name="unit" rules={[{ required: true, message: '单位必填' }]} style={{ width: 160 }}>
                <DictSelect dictType="unit" placeholder="吨 / 车 / 方" />
              </Form.Item>
            </Space>
            <Space size={12} style={{ display: 'flex' }} align="start">
              <Form.Item label="单价" name="unit_price" rules={[{ required: true, message: '单价必填' }]} style={{ width: 170 }}>
                <MoneyInput />
              </Form.Item>
              <Form.Item label="供应商" name="supplier" style={{ width: 240 }}>
                <DictSelect dictType="partner" inputMode="free" placeholder="某某建材（可直接输入）" />
              </Form.Item>
            </Space>
          </>
        )}

        {type === 'machine' && (
          <>
            <Space size={12} style={{ display: 'flex' }} align="start">
              <Form.Item
                label="设备名称"
                name="machine_name"
                rules={[{ required: true, message: '设备名称必填' }]}
                style={{ width: 220 }}
              >
                <Input placeholder="挖机(小松200) / 泵车" />
              </Form.Item>
              <Form.Item label="计量方式" name="measure" style={{ width: 140 }}>
                <Select options={toOptions(MEASURE_LABEL)} />
              </Form.Item>
              <Form.Item label="数量" name="quantity" rules={[{ required: true, message: '数量必填' }]} style={{ width: 140 }}>
                <InputNumber min={0} step={1} precision={2} style={{ width: '100%' }} placeholder="10" />
              </Form.Item>
            </Space>
            <Space size={12} style={{ display: 'flex' }} align="start">
              <Form.Item label="单价" name="unit_price" rules={[{ required: true, message: '单价必填' }]} style={{ width: 170 }}>
                <MoneyInput />
              </Form.Item>
              <Form.Item label="出租方" name="lessor" style={{ width: 240 }}>
                <DictSelect dictType="partner" inputMode="free" placeholder="李老板（可直接输入）" />
              </Form.Item>
            </Space>
          </>
        )}

        {type === 'misc' && (
          <Form.Item
            label="杂费小类"
            name="category"
            rules={[{ required: true, message: '杂费小类必填' }]}
            style={{ width: 260 }}
          >
            <DictSelect dictType="misc_category" placeholder="伙食费 / 转运费 …" />
          </Form.Item>
        )}

        {type === 'advance' && (
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item label="垫付人" name="payer" style={{ width: 180 }}>
              <Input placeholder="老板" />
            </Form.Item>
            <Form.Item label="垫付事由" name="purpose" style={{ width: 300 }}>
              <Input placeholder="临时买料" />
            </Form.Item>
          </Space>
        )}

        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item
            label="金额"
            name="amount"
            rules={[{ required: true, message: '金额必填' }]}
            style={{ width: 200 }}
            extra={
              type === 'labor'
                ? '默认 工日数 × 日工价，可手改'
                : type === 'material' || type === 'machine'
                  ? '默认 数量 × 单价，可手改'
                  : undefined
            }
          >
            <MoneyInput />
          </Form.Item>
          <Form.Item label="备注" name="remark" style={{ width: 320 }}>
            <Input placeholder="部位、工序等" />
          </Form.Item>
        </Space>
      </Form>

      {amountValue !== null && amountValue !== undefined && (
        <Text type="secondary">
          本次将计入成本：
          <MoneyText value={amountValue} bold /> 元（同时自动生成一张应付单）
        </Text>
      )}
    </Modal>
  );
}

export default CostFormModal;
