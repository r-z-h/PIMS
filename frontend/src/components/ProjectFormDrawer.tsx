import { useEffect, useState } from 'react';
import { Button, DatePicker, Drawer, Form, Input, Modal, Select, Space, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import MoneyInput from './MoneyInput';
import MoneyText from './MoneyText';
import { normalizeMembers, projectApi } from '../api/projects';
import { useAppStore } from '../store/app';
import { ApiError } from '../types/api';
import type { Project } from '../types';
import { gtMoney, subMoney } from '../utils/money';
import { PROJECT_STATUS_LABEL, toOptions } from '../utils/enums';

export interface ProjectFormValues {
  name: string;
  client_name?: string;
  location?: string;
  manager?: string;
  start_date?: Dayjs | null;
  status: 'ongoing' | 'finished';
  client_budget: number | null;
  cost_budget: number | null;
  members?: string[];
  remark?: string;
}

export interface ProjectFormDrawerProps {
  open: boolean;
  /** 传了就是编辑，不传是新建 */
  project: Project | null;
  onClose: () => void;
  /** 保存成功后回调（列表页刷新表格、详情页刷新自身） */
  onSaved?: (project: Project) => void;
}

/**
 * 项目新建 / 编辑抽屉。
 *
 * 抽成共用组件的原因：项目列表与项目详情页**都要能改项目**
 * （2026-10-16 需求：详情页要能编辑与删除），两处各写一份必然走样。
 */
export function ProjectFormDrawer({ open, project, onClose, onSaved }: ProjectFormDrawerProps) {
  const [form] = Form.useForm<ProjectFormValues>();
  const [saving, setSaving] = useState(false);
  const loadProjects = useAppStore((s) => s.loadProjects);

  const clientBudget = Form.useWatch('client_budget', form);
  const costBudget = Form.useWatch('cost_budget', form);
  const startDate = Form.useWatch('start_date', form);
  const overBudget = gtMoney(costBudget, clientBudget) && Number(clientBudget ?? 0) > 0;
  const futureDate = Boolean(startDate && startDate.isAfter(dayjs(), 'day'));

  // 打开时按「编辑」或「新建」填初值
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (project) {
      form.setFieldsValue({
        name: project.name,
        client_name: project.client_name ?? undefined,
        location: project.location ?? undefined,
        manager: project.manager ?? undefined,
        start_date: project.start_date ? dayjs(project.start_date) : null,
        status: project.status,
        client_budget: Number(project.client_budget ?? 0),
        cost_budget: Number(project.cost_budget ?? 0),
        members: normalizeMembers(project.members),
        remark: project.remark ?? undefined,
      });
    } else {
      form.setFieldsValue({ status: 'ongoing', client_budget: null, cost_budget: null, members: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  const submit = async () => {
    const values = await form.validateFields();
    if (Number(values.client_budget ?? 0) < 0 || Number(values.cost_budget ?? 0) < 0) {
      void message.error('预算不能为负数');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        client_name: values.client_name?.trim() ?? null,
        location: values.location?.trim() ?? null,
        manager: values.manager?.trim() ?? null,
        start_date: values.start_date ? values.start_date.format('YYYY-MM-DD') : null,
        status: values.status,
        client_budget: values.client_budget ?? 0,
        cost_budget: values.cost_budget ?? 0,
        members: values.members ?? [],
        remark: values.remark ?? null,
      };
      let saved: Project;
      if (project) {
        saved = await projectApi.update(project.id, payload);
        void message.success('项目已更新');
      } else {
        saved = await projectApi.create(payload);
        void message.success('项目已创建');
      }
      onClose();
      // 同步刷新全局项目缓存：否则顶部「当前项目」选择器与各录入表单的项目下拉
      // 要等到整页刷新才能看到刚建/刚改的项目（缓存命中后不会自动重取）
      await loadProjects(true);
      onSaved?.(saved);
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title={project ? `编辑项目：${project.name}` : '新建项目'}
      width={560}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void submit()}>
            保存
          </Button>
        </Space>
      }
    >
      <Form<ProjectFormValues> form={form} layout="vertical" initialValues={{ status: 'ongoing', members: [] }}>
        <Form.Item label="项目名称" name="name" rules={[{ required: true, message: '项目名称必填' }]}>
          <Input placeholder="例如：某小区 5#楼" />
        </Form.Item>
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item label="甲方（业主）" name="client_name" style={{ flex: 1 }}>
            <Input placeholder="某某置业有限公司" />
          </Form.Item>
          <Form.Item label="地点" name="location" style={{ flex: 1 }}>
            <Input placeholder="武汉市洪山区" />
          </Form.Item>
        </Space>
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item label="负责人" name="manager" style={{ width: 200 }}>
            <Input placeholder="王工" />
          </Form.Item>
          <Form.Item
            label="开工日期"
            name="start_date"
            extra={futureDate ? <span style={{ color: '#d46b08' }}>未来日期，确认？</span> : undefined}
          >
            <DatePicker style={{ width: 200 }} placeholder="选择日期" />
          </Form.Item>
          <Form.Item label="状态" name="status" style={{ width: 140 }}>
            <Select options={toOptions(PROJECT_STATUS_LABEL)} />
          </Form.Item>
        </Space>
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item
            label="甲方预算（合同额）"
            name="client_budget"
            rules={[{ required: true, message: '甲方预算必填' }]}
            style={{ width: 240 }}
          >
            <MoneyInput placeholder="0.00" />
          </Form.Item>
          <Form.Item
            label="我方成本预算"
            name="cost_budget"
            rules={[{ required: true, message: '成本预算必填' }]}
            style={{ width: 240 }}
            extra={overBudget ? <span style={{ color: '#d46b08' }}>成本预算大于甲方预算，请确认</span> : undefined}
          >
            <MoneyInput placeholder="0.00" />
          </Form.Item>
        </Space>
        <div style={{ marginBottom: 16 }}>
          预计利润：<MoneyText value={subMoney(clientBudget ?? 0, costBudget ?? 0)} bold />
        </div>
        <Form.Item label="项目成员名单" name="members" extra="纯名单，不做权限；回车可新增一个姓名">
          <Select mode="tags" placeholder="王工 / 张三 / 李四" tokenSeparators={[',', '，', ' ']} />
        </Form.Item>
        <Form.Item label="备注" name="remark">
          <Input.TextArea rows={3} placeholder="选填" />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

/**
 * 删除项目（含「已有成本/流水 → 强制删除」的二次确认）。
 *
 * 抽成共用函数：项目列表与项目详情页都能删（2026-10-16 需求），逻辑必须一致。
 */
export function confirmDeleteProject(project: Project, onDone?: () => void): void {
  const remove = async (force: boolean, done: () => void) => {
    await projectApi.remove(project.id, force);
    void message.success(force ? '已强制删除' : '已删除');
    const loadProjects = useAppStore.getState().loadProjects;
    await loadProjects(true);
    done();
    onDone?.();
  };

  Modal.confirm({
    title: `删除项目「${project.name}」？`,
    okType: 'danger',
    okText: '确认删除',
    content: '将同时隐藏该项目下的成本与流水（软删除，可在「显示已删除」开关打开后查看）。',
    onOk: async () => {
      try {
        await remove(false, () => undefined);
      } catch (error) {
        if (error instanceof ApiError && error.code === 409) {
          Modal.confirm({
            title: '该项目下已有成本或流水',
            content: '确认强制删除？删除后该项目及其成本、流水默认不再显示。',
            okType: 'danger',
            okText: '强制删除',
            onOk: async () => {
              await remove(true, () => undefined);
            },
          });
        }
      }
    },
  });
}

export default ProjectFormDrawer;
