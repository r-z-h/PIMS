import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, ImportOutlined, ReloadOutlined, ExportOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import DataTable from '../components/DataTable';
import CostLink from '../components/CostLink';
import DictSelect from '../components/DictSelect';
import MoneyInput from '../components/MoneyInput';
import PageToolbar from '../components/PageToolbar';
import { inventoryApi } from '../api/inventory';
import { useAppStore } from '../store/app';
import { useDateRange } from '../hooks/useDateRange';
import type { InventoryBalance, InventoryTxn } from '../types';
import { fmtMoney, fmtQty, toScaled } from '../utils/money';
import { INV_TXN_TYPE_LABEL, toOptions } from '../utils/enums';

const { Text } = Typography;

/** 库存：先选项目，两张表（库存余量 / 库存流水）（docs/01-开发手册.md 5.7） */
export default function Inventory() {
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const showDeleted = useAppStore((s) => s.showDeleted);
  const { dateRange, setDateRange } = useDateRange();

  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [txns, setTxns] = useState<InventoryTxn[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [txnType, setTxnType] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!currentProjectId) {
      setBalances([]);
      setTxns([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    try {
      const [balanceList, txnList] = await Promise.all([
        inventoryApi.balances(currentProjectId),
        inventoryApi.txns({
          project_id: currentProjectId,
          page,
          page_size: pageSize,
          txn_type: txnType,
          start_date: dateRange.start_date,
          end_date: dateRange.end_date,
          keyword: keyword || undefined,
          include_deleted: showDeleted,
        }),
      ]);
      setBalances(balanceList);
      setTxns(txnList.items ?? []);
      setTotal(txnList.total ?? 0);
    } catch {
      /* 拦截器已提示 */
    } finally {
      setLoading(false);
    }
  }, [currentProjectId, page, pageSize, txnType, dateRange.start_date, dateRange.end_date, keyword, showDeleted]);

  useEffect(() => {
    void load();
  }, [load]);

  const balanceColumns: ColumnsType<InventoryBalance> = [
    { title: '材料', dataIndex: 'material_name' },
    { title: '单位', dataIndex: 'unit', width: 80 },
    {
      title: '入库合计',
      dataIndex: 'in_qty',
      width: 120,
      align: 'right',
      render: (value: number) => fmtQty(value),
    },
    {
      title: '领用合计',
      dataIndex: 'out_qty',
      width: 120,
      align: 'right',
      render: (value: number) => fmtQty(value),
    },
    {
      title: '余量',
      dataIndex: 'balance',
      width: 120,
      align: 'right',
      render: (value: number) => (
        <Text strong type={toScaled(value, 3) < 0 ? 'danger' : undefined}>
          {fmtQty(value)}
        </Text>
      ),
    },
  ];

  const txnColumns: ColumnsType<InventoryTxn> = [
    { title: '日期', dataIndex: 'biz_date', width: 92 },
    { title: '材料', dataIndex: 'material_name', width: 110 },
    { title: '单位', dataIndex: 'unit', width: 56 },
    {
      title: '类型',
      dataIndex: 'txn_type',
      width: 68,
      render: (value: InventoryTxn['txn_type']) => (
        <Tag color={value === 'in' ? 'blue' : 'orange'}>{INV_TXN_TYPE_LABEL[value]}</Tag>
      ),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      width: 84,
      align: 'right',
      render: (value: number) => fmtQty(value),
    },
    {
      title: '单价',
      dataIndex: 'unit_price',
      width: 96,
      align: 'right',
      render: (value: number | null) => (value === null || value === undefined ? '-' : fmtMoney(value)),
    },
    { title: '供应商', dataIndex: 'supplier', width: 100, render: (v: string) => v || '-' },
    {
      title: '关联成本',
      dataIndex: 'cost_id',
      // 列宽之和必须 ≤ 1440 宽下容器内部宽度（1178），否则会被容器横向滚动截断
      width: 232,
      // 显示成 `#17（材料 · 水泥 40,000.00）`，可点击跳到该笔成本、悬停看摘要（需求 T3）
      render: (_: number | null, row: InventoryTxn) => (
        <CostLink costId={row.cost_id} brief={row.cost} label={row.cost_label} />
      ),
    },
    { title: '备注', dataIndex: 'remark', width: 130, render: (v: string) => v || '-' },
    {
      title: '操作',
      key: 'action',
      width: 130,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openTxnEdit(row)}
          >
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              Modal.confirm({
                title: '删除这条库存流水？',
                okType: 'danger',
                content: '软删除后会同步重算库存余量（材料关联的成本不会自动删除）。',
                onOk: async () => {
                  await inventoryApi.removeTxn(row.id);
                  void message.success('已删除');
                  await load();
                },
              });
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const [inForm] = Form.useForm<{
    material_name: string;
    unit: string;
    quantity: number;
    unit_price?: number | null;
    supplier?: string;
    biz_date: string;
    remark?: string;
  }>();
  const [outForm] = Form.useForm<{
    material_name: string;
    unit: string;
    quantity: number;
    biz_date: string;
    remark?: string;
  }>();
  const [txnForm] = Form.useForm<{
    material_name: string;
    unit: string;
    quantity: number;
    unit_price?: number | null;
    supplier?: string;
    biz_date: string;
    remark?: string;
  }>();

  const [inOpen, setInOpen] = useState(false);
  const [outOpen, setOutOpen] = useState(false);
  const [txnOpen, setTxnOpen] = useState(false);
  const [editingTxn, setEditingTxn] = useState<InventoryTxn | null>(null);
  const [saving, setSaving] = useState(false);

  const outMaterial = Form.useWatch('material_name', outForm);
  const outUnit = Form.useWatch('unit', outForm);
  const outQty = Form.useWatch('quantity', outForm);

  const outBalance = useMemo(() => {
    const found = balances.find((b) => b.material_name === outMaterial && b.unit === outUnit);
    return found ? Number(found.balance ?? 0) : null;
  }, [balances, outMaterial, outUnit]);

  const outNotEnough =
    outBalance !== null && outQty !== undefined && outQty !== null
      ? toScaled(outQty, 3) > toScaled(outBalance, 3)
      : false;

  function openTxnEdit(row: InventoryTxn) {
    setEditingTxn(row);
    txnForm.resetFields();
    txnForm.setFieldsValue({
      material_name: row.material_name,
      unit: row.unit,
      quantity: Number(row.quantity ?? 0),
      unit_price: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
      supplier: row.supplier ?? undefined,
      biz_date: row.biz_date,
      remark: row.remark ?? undefined,
    });
    setTxnOpen(true);
  }

  const submitIn = async () => {
    if (!currentProjectId) return;
    const values = await inForm.validateFields();
    setSaving(true);
    try {
      await inventoryApi.in({ project_id: currentProjectId, ...values, remark: values.remark ?? null });
      void message.success('已入库（手工补录不会生成成本）');
      setInOpen(false);
      await load();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  };

  const submitOut = async () => {
    if (!currentProjectId) return;
    const values = await outForm.validateFields();
    setSaving(true);
    try {
      const result = await inventoryApi.out({
        project_id: currentProjectId,
        material_name: values.material_name,
        unit: values.unit,
        quantity: values.quantity,
        biz_date: values.biz_date,
        remark: values.remark ?? null,
      });
      if (result.enough) {
        void message.success(`已领用，当前余量 ${fmtQty(result.balance)}`);
      } else {
        void message.warning(`余量不足（当前余量 ${fmtQty(result.balance)}），已按先领后补录提交`);
      }
      setOutOpen(false);
      await load();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  };

  const submitTxn = async () => {
    if (!editingTxn) return;
    const values = await txnForm.validateFields();
    setSaving(true);
    try {
      await inventoryApi.updateTxn(editingTxn.id, { ...values, remark: values.remark ?? null });
      void message.success('已保存');
      setTxnOpen(false);
      await load();
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  };

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
            <Button icon={<ReloadOutlined />} onClick={() => setRefreshKey((k) => k + 1)}>
              刷新
            </Button>
            <Button
              icon={<ImportOutlined />}
              disabled={!currentProjectId}
              onClick={() => {
                inForm.resetFields();
                inForm.setFieldsValue({ biz_date: dayjs().format('YYYY-MM-DD') });
                setInOpen(true);
              }}
            >
              材料入库
            </Button>
            <Button
              type="primary"
              icon={<ExportOutlined />}
              disabled={!currentProjectId}
              onClick={() => {
                outForm.resetFields();
                outForm.setFieldsValue({ biz_date: dayjs().format('YYYY-MM-DD') });
                setOutOpen(true);
              }}
            >
              材料领用
            </Button>
          </>
        }
      />
      <div className="pims-page-body">
        {!currentProjectId ? (
          <Alert
            type="info"
            showIcon
            message="请先在顶部选择项目"
            description="库存按「项目 + 材料名称 + 单位」分别计算，项目之间干净隔离（00-需求冻结 R7），因此必须先选项目。"
          />
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="常规材料采购请到「记账 → 材料」录入：采购即成本并自动入库；本页「材料入库」只用于历史数据补录（不生成成本），「材料领用」只减库存、不产生成本。"
            />
            <Card title="库存余量" style={{ marginBottom: 16 }} styles={{ body: { padding: 0 } }}>
              <DataTable<InventoryBalance>
                key={refreshKey}
                rowKey={(row) => `${row.material_name}|${row.unit}`}
                size="small"
                loading={loading}
                columns={balanceColumns}
                dataSource={balances}
                pagination={false}
                locale={{ emptyText: '该项目暂无库存' }}
                scroll={undefined}
              />
            </Card>

            <Card styles={{ body: { paddingTop: 0 } }}>
              <Tabs
                activeKey="txns"
                items={[{ key: 'txns', label: '库存流水', children: null }]}
                tabBarExtraContent={
                  <Space size={8}>
                    <Select
                      placeholder="入库 / 领用"
                      allowClear
                      style={{ width: 120 }}
                      value={txnType}
                      options={toOptions(INV_TXN_TYPE_LABEL)}
                      onChange={(value) => {
                        setPage(1);
                        setTxnType(value);
                      }}
                    />
                    <Input.Search
                      placeholder="搜索材料 / 供应商 / 备注"
                      allowClear
                      style={{ width: 220 }}
                      onSearch={(value) => {
                        setPage(1);
                        setKeyword(value.trim());
                      }}
                    />
                  </Space>
                }
              />
              <DataTable<InventoryTxn>
                rowKey="id"
                size="small"
                loading={loading}
                columns={txnColumns}
                dataSource={txns}
                total={total}
                page={page}
                pageSize={pageSize}
                onPageChange={(nextPage, nextSize) => {
                  setPage(nextPage);
                  setPageSize(nextSize);
                }}
                scroll={{ x: 1022 }}
              />
            </Card>
          </>
        )}
      </div>

      {/* 手工补录入库 */}
      <Modal
        title="材料入库（手工补录，不生成成本）"
        open={inOpen}
        onCancel={() => setInOpen(false)}
        onOk={() => void submitIn()}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={inForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item
              label="材料名称"
              name="material_name"
              rules={[{ required: true, message: '材料名称必填' }]}
              style={{ width: 200 }}
            >
              <DictSelect dictType="material" placeholder="选择或新增" />
            </Form.Item>
            <Form.Item label="数量" name="quantity" rules={[{ required: true, message: '数量必填' }]} style={{ width: 140 }}>
              <InputNumber min={0} step={1} precision={3} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="单位" name="unit" rules={[{ required: true, message: '单位必填' }]} style={{ width: 150 }}>
              <DictSelect dictType="unit" placeholder="吨" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item label="单价（选填）" name="unit_price" style={{ width: 170 }}>
              <MoneyInput />
            </Form.Item>
            <Form.Item label="供应商" name="supplier" style={{ width: 220 }}>
              <DictSelect dictType="partner" placeholder="某某建材" />
            </Form.Item>
            <Form.Item label="日期" name="biz_date" rules={[{ required: true, message: '日期必填' }]} style={{ width: 170 }}>
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
          </Space>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 材料领用 */}
      <Modal
        title="材料领用（只减库存，不产生成本）"
        open={outOpen}
        onCancel={() => setOutOpen(false)}
        onOk={() => void submitOut()}
        confirmLoading={saving}
        destroyOnClose
        okText={outNotEnough ? '余量不足，仍然提交' : '确定'}
      >
        <Form form={outForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item
              label="材料名称"
              name="material_name"
              rules={[{ required: true, message: '材料名称必填' }]}
              style={{ width: 200 }}
            >
              <Select
                showSearch
                placeholder="选择该项目已有材料"
                options={balances.map((b) => ({
                  value: b.material_name,
                  label: `${b.material_name}（余量 ${fmtQty(b.balance)}）`,
                }))}
                onChange={(value: string) => {
                  const found = balances.find((b) => b.material_name === value);
                  if (found) outForm.setFieldValue('unit', found.unit);
                }}
              />
            </Form.Item>
            <Form.Item label="数量" name="quantity" rules={[{ required: true, message: '数量必填' }]} style={{ width: 140 }}>
              <InputNumber min={0} step={1} precision={3} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="单位" name="unit" rules={[{ required: true, message: '单位必填' }]} style={{ width: 150 }}>
              <Select
                placeholder="单位"
                options={Array.from(new Set(balances.map((b) => b.unit))).map((u) => ({ value: u, label: u }))}
              />
            </Form.Item>
          </Space>
          <Form.Item label="日期" name="biz_date" rules={[{ required: true, message: '日期必填' }]} style={{ width: 170 }}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} placeholder="部位、工序等" />
          </Form.Item>
        </Form>
        {outBalance !== null && (
          <Alert
            type={outNotEnough ? 'error' : 'info'}
            showIcon
            message={
              outNotEnough
                ? `余量不足：当前余量 ${fmtQty(outBalance)}，本次领用 ${fmtQty(outQty ?? 0)}（工地常见先领后补录，允许继续提交）`
                : `当前余量 ${fmtQty(outBalance)}`
            }
          />
        )}
      </Modal>

      {/* 编辑库存流水 */}
      <Modal
        title="编辑库存流水"
        open={txnOpen}
        onCancel={() => setTxnOpen(false)}
        onOk={() => void submitTxn()}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={txnForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item label="材料名称" name="material_name" style={{ width: 200 }}>
              <DictSelect dictType="material" />
            </Form.Item>
            <Form.Item label="数量" name="quantity" style={{ width: 140 }}>
              <InputNumber min={0} step={1} precision={3} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="单位" name="unit" style={{ width: 150 }}>
              <DictSelect dictType="unit" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item label="单价" name="unit_price" style={{ width: 160 }}>
              <MoneyInput />
            </Form.Item>
            <Form.Item label="供应商" name="supplier" style={{ width: 200 }}>
              <DictSelect dictType="partner" />
            </Form.Item>
            <Form.Item label="日期" name="biz_date" style={{ width: 160 }}>
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
          </Space>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
          {editingTxn?.cost_id && (
            <Text type="secondary">
              该入库流水关联成本 #{editingTxn.cost_id}，数量与单价的修改不会自动改成本金额。
            </Text>
          )}
        </Form>
      </Modal>
    </div>
  );
}
