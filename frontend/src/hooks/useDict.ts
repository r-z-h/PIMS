import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/app';
import { dictApi } from '../api/dict';
import type { DictItem, DictPayload, DictType } from '../types';

export interface UseDictResult {
  items: DictItem[];
  loading: boolean;
  reload: () => Promise<void>;
  create: (name: string) => Promise<DictItem>;
  update: (id: number, payload: Partial<DictPayload>) => Promise<void>;
  remove: (id: number) => Promise<void>;
  /** 下拉选项（仅启用项） */
  options: Array<{ value: string; label: string }>;
}

/** 字典缓存 hook：杂费小类 / 材料 / 单位 / 对方 */
export function useDict(dictType: DictType, autoLoad = true): UseDictResult {
  const dicts = useAppStore((s) => s.dicts);
  const dictLoading = useAppStore((s) => s.dictLoading);
  const loadDict = useAppStore((s) => s.loadDict);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (autoLoad && !dicts[dictType]) void loadDict(dictType);
  }, [autoLoad, dictType, dicts, loadDict]);

  const reload = useCallback(async () => {
    setReloading(true);
    try {
      await loadDict(dictType, true);
    } finally {
      setReloading(false);
    }
  }, [dictType, loadDict]);

  const create = useCallback(
    async (name: string) => {
      const row = await dictApi.create({ dict_type: dictType, name });
      await loadDict(dictType, true);
      return row;
    },
    [dictType, loadDict],
  );

  const update = useCallback(
    async (id: number, payload: Partial<DictPayload>) => {
      await dictApi.update(id, payload);
      await loadDict(dictType, true);
    },
    [dictType, loadDict],
  );

  const remove = useCallback(
    async (id: number) => {
      await dictApi.remove(id);
      await loadDict(dictType, true);
    },
    [dictType, loadDict],
  );

  const items = useMemo(() => dicts[dictType] ?? [], [dicts, dictType]);
  const options = useMemo(
    () => items.filter((i) => i.enabled !== 0).map((i) => ({ value: i.name, label: i.name })),
    [items],
  );

  return {
    items,
    loading: Boolean(dictLoading[dictType]) || reloading,
    reload,
    create,
    update,
    remove,
    options,
  };
}
