import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Input, Modal, Space, Tabs, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, FileSearchOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import ChangeLogTimeline from '../components/ChangeLogTimeline';
import CostFormModal from '../components/CostFormModal';
import CostPaymentModal from '../components/CostPaymentModal';
import DataTable from '../components/DataTable';
import MoneyText from '../components/MoneyText';
import PageToolbar from '../components/PageToolbar';
import { costApi } from '../api/costs';
import { useAppStore } from '../store/app';
import { useDateRange } from '../hooks/useDateRange';
import type { ChangeLog, CostItem, CostType } from '../types';
import { fmtQty } from '../utils/money';
import { COST_TYPES, COST_TYPE_LABEL, MEASURE_LABEL } from '../utils/enums';

const { Text, Title } = Typography;

/**
 * 记账：五类成本（人工/材料/机械/杂费/垫付）的录入页。
 *
 * 「记账」贴近现实中的账本记账方式：一笔一笔把花出去的钱记下来。
 * 想按「成本构成」看汇总，去「成本」页（同一份数据；那边右上角「新增成本」也能录，效果一样）。
 * 每录一笔，后端会自动生成一张对应的应付单（在「往来」页可见），
 * 录完弹出的「登记已付」可以顺手登记付了多少（选填，可直接跳过）。
 */
