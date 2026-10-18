/** 看板与报表接口 —— docs/03-接口设计.md 第 10 节 */
import { asList, http } from './client';
import type { ProjectDateField } from '../store/app';
import type { CostTrendPoint, DashboardProjects, RecentActivity } from '../types/domain';

export const dashboardApi = {
  /**
   * 首页项目盈亏总表。
   *
   * `date_field`（2026-10-17 需求）：**项目列表怎么筛，首页就怎么筛**——
   * `start_date` 按开工日期、`activity` 按区间内有业务数据；不传则不筛项目（只筛金额）。
   */
  projects(query?: {
    start_date?: string;
    end_date?: string;
    date_field?: ProjectDateField;
  }): Promise<DashboardProjects> {
    return http.get<DashboardProjects>('/dashboard/projects', { ...query });
  },

  /** 最近 10 条业务动态 */
  async recent(): Promise<RecentActivity[]> {
    const data = await http.get<RecentActivity[] | { items: RecentActivity[] }>('/dashboard/recent');
    return asList<RecentActivity>(data);
  },

  /** 按月的成本趋势（可选图表） */
  async costTrend(query?: { start_date?: string; end_date?: string }): Promise<CostTrendPoint[]> {
    const data = await http.get<CostTrendPoint[] | { items: CostTrendPoint[] }>(
      '/dashboard/cost-trend',
      { ...query },
    );
    return asList<CostTrendPoint>(data);
  },
};
