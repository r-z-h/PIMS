import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Form, Input, Modal, Typography, message } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { registerProjectLockHandler, type ProjectLockInfo } from '../api/client';
import { projectApi } from '../api/projects';
import { useAppStore } from '../store/app';

const { Text } = Typography;

/**
 * 项目完工锁的「密码闸门」（2026-10-17 需求）。
 *
 * 完工后所有写操作都会被后端 409 拦下。这里统一接住：
 * **输登录密码 → 解锁 → 自动重试刚才那次操作**，用户不用再点一遍。
 *
 * 为什么做成全局一个：写操作散布在十几个页面，逐个写提示必然漏；
 * axios 拦截器把锁定错误集中抛到这里，一处兜住全部。
 */
export function ProjectLockGate() {
  const [form] = Form.useForm<{ password: string }>();
  const [info, setInfo] = useState<ProjectLockInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** 用来把「用户是否解锁成功」回传给拦截器 */
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  const loadProjects = useAppStore((s) => s.loadProjects);

  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setInfo(null);
    setSubmitting(false);
    form.resetFields();
  }, [form]);

  useEffect(() => {
    registerProjectLockHandler(
      (lockInfo) =>
        new Promise<boolean>((resolve) => {
          resolverRef.current = resolve;
          form.resetFields();
          setInfo(lockInfo);
        }),
    );
    return () => registerProjectLockHandler(null);
  }, [form]);

  const submit = async () => {
    if (!info) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await projectApi.unlock(info.projectId, values.password);
      void message.success('已解锁，本次操作已自动重试');
      // 刷新全局项目缓存：各页面的项目状态（是否锁定）要跟着变
      await loadProjects(true);
      settle(true);
    } catch {
      // 拦截器已提示「密码不正确」；留在弹窗里让用户重试
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="项目已完工，需要解锁"
      open={Boolean(info)}
      onCancel={() => settle(false)}
      onOk={() => void submit()}
      okText="解锁并继续"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnClose
      maskClosable={false}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message={info?.message ?? '该项目已完工并锁定'}
        description="完工项目的所有改动都要先解锁。解锁后一直有效，改完请在项目页点「重新锁定」。"
      />
      <Form form={form} layout="vertical">
        <Form.Item
          label="登录密码"
          name="password"
          rules={[{ required: true, message: '请输入登录密码' }]}
        >
          <Input.Password
            prefix={<LockOutlined />}
            placeholder="输入登录密码后自动重试刚才的操作"
            autoFocus
            onPressEnter={() => void submit()}
          />
        </Form.Item>
      </Form>
      <Text type="secondary" style={{ fontSize: 12 }}>
        解锁状态会保留（含重启后），直到你手动「重新锁定」。
      </Text>
    </Modal>
  );
}

export default ProjectLockGate;