export default function Bookkeeping() {
  const { dateRange, setDateRange } = useDateRange();
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const showDeleted = useAppStore((s) => s.showDeleted);
  /** 从别处跳进来时定位某笔成本（/bookkeeping?tab=material&focus=17） */
  const [searchParams, setSearchParams] = useSearchParams();

  const [type, setType] = useState<CostType>((searchParams.get('tab') as CostType) ?? 'labor');
  const [focusId, setFocusId] = useState<number | null>(() => {
    const raw = searchParams.get('focus');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  });

  // 高亮是"指路"用的，几秒后自动褪掉，免得一直留着一行黄底
  useEffect(() => {
    if (!focusId) return undefined;
    const timer = window.setTimeout(() => setFocusId(null), 6000);
    return () => window.clearTimeout(timer);
  }, [focusId]);

  // 跳到某笔成本只是"看一眼"，清掉查询参数，避免刷新后又被高亮一次
  useEffect(() => {
    if (!searchParams.get('focus') && !searchParams.get('tab')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    next.delete('tab');
    setSearchParams(next, { replace: true });
    // 只在首次进入时清理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [rows, setRows] = useState<CostItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [categoryTotal, setCategoryTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CostItem | null>(null);
  /** 刚录入的成本：用于弹出「登记已付」（应付单已由后端自动生成） */
  const [payTarget, setPayTarget] = useState<{ id: number; label: string } | null>(null);

  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<ChangeLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [deleting, setDeleting] = useState<CostItem | null>(null);
  const [keyword, setKeyword] = useState('');

  const projectId = currentProjectId;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, summary] = await Promise.all([
        costApi.list({
          type,
          page,
          page_size: pageSize,
          project_id: projectId ?? undefined,
          start_date: dateRange.start_date,
          end_date: dateRange.end_date,
          keyword: keyword || undefined,
          include_deleted: showDeleted,
        }),
        costApi.summary({
          type,
          project_id: projectId ?? undefined,
          start_date: dateRange.start_date,
          end_date: dateRange.end_date,
        }),
      ]);
      setRows(list.items ?? []);
      setTotal(list.total ?? 0);
      setCategoryTotal(Number(summary.by_type?.[type] ?? 0));
    } catch {
      /* 拦截器已提示 */
    } finally {
      setLoading(false);
    }
  }, [type, page, pageSize, projectId, dateRange.start_date, dateRange.end_date, keyword, showDeleted]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [type, projectId, dateRange.start_date, dateRange.end_date, keyword, showDeleted]);

  const columns: ColumnsType<CostItem> = [
    { title: '日期', dataIndex: 'biz_date', width: 110 },
    ...(type === 'labor'
      ? [
          { title: '姓名', dataIndex: 'worker_name', width: 110 },
          {
            title: '工日数',
            dataIndex: 'work_days',
            width: 90,
            align: 'right' as const,
            render: (value: number | null) => (value === null || value === undefined ? '-' : fmtQty(value)),
          },
          {
            title: '日工价',
            dataIndex: 'day_rate',
            width: 110,
            align: 'right' as const,
            render: (value: number | null) => (value === null || value === undefined ? '-' : <MoneyText value={value} />),
          },
        ]
      : []),
    ...(type === 'material'
      ? [
          { title: '材料', dataIndex: 'material_name', width: 130 },
          {
            title: '数量',
            dataIndex: 'quantity',
            width: 100,
            align: 'right' as const,
            render: (value: number | null, row: CostItem) =>
              value === null || value === undefined ? '-' : `${fmtQty(value)} ${row.unit ?? ''}`,
          },
          {
            title: '单价',
            dataIndex: 'unit_price',
            width: 110,
            align: 'right' as const,
            render: (value: number | null) => (value === null || value === undefined ? '-' : <MoneyText value={value} />),
          },
          { title: '供应商', dataIndex: 'supplier', width: 130, ellipsis: true, render: (v: string | null) => v || '-' },
        ]
      : []),
    ...(type === 'machine'
      ? [
          // 机械页签固定列最多，操作列加宽后要在这里让出宽度，否则「备注」只剩 28px
          { title: '设备', dataIndex: 'machine_name', width: 130, ellipsis: true },
          {
            title: '计量',
            dataIndex: 'measure',
            width: 70,
            render: (value: string | null) => (value ? MEASURE_LABEL[value as 'shift' | 'hour'] : '-'),
          },
          {
            title: '数量',
            dataIndex: 'quantity',
            width: 90,
            align: 'right' as const,
            render: (value: number | null) => (value === null || value === undefined ? '-' : fmtQty(value)),
          },
          {
            title: '单价',
            dataIndex: 'unit_price',
            width: 110,
            align: 'right' as const,
            render: (value: number | null) => (value === null || value === undefined ? '-' : <MoneyText value={value} />),
          },
          { title: '出租方', dataIndex: 'lessor', width: 110, ellipsis: true, render: (v: string | null) => v || '-' },
        ]
      : []),
    ...(type === 'misc'
      ? [{ title: '小类', dataIndex: 'category', width: 130, render: (v: string | null) => (v ? <Tag>{v}</Tag> : '-') }]
      : []),
    ...(type === 'advance'
      ? [
          { title: '垫付人', dataIndex: 'payer', width: 110, render: (v: string | null) => v || '老板' },
          { title: '事由', dataIndex: 'purpose', width: 180, ellipsis: true, render: (v: string | null) => v || '-' },
        ]
      : []),
    {
      title: '金额',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      render: (value: number) => <MoneyText value={value} bold />,
    },
    {
      title: '应付单',
      key: 'payable',
      width: 110,
      render: (_: unknown, row: CostItem) => (
        <Button
          type="link"
          size="small"
          onClick={() => setPayTarget({ id: row.id, label: `${COST_TYPE_LABEL[row.type]} · ${row.partner ?? ''}` })}
        >
          登记已付
        </Button>
      ),
    },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v: string | null) => v || '-' },
    ...(showDeleted
      ? [
          {
            title: '状态',
            dataIndex: 'deleted',
            width: 80,
            render: (v: number) => (v ? <Tag color="red">已删除</Tag> : <Tag color="green">正常</Tag>),
          },
        ]
      : []),
    {
      title: '操作',
      key: 'action',
      // 210 装不下「编辑 / 修改记录 / 删除」三个带图标的链接按钮（实测 226px）：
      // 内容会溢出单元格 24px，在 1440 下表现为「删除」被卡片右边缘裁掉，
      // 并且 .ant-table-content 出现 1202 > 1178 的容器内横向滚动条。
      // 250 = 226 内容 + 单元格左右 padding 16 + 余量。
      width: 250,
      render: (_: unknown, row: CostItem) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button type="link" size="small" icon={<FileSearchOutlined />} onClick={() => void openLogs(row)}>
            修改记录
          </Button>
          <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => setDeleting(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (row: CostItem) => {
    setEditing(row);
    setFormOpen(true);
  };

  const openLogs = async (row: CostItem) => {
    setLogOpen(true);
    setLogsLoading(true);
    try {
      setLogs(await costApi.logs(row.id));
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      const result = await costApi.remove(deleting.id);
      const kept = (result as { payable?: { kept?: boolean; message?: string } }).payable;
      if (kept?.kept) {
        // 口径：成本删除后应付单保留，必须明确提示
        Modal.info({
          title: '成本已删除，但应付单已保留',
          content: kept.message ?? '该成本对应的应付单不会被自动删除，请到「往来」页自行处理。',
        });
      } else {
        void message.success('已删除');
      }
      setDeleting(null);
      await load();
    } catch {
      /* 拦截器已提示 */
    }
  };

  return (
    <div className="pims-page">
      <PageToolbar
        showProject
        showDateRange
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        showExport
        extra={
          <Input.Search
            placeholder="搜索姓名 / 材料 / 设备 / 小类 / 备注"
            allowClear
            style={{ width: 260 }}
            onSearch={(value) => setKeyword(value)}
          />
        }
        actions={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增{COST_TYPE_LABEL[type]}
            </Button>
          </>
        }
      />
      <div className="pims-page-body">
        <Card>
          <Tabs
            activeKey={type}
            onChange={(key) => setType(key as CostType)}
            items={COST_TYPES.map((item) => ({ key: item, label: COST_TYPE_LABEL[item] }))}
          />
          <Space style={{ marginBottom: 12 }} wrap>
            <Text type="secondary">
              筛选条件下「{COST_TYPE_LABEL[type]}」合计：
            </Text>
            <Title level={5} style={{ margin: 0 }}>
              <MoneyText value={categoryTotal} bold />
            </Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              每录一笔会自动生成一张应付单（「往来」页可见）；点行尾「登记已付」可补登付款
            </Text>
          </Space>
          <DataTable<CostItem>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={rows}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              showTotal: (t) => `共 ${t} 条`,
            }}
            onPageChange={(nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            }}
            scroll={{ x: 1170 }}
            locale={{ emptyText: '暂无记录，点右上角「新增」开始记账' }}
            // 从别处（如库存流水的「关联成本」）跳过来时，高亮那一行，便于一眼找到
            rowClassName={(row) => (focusId && row.id === focusId ? 'pims-row-focus' : '')}
          />
        </Card>
      </div>

      <CostFormModal
        open={formOpen}
        type={type}
        editing={editing}
        defaultProjectId={projectId}
        onCancel={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSaved={(info) => {
          setFormOpen(false);
          setEditing(null);
          void load();
          if (info.created && info.costId) {
            void message.info('已自动生成应付单，可在「往来」页查看；如需登记已付请填写弹窗');
            setPayTarget({ id: info.costId, label: info.label ?? '' });
          }
        }}
      />

      <CostPaymentModal
        open={Boolean(payTarget)}
        costId={payTarget?.id ?? null}
        costLabel={payTarget?.label}
        onClose={() => setPayTarget(null)}
        onDone={() => void load()}
      />

      <ChangeLogTimeline
        open={logOpen}
        onClose={() => setLogOpen(false)}
        title="成本修改记录"
        logs={logs}
        loading={logsLoading}
      />

      <Modal
        title="删除这条成本记录？"
        open={Boolean(deleting)}
        onCancel={() => setDeleting(null)}
        onOk={() => void doDelete()}
        okText="删除"
        okButtonProps={{ danger: true }}
        destroyOnClose
      >
        <Text>
          {deleting?.type === 'material'
            ? '软删除后列表默认不再显示，实际成本减少，同时回冲该笔材料的入库流水。'
            : '软删除后列表默认不再显示，实际成本随之减少；删除动作会写入变更日志。'}
        </Text>
        <div style={{ marginTop: 8 }}>
          <Text type="warning">注意：该成本对应的应付单不会被删除，会保留在「往来」页。</Text>
        </div>
      </Modal>
    </div>
  );
}
