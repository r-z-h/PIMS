import { useState, type CSSProperties } from 'react';
import { Modal, Typography } from 'antd';

const { Paragraph, Text } = Typography;

export interface EllipsisTextProps {
  /** 文本内容；空值显示 emptyText */
  value?: string | null;
  /** 超过多少个字符才截断（默认 24） */
  maxChars?: number;
  /** 表格里通常给个宽度，超出用省略号 */
  style?: CSSProperties;
  emptyText?: string;
  /** 展开弹窗的标题 */
  modalTitle?: string;
}

/**
 * 长文本展示：内容长时截断为「前 N 字…」，点击弹窗看全文。
 *
 * 用于项目详情里「备注」「成员名单」这类可能很长的字段
 * （docs 需求第 5 条：篇幅过大的字段显示一小部分，通过 "..." 点击展开）。
 * 复用 Window.getSelection 无副作用，不依赖 antd 的 Typography.Ellipsis（那个不能点击展开全文）。
 */
export function EllipsisText({
  value,
  maxChars = 24,
  style,
  emptyText = '-',
  modalTitle = '全部内容',
}: EllipsisTextProps) {
  const [open, setOpen] = useState(false);
  const text = (value ?? '').trim();

  if (!text) return <Text type="secondary">{emptyText}</Text>;

  const truncated = text.length > maxChars;
  const shown = truncated ? `${text.slice(0, maxChars)}…` : text;

  return (
    <>
      <span
        style={{ cursor: truncated ? 'pointer' : 'default', ...style }}
        title={truncated ? '点击查看全部内容' : text}
        onClick={() => {
          if (truncated) setOpen(true);
        }}
      >
        {shown}
      </span>
      <Modal
        title={modalTitle}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => setOpen(false)}
        cancelButtonProps={{ style: { display: 'none' } }}
        width={640}
      >
        <Paragraph style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginBottom: 0 }}>
          {text}
        </Paragraph>
      </Modal>
    </>
  );
}

export default EllipsisText;
