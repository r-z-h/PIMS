import { useState } from 'react';
import { Popover, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { costApi } from '../api/costs';
import { fmtMoney } from '../utils/money';
import type { CostBrief } from '../types/domain';

const { Text, Link } = Typography;

/**
 * 「关联成本」列：把光秃秃的 `#17` 显示成能认出来的样子（需求 T3）。
 *
 * 显示：`#17（材料 · 水泥 40,000.00）`
 * 交互：点 id 跳到该笔成本所在的记账页页签；鼠标悬停显示该笔成本摘要。
 *
 * 摘要优先用列表接口已经带回来的 `brief`（省一次请求，也不会有加载闪烁）；
 * 没带时再按 id 惰性拉一次 `GET /api/costs/{id}/brief`。
 * `costId` 为空 → 显示 `-`（手工单据/领用流水本来就没有关联成本，**不是错误**）。
 */

/** 成本类型 → 记账页页签（与 Bookkeeping 页的页签键一致） */
const TYPE_TAB: Record<string, string> = {
  labor: 'labor',
  material: 'material',
  machine: 'machine',
  misc: 'misc',
  advance: 'advance',
};

export interface CostLinkProps {
  costId?: number | null;
  /** 列表接口已带回的摘要（有就不发请求） */
  brief?: CostBrief | null;
  /** 后端已拼好的完整文案，如「材料 · 水泥 40000.00」 */
  label?: string | null;
  /** 是否在括号里显示摘要文案（库存流水表格空间紧张时可关掉） */
  showLabel?: boolean;
  maxLabelChars?: number;
}

export default function CostLink({
  costId,
  brief,
  label,
  showLabel = true,
  maxLabelChars = 28,
}: CostLinkProps) {
  const navigate = useNavigate();
  const [fetched, setFetched] = useState<CostBrief | null>(null);
  const [loading, setLoading] = useState(false);

  if (!costId) {
    // 没有关联成本是正常情况（手工新增单据 / 材料领用），保持 `-`
    return <Text type="secondary">-</Text>;
  }

  const info = brief ?? fetched;
  const text = info?.label ?? label ?? null;

  const ensureLoaded = () => {
    if (info || loading) return;
    setLoading(true);
    costApi
      .brief(costId)
      .then((data) => setFetched(data))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };

  const goToCost = () => {
    const tab = info?.type ? TYPE_TAB[info.type] : undefined;
    // 跳到记账页对应页签并高亮该行（Bookkeeping 页读取 focus 参数）
    navigate(tab ? `/bookkeeping?tab=${tab}&focus=${costId}` : `/bookkeeping?focus=${costId}`);
  };

  const truncated =
    text && text.length > maxLabelChars ? `${text.slice(0, maxLabelChars)}…` : text;

  const summary = (
    <div style={{ maxWidth: 320 }}>
      {info ? (
        <>
          <div>
            <Text strong>成本 #{costId}</Text>
            <Text type="secondary">（{info.type_label}）</Text>
          </div>
          <div>对象：{info.expense || info.subject || '-'}</div>
          <div>金额：{fmtMoney(info.amount)}</div>
          <div>日期：{info.biz_date || '-'}</div>
          {info.partner ? <div>往来对象：{info.partner}</div> : null}
          {info.deleted ? (
            <div>
              <Text type="danger">该成本已删除</Text>
            </div>
          ) : null}
          <div style={{ marginTop: 6 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              点击可跳到该笔成本
            </Text>
          </div>
        </>
      ) : (
        <Text type="secondary">{loading ? '正在读取成本摘要…' : '暂无法读取该成本摘要'}</Text>
      )}
    </div>
  );

  return (
    <Popover content={summary} mouseEnterDelay={0.2} onOpenChange={(open) => open && ensureLoaded()}>
      <span onMouseEnter={ensureLoaded} style={{ cursor: 'pointer' }}>
        <Tooltip title={text ? `成本 #${costId}：${text}` : `成本 #${costId}`}>
          <Link onClick={goToCost} style={{ marginRight: showLabel ? 4 : 0 }}>
            #{costId}
          </Link>
        </Tooltip>
        {showLabel && truncated ? (
          <Text type="secondary" style={{ fontSize: 12 }} onClick={goToCost}>
            （{truncated}）
          </Text>
        ) : null}
      </span>
    </Popover>
  );
}
