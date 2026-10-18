/** 项目接口 —— docs/03-接口设计.md 第 4 节 */
import { http } from './client';
import type { ListQuery, PageResult, Project, ProjectOverview, ProjectPayload } from '../types/domain';
import type { ProjectDateField } from '../store/app';

export interface ProjectListQuery extends ListQuery {
  status?: string;
  /** 日期筛选区间（配合 date_field 使用） */
  start_date?: string;
  end_date?: string;
  /**
   * 日期按什么筛（2026-10-17 需求）：
   * - `start_date`：开工日期落在区间内
   * - `activity`  ：区间内有业务数据（成本/收付款/往来/入库/结算）
   * 不传 = 不筛项目（老行为）
   */
  date_field?: ProjectDateField;
}

/** 兼容后端返回的多种 members 形态（数组 / JSON 字符串 / 逗号分隔） */
export function normalizeMembers(members: Project['members']): string[] {
  if (Array.isArray(members)) return members.map((m) => String(m));
  if (typeof members === 'string' && members.trim()) {
    try {
      const parsed = JSON.parse(members) as unknown;
      if (Array.isArray(parsed)) return parsed.map((m) => String(m));
    } catch {
      /* 不是 JSON，按分隔符切分 */
    }
    return members
      .split(/[,，]/)
      .map((m) => m.trim())
      .filter(Boolean);
  }
  return [];
}

export const projectApi = {
  list(query: ProjectListQuery = {}): Promise<PageResult<Project>> {
    return http.get<PageResult<Project>>('/projects', { ...query });
  },

  create(payload: ProjectPayload): Promise<Project> {
    return http.post<Project>('/projects', payload);
  },

  /** 项目详情（含概览指标） */
  detail(id: number, query?: { start_date?: string; end_date?: string }): Promise<ProjectOverview> {
    return http.get<ProjectOverview>(`/projects/${id}`, { ...query });
  },

  update(id: number, payload: Partial<ProjectPayload>): Promise<Project> {
    return http.put<Project>(`/projects/${id}`, payload);
  },

  /** 软删除；项目下有成本/流水时后端返回 409，需 force=true */
  remove(id: number, force = false): Promise<{ id: number; deleted: boolean }> {
    return http.delete<{ id: number; deleted: boolean }>(`/projects/${id}`, force ? { force: true } : undefined);
  },

  /** 单项目概览：两个利润、五类构成、已收已付、未收未付、库存金额 */
  overview(id: number, query?: { start_date?: string; end_date?: string }): Promise<ProjectOverview> {
    return http.get<ProjectOverview>(`/projects/${id}/overview`, { ...query });
  },

  /* ------------------------- 完工锁（2026-10-17 需求） -------------------------
   * 口径：完工后**所有写操作**都要先解锁；解锁 = 登录密码，一直有效直到手动重新锁定。
   */

  /** 「完工」：置为完工并落锁（不需要密码，加锁是安全方向） */
  finish(id: number): Promise<Project> {
    return http.post<Project>(`/projects/${id}/finish`);
  },

  /** 「撤销完工」：改回在建，**需要登录密码** */
  reopen(id: number, password: string): Promise<Project> {
    return http.post<Project>(`/projects/${id}/reopen`, { password });
  },

  /** 解锁：输登录密码后可写，一直有效直到重新锁定 */
  unlock(id: number, password: string): Promise<Project> {
    return http.post<Project>(`/projects/${id}/unlock`, { password });
  },

  /** 重新锁定（不需要密码） */
  lock(id: number): Promise<Project> {
    return http.post<Project>(`/projects/${id}/lock`);
  },
};
