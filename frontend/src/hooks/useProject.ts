import { useCallback, useEffect, useMemo } from 'react';
import { useAppStore } from '../store/app';
import type { Project } from '../types';

export interface UseProjectsResult {
  projects: Project[];
  loading: boolean;
  reload: () => Promise<void>;
  currentProjectId: number | null;
  currentProject: Project | null;
  setCurrentProjectId: (id: number | null) => void;
  /** 下拉选项：value 为项目 id */
  options: Array<{ value: number; label: string }>;
  /** 项目名称映射 */
  nameOf: (projectId: number | null | undefined) => string;
}

/** 项目列表 + 当前项目（顶部项目选择器），数据缓存在 Zustand，避免重复请求 */
export function useProjects(autoLoad = true): UseProjectsResult {
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const setCurrentProjectId = useAppStore((s) => s.setCurrentProjectId);
  const projects = useAppStore((s) => s.projects);
  const loading = useAppStore((s) => s.projectsLoading);
  const loadProjects = useAppStore((s) => s.loadProjects);

  useEffect(() => {
    if (autoLoad) void loadProjects();
  }, [autoLoad, loadProjects]);

  const reload = useCallback(async () => {
    await loadProjects(true);
  }, [loadProjects]);

  const currentProject = useMemo(
    () => projects.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  );

  const options = useMemo(() => projects.map((p) => ({ value: p.id, label: p.name })), [projects]);

  const nameOf = useCallback(
    (projectId: number | null | undefined) => {
      if (!projectId) return '-';
      return projects.find((p) => p.id === projectId)?.name ?? '-';
    },
    [projects],
  );

  return {
    projects,
    loading,
    reload,
    currentProjectId,
    currentProject,
    setCurrentProjectId,
    options,
    nameOf,
  };
}
