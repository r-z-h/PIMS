import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space, Tag, Tooltip, message } from 'antd';
import { CheckCircleOutlined, LockOutlined, UnlockOutlined } from '@ant-design/icons';
import { projectApi } from '../api/projects';
import type { Project } from '../types';

/**
 * 完工锁的按钮组（2026-10-17 需求）。
 *
 * 口径（用户确认）：
 * - 完工后**所有写操作**都要先解锁；解锁后一直有效，直到手动「重新锁定」
 * - 「完工」不要密码（加锁是安全方向）；「撤销完工」要密码
 *
 * 项目列表与项目详情共用这一份，避免两处逻辑走样。
 */
export function useProjectLockActions(onChanged: () => void) {
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdMode, setPwdMode] = useState<'reopen' | 'unlock'>('unlock');
  const [pwdTarget, setPwdTarget] = useState<Project | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ password: string }>();

  const finish = (project: Project) => {
    Modal.confirm({
      title: `把项目「${project.name}」标记为完工？`,
      content:
        '完工后，这个项目的**所有改动都要先输入密码解锁**（新增成本、收付款、往来冲销、结算发放、库存出入库、改项目档案、删项目）。\n' +
        '解锁后一直有效，改完记得点「重新锁定」。',
      okText: '确认完工',
      cancelText: '取消',
      onOk: async () => {
        try {
          await projectApi.finish(project.id);
          void message.success('已标记完工，项目已锁定');
          onChanged();
        } catch {
          /* 拦截器已提示 */
        }
      },
    });
  };

  const askPassword = (project: Project, mode: 'reopen' | 'unlock') => {
    setPwdTarget(project);
    setPwdMode(mode);
    form.resetFields();
    setPwdOpen(true);
  };

  const submitPassword = async () => {
    if (!pwdTarget) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      if (pwdMode === 'reopen') {
        await projectApi.reopen(pwdTarget.id, values.password);
        void message.success('已撤销完工，项目恢复为在建');
      } else {
        await projectApi.unlock(pwdTarget.id, values.password);
        void message.success('已解锁，改完记得重新锁定');
      }
      setPwdOpen(false);
      onChanged();
    } catch {
      /* 密码错误由拦截器提示，留在弹窗重试 */
    } finally {
      setSubmitting(false);
    }
  };

  const lock = (project: Project) => {
    Modal.confirm({
      title: `重新锁定项目「${project.name}」？`,
      content: '锁定后，任何改动都要重新输入密码。',
      okText: '锁定',
      onOk: async () => {
        try {
          await projectApi.lock(project.id);
          void message.success('已重新锁定');
          onChanged();
        } catch {
          /* 拦截器已提示 */
        }
      },
    });
  };

  const passwordModal = (
    <Modal
      title={pwdMode === 'reopen' ? `撤销完工：${pwdTarget?.name ?? ''}` : `解锁：${pwdTarget?.name ?? ''}`}
      open={pwdOpen}
      onCancel={() => setPwdOpen(false)}
      onOk={() => void submitPassword()}
      okText={pwdMode === 'reopen' ? '确认撤销完工' : '解锁'}
      confirmLoading={submitting}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={
          pwdMode === 'reopen'
            ? '撤销完工后，项目变回「在建」，所有改动都不再需要密码。'
            : '解锁后可以修改这个已完工项目；一直有效，直到你手动「重新锁定」。'
        }
      />
      <Form form={form} layout="vertical">
        <Form.Item label="登录密码" name="password" rules={[{ required: true, message: '请输入登录密码' }]}>
          <Input.Password prefix={<LockOutlined />} placeholder="输入登录密码" autoFocus onPressEnter={() => void submitPassword()} />
        </Form.Item>
      </Form>
    </Modal>
  );

  return { finish, reopen: (p: Project) => askPassword(p, 'reopen'), unlock: (p: Project) => askPassword(p, 'unlock'), lock, passwordModal };
}

/** 项目状态/锁定状态的展示标签 */
export function ProjectLockTag({ project }: { project: Project }) {
  if (project.status !== 'finished') return <Tag color="processing">在建</Tag>;
  if (project.is_locked) {
    return (
      <Tooltip title="已完工并锁定：所有改动都要先输入密码解锁">
        <Tag color="default" icon={<LockOutlined />}>
          完工·已锁
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={`已解锁（${project.unlocked_at ?? ''}）：改完记得重新锁定`}>
      <Tag color="orange" icon={<UnlockOutlined />}>
        完工·已解锁
      </Tag>
    </Tooltip>
  );
}

/** 项目详情页顶部的解锁提示条（带「重新锁定」按钮） */
export function ProjectLockBanner({ project, onLock }: { project: Project; onLock: () => void }) {
  if (project.status !== 'finished' || project.is_locked) return null;
  return (
    <Alert
      type="warning"
      showIcon
      icon={<UnlockOutlined />}
      style={{ marginBottom: 12 }}
      message={`项目已完工，当前已解锁（${project.unlocked_at ?? ''}）——可以修改`}
      description="解锁状态会一直保留（含重启后）。改完请点右侧「重新锁定」，避免以后误改。"
      action={
        <Space>
          <Button size="small" icon={<CheckCircleOutlined />} onClick={onLock}>
            重新锁定
          </Button>
        </Space>
      }
    />
  );
}

/** 已完工且已锁定时，详情页顶部提示（说明为什么改不了） */
export function ProjectLockedHint({ project }: { project: Project }) {
  if (project.status !== 'finished' || !project.is_locked) return null;
  return (
    <Alert
      type="info"
      showIcon
      icon={<LockOutlined />}
      style={{ marginBottom: 12 }}
      message="项目已完工并锁定，所有改动都需要先输入密码解锁"
      description="直接去改即可：系统会弹出密码框，解锁后自动继续这次操作。"
    />
  );
}

export default useProjectLockActions;
