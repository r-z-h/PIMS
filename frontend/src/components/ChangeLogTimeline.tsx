import { Drawer, Empty, Spin, Tag, Timeline, Typography } from 'antd';
import type { ChangeLog } from '../types';
import { CHANGE_ACTION_LABEL } from '../utils/enums';

const { Text } = Typography;

export interface ChangeLogTimelineProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  logs: ChangeLog[];
  loading?: boolean;
}

const ACTION_COLOR: Record<string, string> = {
  create: 'green',
  update: 'blue',
  delete: 'red',
};

/** 字段中文名映射（时间线上更易读） */
const FIELD_LABEL: Record<string, string> = {
  id: 'ID',
  project_id: '项目',
  project_name: '项目',
  type: '类别',
  category: '小类',
  amount: '金额',
  biz_date: '发生日期',
  partner: '对方',
  remark: '备注',
  deleted: '已删除',
  worker_name: '姓名',
  work_days: '工日数',
  day_rate: '日工价',
  material_name: '材料',
  unit: '单位',
  quantity: '数量',
  unit_price: '单价',
  supplier: '供应商',
  machine_name: '设备',
  measure: '计量方式',
  lessor: '出租方',
  payer: '垫付人',
  purpose: '事由',
  name: '名称',
  direction: '收付',
  biz_type: '业务类型',
  pay_method: '支付方式',
  settled_amount: '已冲销',
  status: '状态',
  txn_type: '类型',
  cost_id: '关联成本',
  created_at: '创建时间',
  updated_at: '更新时间',
};

function parse(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '空';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.join('、') || '空';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function buildDiff(log: ChangeLog): Array<{ field: string; before: string; after: string }> {
  const before = parse(log.before_json);
  const after = parse(log.after_json);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const skip = new Set(['created_at', 'updated_at']);
  const rows: Array<{ field: string; before: string; after: string }> = [];
  keys.forEach((key) => {
    if (skip.has(key)) return;
    if (log.action === 'create') return;
    const b = renderValue(before[key]);
    const a = renderValue(after[key]);
    if (b !== a) rows.push({ field: FIELD_LABEL[key] ?? key, before: b, after: a });
  });
  return rows;
}

/** 修改记录时间线（五类成本 / 单据等详情抽屉的数据源，来自 /api/logs） */
export function ChangeLogTimeline({ open, onClose, title = '修改记录', logs, loading }: ChangeLogTimelineProps) {
  return (
    <Drawer title={title} open={open} onClose={onClose} width={520} destroyOnClose>
      <Spin spinning={Boolean(loading)}>
        {logs.length === 0 && !loading ? (
          <Empty description="暂无修改记录" />
        ) : (
          <Timeline
            items={logs.map((log) => {
              const diff = buildDiff(log);
              return {
                color: ACTION_COLOR[log.action] ?? 'gray',
                children: (
                  <div>
                    <div style={{ marginBottom: 4 }}>
                      <Tag color={ACTION_COLOR[log.action] ?? 'default'}>
                        {CHANGE_ACTION_LABEL[log.action] ?? log.action}
                      </Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {log.created_at} · {log.operator ?? 'boss'}
                      </Text>
                    </div>
                    {log.action === 'create' && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        新增记录（表 {log.table_name} #{log.record_id}）
                      </Text>
                    )}
                    {log.action === 'delete' && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        删除记录（表 {log.table_name} #{log.record_id}），列表默认不再显示
                      </Text>
                    )}
                    {diff.length > 0 && (
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {diff.map((row) => (
                          <li key={row.field} style={{ fontSize: 13 }}>
                            <Text strong>{row.field}</Text>：{row.before} →{' '}
                            <Text style={{ color: '#0958d9' }}>{row.after}</Text>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ),
              };
            })}
          />
        )}
      </Spin>
    </Drawer>
  );
}

export default ChangeLogTimeline;
