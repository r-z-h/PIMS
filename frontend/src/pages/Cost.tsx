import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Dropdown, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { AccountBookOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import CostFormModal from '../components/CostFormModal';
import CostPaymentModal from '../components/CostPaymentModal';
import { useStickyOffset } from '../components/DataTable';
import MoneyText from '../components/MoneyText';
import PageToolbar from '../components/PageToolbar';
import { costApi } from '../api/costs';
import { useAppStore } from '../store/app';
import { useDateRange } from '../hooks/useDateRange';
import type { CostItem, CostType } from '../types';
import { addMoney, fmtQty, toScaled } from '../utils/money';
import { COST_TYPES, COST_TYPE_LABEL } from '../utils/enums';

const { Text, Title } = Typography;

const COST_COLOR: Record<CostType, string> = {
  labor: '#1677ff',
  material: '#13c2c2',
  machine: '#722ed1',
  misc: '#fa8c16',
  advance: '#eb2f96',
};

/** 明细一次取多少条（后端 page_size 上限就是 200，超了会被 400 拒绝） */
const DETAIL_PAGE_SIZE = 200;

/** 树表行：父行＝某类成本的合计，子行＝该类下的每一笔 */
interface CostRow {
  key: string;
  isParent: boolean;
  type: CostType;
  /** 父行：类别人数；子行：具体对象（如工人姓名） */
  subject: string;
  quantity?: string;
  unitPrice?: string;
  amount: number;
  bizDate?: string;
  partner?: string;
  category?: string;
  remark?: string;
  children?: CostRow[];
}

/** 某条成本在列表里怎么称呼它的「对象」 */
function subjectOf(item: CostItem): string {
  switch (item.type) {
    case 'labor':
      return item.worker_name || '未填姓名';
    case 'material':
      return item.material_name || '未填材料';
    case 'machine':
      return item.machine_name || '未填设备';
    case 'advance':
      return item.payer || '未填垫付人';
    case 'misc':
    default:
      return item.category || '未填小类';
  }
}

/** 数量列：人工显示工日，材料/机械显示数量 + 单位 */
function quantityOf(item: CostItem): string | undefined {
  if (item.type === 'labor') {
    return item.work_days === null || item.work_days === undefined
      ? undefined
      : `${fmtQty(item.work_days)} 工日`;
  }
  if (item.quantity === null || item.quantity === undefined) return undefined;
  const unit = item.unit ? ` ${item.unit}` : item.measure === 'hour' ? ' 小时' : item.measure === 'shift' ? ' 台班' : '';
  return `${fmtQty(item.quantity)}${unit}`;
}

function unitPriceOf(item: CostItem): string | undefined {
  const price = item.type === 'labor' ? item.day_rate : item.unit_price;
  if (price === null || price === undefined) return undefined;
  return item.type === 'labor' ? `${fmtQty(price, 2)} 元/工日` : `${fmtQty(price, 2)} 元`;
}

/**
 * 成本：按**成本构成**看汇总（与「记账」页共用同一份数据）。
 *
 * 「记账」页贴近现实账本：一笔一笔记；本页看的是「钱花在哪些方面、各占多少」。
 * 两者**都能录入**（本页右上角「新增成本」下拉选五类），用的是同一个 `CostFormModal`，
 * 录进的是同一份 cost 数据，不存在第二份账——不会因为入口不同而对不上。
 *
 * 展示方式：树表。父行＝五类成本各自的合计与占比，子行＝该类下的每一笔明细；
 * 默认全部展开（一屏看完汇总），可折叠只看五类合计。
 */
export default function Cost() {
  const navigate = useNavigate();
  const { dateRange, setDateRange } = useDateRange();
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  /** 表头吸顶的偏移量（顶部工具条高度） */
  const offsetHeader = useStickyOffset();

  const [items, setItems] = useState<CostItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailTotal, setDetailTotal] = useState(0);
  /** 汇总用后端 summary：合计不受明细分页影响，永远准确 */
  const [summaryTotal, setSummaryTotal] = useState(0);
  const [summaryByType, setSummaryByType] = useState<Record<string, number>>({});
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  /** 新增成本的表单（五类共用同一个组件，与记账页一致） */
  const [formOpen, setFormOpen] = useState(false);
  const [formType, setFormType] = useState<CostType>('labor');
  /** 录完成本后登记已付 */
  const [payTarget, setPayTarget] = useState<{ id: number; label: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = {
        project_id: currentProjectId ?? undefined,
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
      };
      // 合计走 summary（后端聚合，不受 page_size 上限影响）；明细单独分页取
      const [summary, page] = await Promise.all([
        costApi.summary(query),
        costApi.list({ ...query, page: 1, page_size: DETAIL_PAGE_SIZE }),
      ]);
      setSummaryTotal(Number(summary.total ?? 0));
      const byType: Record<string, number> = {};
      Object.entries(summary.by_type ?? {}).forEach(([key, value]) => {
        byType[key] = Number(value ?? 0);
      });
      setSummaryByType(byType);
      setItems(page.items ?? []);
      setDetailTotal(page.total ?? (page.items ?? []).length);
      // 默认展开全部类别，做到「一屏看完汇总」
      setExpandedKeys(COST_TYPES.map((type) => `type-${type}`));
    } catch {
      /* 错误提示由响应拦截器统一处理 */
    } finally {
      setLoading(false);
    }
  }, [currentProjectId, dateRange.start_date, dateRange.end_date]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 合计一律用后端 summary（明细只取了前 200 条，本地求和会偏小） */
  const total = summaryTotal;
  const amountOfType = useCallback(
    (type: CostType) => Number(summaryByType[type] ?? 0),
    [summaryByType],
  );

  const byType = useMemo(() => {
    const map = {} as Record<CostType, CostItem[]>;
    COST_TYPES.forEach((type) => {
      map[type] = [];
    });
    items.forEach((item) => {
      if (map[item.type]) map[item.type].push(item);
    });
    return map;
  }, [items]);

  const rows = useMemo<CostRow[]>(
    () =>
      COST_TYPES.map((type) => {
        const list = byType[type];
        const children: CostRow[] = list
          .slice()
          .sort((a, b) => (a.biz_date === b.biz_date ? b.id - a.id : a.biz_date < b.biz_date ? 1 : -1))
          .map((item) => ({
            key: `cost-${item.id}`,
            isParent: false,
            type,
            subject: subjectOf(item),
            quantity: quantityOf(item),
            unitPrice: unitPriceOf(item),
            amount: Number(item.amount ?? 0),
            bizDate: item.biz_date,
            partner: item.partner ?? undefined,
            category: item.category ?? undefined,
            remark: item.remark ?? undefined,
          }));
        return {
          key: `type-${type}`,
          isParent: true,
          type,
          subject: `${COST_TYPE_LABEL[type]}（明细 ${list.length} 笔）`,
          amount: amountOfType(type),
          children,
        };
      }),
    [byType, amountOfType],
  );

  const columns: ColumnsType<CostRow> = [
    {
      title: '类别 / 对象',
      dataIndex: 'subject',
      ellipsis: true,
      render: (value: string, row: CostRow) =>
        row.isParent ? (
          <Space size={6}>
            <Tag color={COST_COLOR[row.type]}>{COST_TYPE_LABEL[row.type]}</Tag>
            <Text strong>{`${row.children?.length ?? 0} 笔`}</Text>
          </Space>
        ) : (
          <span style={{ paddingLeft: 8 }}>{value}</span>
        ),
    },
    {
      title: '日期',
      dataIndex: 'bizDate',
      width: 104,
      render: (value?: string) => value ?? '-',
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      width: 110,
      align: 'right',
      render: (value?: string) => value ?? '-',
    },
    {
      title: '单价',
      dataIndex: 'unitPrice',
      width: 110,
      align: 'right',
      render: (value?: string) => value ?? '-',
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 150,
      align: 'right',
      render: (value: number, row: CostRow) =>
        row.isParent ? (
          <Space size={6}>
            <MoneyText value={value} bold />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {toScaled(total, 2) > 0 ? `${((value / total) * 100).toFixed(1)}%` : '-'}
            </Text>
          </Space>
        ) : (
          <MoneyText value={value} />
        ),
    },
    {
      title: '对方',
      dataIndex: 'partner',
      width: 120,
      ellipsis: true,
      render: (value?: string) => value || '-',
    },
    {
      title: '备注',
      dataIndex: 'remark',
      ellipsis: true,
      render: (value?: string) => (value ? <Text type="secondary">{value}</Text> : '-'),
    },
  ];

  return (
    <div className="pims-page">
      <PageToolbar
        showProject
        showDateRange
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        showExport
        actions={
          <>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Tooltip title="同一套五类成本；在「记账」页录也一样（像账本一笔一笔记）">
              <Button icon={<AccountBookOutlined />} onClick={() => navigate('/bookkeeping')}>
                去记账页
              </Button>
            </Tooltip>
            <Dropdown
              menu={{
                items: COST_TYPES.map((item) => ({
                  key: item,
                  label: `新增${COST_TYPE_LABEL[item]}`,
                  onClick: () => {
                    setFormType(item);
                    setFormOpen(true);
                  },
                })),
              }}
            >
              <Button type="primary" icon={<PlusOutlined />}>
                新增成本
              </Button>
            </Dropdown>
          </>
        }
      />
      <div className="pims-page-body">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="本页按成本构成看汇总；录入五类成本的两个入口是等价的"
          description={
            <Space direction="vertical" size={2}>
              <Text>
                这里的数据与「记账」页<Text strong>共用同一份</Text>：在记账页录一笔，回本页刷新即可看到；
                也可以直接点右上角「新增成本」在这里录（人工 / 材料 / 机械 / 杂费 / 垫付），两边效果完全一样。
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                实际成本 ＝ 五类之和，是计算「结算利润（＝甲方预算 − 实际成本）」的依据。
                每录一笔都会自动生成一张应付单（「往来」页可见），录完可顺手在弹窗里登记已付。
              </Text>
            </Space>
          }
        />

        <Card style={{ marginBottom: 16 }}>
          <Space size={24} wrap align="center">
            <Space direction="vertical" size={0}>
              <Text type="secondary">实际成本（五类合计）</Text>
              <Title level={4} style={{ margin: 0 }}>
                <MoneyText value={total} bold />
              </Title>
            </Space>
            <Space size={16} wrap>
              {COST_TYPES.map((type) => (
                <Space key={type} direction="vertical" size={0}>
                  <Text type="secondary">
                    <Tag color={COST_COLOR[type]} style={{ marginInlineEnd: 4 }}>
                      {COST_TYPE_LABEL[type]}
                    </Tag>
                  </Text>
                  <Text strong>
                    <MoneyText value={amountOfType(type)} />
                  </Text>
                </Space>
              ))}
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {currentProjectId ? '当前项目' : '全部项目'}｜
              {dateRange.start_date} ~ {dateRange.end_date}
            </Text>
          </Space>
        </Card>

        {detailTotal > items.length && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`明细共 ${detailTotal} 笔，本页只列出最近/最前 ${items.length} 笔`}
            description="上面的合计来自后端汇总，始终是全部数据的准确值；若要看全部明细，请缩小时间段或指定项目。"
          />
        )}

        <Card
          title="成本明细（按类别分组）"
          extra={
            <Space>
              <Button
                size="small"
                onClick={() => setExpandedKeys(expandedKeys.length ? [] : COST_TYPES.map((type) => `type-${type}`))}
              >
                {expandedKeys.length ? '只看五类合计' : '展开全部明细'}
              </Button>
              <Button
                type="link"
                size="small"
                icon={<RightOutlined />}
                onClick={() => navigate('/bookkeeping')}
              >
                去记账
              </Button>
            </Space>
          }
          styles={{ body: { padding: 0 } }}
        >
          <Table<CostRow>
            rowKey="key"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={rows}
            pagination={false}
            expandable={{
              expandedRowKeys: expandedKeys,
              onExpandedRowsChange: (keys) => setExpandedKeys(keys as string[]),
            }}
            locale={{ emptyText: '当前筛选条件下没有成本数据；到「记账」页录一笔即可' }}
            scroll={{ x: 1000 }}
            // 需求 L1：表头吸顶。本页直接用 antd Table（带 Table.Summary 合计行），
            // 所以不能套 DataTable，这里复用它的偏移量算法，保证跟其它页面一致。
            sticky={{ offsetHeader }}
            summary={(data) => {
              const sum = addMoney(...data.map((row) => row.amount));
              return (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}>
                    <Text strong>合计</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} />
                  <Table.Summary.Cell index={2} />
                  <Table.Summary.Cell index={3} />
                  <Table.Summary.Cell index={4} align="right">
                    <MoneyText value={sum} bold />
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={5} />
                  <Table.Summary.Cell index={6} />
                </Table.Summary.Row>
              );
            }}
          />
        </Card>

        <Text type="secondary" style={{ fontSize: 12 }}>
          提示：<Text code>材料领用</Text> 只减库存、不再计一次成本（成本已在采购时计入）；删除记账里的一笔成本，
          本页合计与本页明细会同步减少，但<Text strong>对应的应付单会保留</Text>（到「往来」页处理）。
        </Text>
      </div>

      <CostFormModal
        open={formOpen}
        type={formType}
        defaultProjectId={currentProjectId}
        onCancel={() => setFormOpen(false)}
        onSaved={(info) => {
          setFormOpen(false);
          void load();
          if (info.created && info.costId) {
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
    </div>
  );
}
