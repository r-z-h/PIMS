import { useEffect, useState } from 'react';
import { Table } from 'antd';
import type { TableProps } from 'antd';

/**
 * 表头吸顶要让出的高度 = 顶部那条**吸顶工具条**（`.pims-toolbar`）的实际高度。
 *
 * 为什么动态算而不是写死：
 * - 工具条在窄屏会换行（项目选择 + 时间段 + 按钮一行放不下就折成两行）
 * - 有的页面带导出按钮、有的不带，高度不同
 * 写死一个值，换行时表头就会被工具条盖住一截。
 *
 * 导出给直接用 antd `<Table>` 的页面复用（如成本页，它带 `Table.Summary` 合计行）。
 */
export function useStickyOffset(): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      const bars = Array.from(document.querySelectorAll<HTMLElement>('.pims-toolbar')).filter(
        (el) => el.getClientRects().length > 0,
      );
      const total = bars.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
      setOffset(Math.round(total));
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    document.querySelectorAll<HTMLElement>('.pims-toolbar').forEach((el) => observer.observe(el));
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, []);

  return offset;
}

export interface DataTableProps<T> extends Omit<TableProps<T>, 'pagination'> {
  /** 服务端分页总数（传了即为服务端分页，与后端 page/page_size 对齐） */
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number, pageSize: number) => void;
  pagination?: TableProps<T>['pagination'];
  /**
   * 表头是否吸顶（默认开）。
   *
   * 需求 L1（2026-10-17）：长列表往下滚时，**工具条吸住了但列名滚没了**，
   * 于是看到一串数字不知道哪列是哪列。传 `false` 可关掉
   * （例如弹窗内的小表，本身不滚动，吸顶没意义）。
   */
  stickyHeader?: boolean;
}

/**
 * 统一表格：默认分页 20 条（NFR-5），与 /api 列表的 page / page_size 对齐。
 *
 * 表头吸顶用 antd/rc-table 的 `sticky`：它把表头渲染成独立的 sticky 容器，
 * **不依赖 `<thead>` 的 `position: sticky`**——后者会被表格的横向滚动容器
 * （`.ant-table-content { overflow-x: auto }`）吃掉，加了不起作用（实测 position 仍是 static）。
 */
export function DataTable<T extends object>({
  total,
  page = 1,
  pageSize = 20,
  onPageChange,
  pagination,
  size = 'middle',
  scroll,
  stickyHeader = true,
  ...rest
}: DataTableProps<T>) {
  const offsetHeader = useStickyOffset();

  const mergedPagination: TableProps<T>['pagination'] =
    pagination !== undefined
      ? pagination
      : {
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showQuickJumper: total !== undefined && total > 100,
          pageSizeOptions: ['10', '20', '50', '100'],
          showTotal: (count) => `共 ${count} 条`,
          onChange: (nextPage, nextSize) => onPageChange?.(nextPage, nextSize),
        };

  return (
    <Table<T>
      {...rest}
      size={size}
      scroll={scroll ?? { x: 'max-content' }}
      pagination={mergedPagination}
      sticky={stickyHeader ? { offsetHeader } : undefined}
    />
  );
}

export default DataTable;
