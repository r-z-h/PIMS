/** 数据字典接口 —— docs/03-接口设计.md 第 3 节 */
import { asList, http } from './client';
import type { DictItem, DictPayload, DictType } from '../types/domain';

export const dictApi = {
  async list(dictType: DictType): Promise<DictItem[]> {
    const data = await http.get<DictItem[] | { items: DictItem[] }>(`/dict/${dictType}`);
    return asList<DictItem>(data);
  },

  create(payload: DictPayload): Promise<DictItem> {
    return http.post<DictItem>('/dict', payload);
  },

  update(id: number, payload: Partial<DictPayload>): Promise<DictItem> {
    return http.put<DictItem>(`/dict/${id}`, payload);
  },

  remove(id: number): Promise<{ id: number; deleted?: boolean; enabled?: number }> {
    return http.delete<{ id: number; deleted?: boolean; enabled?: number }>(`/dict/${id}`);
  },
};
