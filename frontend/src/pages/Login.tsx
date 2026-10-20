import { useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Card, Form, Input, Space, Steps, Typography, message } from 'antd';
import { LockOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth';
import { ApiError } from '../types/api';
import { hasSessionHint, useAppStore } from '../store/app';

const { Title, Paragraph, Text } = Typography;

const COMMON_QUESTIONS = [
  '我第一辆车的车牌号？',
  '我母亲的姓名？',
  '我小学的名字？',
  '我最喜欢的城市？',
  '我父亲的生日？',
  '我家第一套房的门牌号？',
];

export interface LoginProps {
  mode: 'login' | 'setup' | 'forgot';
}

interface SetupFormValues {
  questions: Array<{ question: string; answer: string }>;
}

/**
 * 登录 / 密保（设置 / 忘记密码）—— docs/01-开发手册.md 5.1。
 * 首次登录 security_ready=false 时强制设置 3 组密保，保存后才放行。
 */
export default function Login({ mode }: LoginProps) {
  const navigate = useNavigate();
  const setAuth = useAppStore((s) => s.setAuth);
  const confirmLogin = useAppStore((s) => s.confirmLogin);
  const loggedIn = useAppStore((s) => s.loggedIn);
  const securityReady = useAppStore((s) => s.securityReady);
  const isInitialPassword = useAppStore((s) => s.isInitialPassword);
  const authLoaded = useAppStore((s) => s.authLoaded);
  const sessionExpired = useAppStore((s) => s.sessionExpired);

  const [submitting, setSubmitting] = useState(false);
  const [questions, setQuestions] = useState<string[]>([]);
  const [ticket, setTicket] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(mode !== 'forgot' && !authLoaded);

  /**
   * 进入登录页时确认系统状态（用于提示初始密码）。
   *
   * 「已登录 → 自动放行」只依赖两项，都以服务端判定为准：
   *   1) `status.logged_in` —— 后端已改为「**本请求**携带的 Cookie 有效」，
   *      所以它不会再出现「服务端有会话、本机没 Cookie 却被告知已登录」的误导；
   *   2) `!sessionExpired` —— 本次未被服务端 401 拒绝（避免刚被踢下线又跳回去）。
   *
   * 不再使用 localStorage 登录痕迹做闸门：那会导致「浏览器数据被清、但 Cookie 仍有效」
   * 时被迫重新输密码，属于没必要的代价。
   */
  useEffect(() => {
    if (mode === 'forgot') {
      setCheckingStatus(false);
      void authApi
        .securityQuestions()
        .then((data) => setQuestions(data.questions ?? []))
        .catch(() => setQuestions([]));
      return;
    }

    const trustedSession = (logged: boolean) => logged && !sessionExpired;

    if (authLoaded) {
      setCheckingStatus(false);
      if (mode === 'login' && trustedSession(Boolean(loggedIn))) {
        navigate(securityReady ? '/' : '/security-setup', { replace: true });
      }
      if (mode === 'setup' && !trustedSession(Boolean(loggedIn))) {
        navigate('/login', { replace: true });
      }
      return;
    }

    let alive = true;
    void authApi
      .status()
      .then((status) => {
        if (!alive) return;
        setAuth(status);
        if (mode === 'login' && trustedSession(status.logged_in)) {
          navigate(status.security_ready ? '/' : '/security-setup', { replace: true });
        }
        if (mode === 'setup' && !trustedSession(status.logged_in)) {
          navigate('/login', { replace: true });
        }
      })
      .catch(() => {
        /* 后端未启动时保持登录页可见 */
      })
      .finally(() => {
        if (alive) setCheckingStatus(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, authLoaded]);

  /* ------------------------------ 密码登录 ------------------------------ */
  const handleLogin = async (values: { password: string }) => {
    setSubmitting(true);
    try {
      const result = await authApi.login(values.password);
      // 显式登录成功：留痕 + 解除 401 闩锁（不能只靠 /auth/status 回报的状态）
      confirmLogin({
        security_ready: result.security_ready,
        is_initial_password: result.is_initial_password,
      });
      if (!result.security_ready) {
        void message.warning('首次使用，请先设置 3 个密保问题');
        navigate('/security-setup', { replace: true });
        return;
      }
      void message.success('登录成功');
      // 登录后一律回到首页（项目盈亏总表）：
      // 既不恢复「被踢出时所在的业务页」——那会让守卫出现「在 / 却渲染 /projects 内容」的不一致，
      // 也不符合「打开就看盈亏总表」的使用预期。
      navigate('/', { replace: true });
    } catch {
      /* 错误提示由响应拦截器统一处理 */
    } finally {
      setSubmitting(false);
    }
  };

  /* ------------------------------ 首次设置密保 ------------------------------ */
  const handleSetup = async (values: SetupFormValues) => {
    const list = (values.questions ?? []).filter((q) => q && q.question && q.answer);
    if (list.length !== 3) {
      void message.error('必须填写 3 组密保问题与答案');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.setupSecurity(list.map((q) => ({ question: q.question.trim(), answer: q.answer.trim() })));
      confirmLogin({ security_ready: true, is_initial_password: isInitialPassword });
      void message.success('密保设置成功');
      navigate('/', { replace: true });
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSubmitting(false);
    }
  };

  /* ------------------------------ 忘记密码 ------------------------------ */
  const handleVerify = async (values: { answers: string[] }) => {
    setSubmitting(true);
    try {
      const result = await authApi.verifySecurity((values.answers ?? []).map((a) => (a ?? '').trim()));
      setTicket(result.ticket);
      void message.success('密保校验通过，请设置新密码');
    } catch (error) {
      const text = error instanceof ApiError && error.code === 403 ? '密保答案不正确' : (error as Error).message;
      void message.error(text);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (values: { new_password: string; confirm: string }) => {
    if (!ticket) return;
    if (values.new_password !== values.confirm) {
      void message.error('两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.resetPassword({ ticket, new_password: values.new_password });
      void message.success('密码已重置，请用新密码登录');
      navigate('/login', { replace: true });
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSubmitting(false);
    }
  };

  const cardStyle: React.CSSProperties = { width: 520, maxWidth: '92vw' };

  /**
   * 「会话已失效」提示：仅在**确实被踢下线**时出现，不做任何跳转判定。
   * - sessionExpired：本次页面生命周期内被服务端 401 拒绝（最常见）；
   * - hasSessionHint() && 已确认未登录：本机此前登录过、刷新后服务端说不认（跨刷新的场景）。
   * 明确的「退出登录」会清掉痕迹（store.reset），所以不会误报。
   */
  const sessionExpiredNotice =
    mode === 'login' && (sessionExpired || (authLoaded && loggedIn === false && hasSessionHint()));

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
        padding: 24,
      }}
    >
      <Card style={cardStyle} loading={checkingStatus}>
        <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>
            {mode === 'login' ? '工程一体化管理系统' : mode === 'setup' ? '设置密保问题' : '忘记密码'}
          </Title>
          <Text type="secondary">
            {mode === 'login'
              ? '单机单用户，输一次密码即可长期使用'
              : mode === 'setup'
                ? '首次使用必须设置 3 组密保问题与答案，保存后才能进入系统'
                : '答对 3 个密保问题后才能重设密码'}
          </Text>
        </Space>

        {mode === 'login' && (
          <>
            {sessionExpiredNotice && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message="上次登录已失效，请重新登录"
                description="会话可能已在别处重新登录，或已超过有效期。重新登录后即可继续。"
              />
            )}
            {isInitialPassword && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="当前仍是初始密码 123456，登录后请在设置页修改"
              />
            )}
            {/* 不再预填默认密码（2026-10-20）：公开仓库里把 123456 写进登录框等于把默认口令明示出去 */}
            <Form layout="vertical" onFinish={handleLogin}>
              <Form.Item
                label="登录密码"
                name="password"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder="请输入密码"
                  autoFocus
                  onPressEnter={undefined}
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={submitting}>
                登录
              </Button>
            </Form>
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <Typography.Link onClick={() => navigate('/forgot-password')}>忘记密码？</Typography.Link>
            </div>
          </>
        )}

        {mode === 'setup' && (
          <Form<SetupFormValues>
            layout="vertical"
            onFinish={handleSetup}
            initialValues={{ questions: [{}, {}, {}] }}
          >
            {[0, 1, 2].map((index) => (
              <Card
                key={index}
                size="small"
                title={`密保问题 ${index + 1}`}
                style={{ marginBottom: 12 }}
                styles={{ body: { paddingBottom: 0 } }}
              >
                <Form.Item
                  label="问题"
                  name={['questions', index, 'question']}
                  rules={[{ required: true, message: '请填写密保问题' }]}
                >
                  <AutoComplete
                    options={COMMON_QUESTIONS.map((q) => ({ value: q }))}
                    placeholder="可直接选择常用问题，也可自己写"
                    filterOption={(input, option) => String(option?.value ?? '').includes(input)}
                  />
                </Form.Item>
                <Form.Item
                  label="答案"
                  name={['questions', index, 'answer']}
                  rules={[{ required: true, message: '请填写密保答案' }]}
                >
                  <Input prefix={<QuestionCircleOutlined />} placeholder="答案（忘记密码时校验）" />
                </Form.Item>
              </Card>
            ))}
            <Button type="primary" htmlType="submit" block loading={submitting}>
              保存并进入系统
            </Button>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
              密保答案只保存散列，请自行记牢；忘记密码只能靠这 3 个问题找回。
            </Paragraph>
          </Form>
        )}

        {mode === 'forgot' && (
          <>
            <Steps
              size="small"
              current={ticket ? 1 : 0}
              items={[{ title: '回答密保' }, { title: '设置新密码' }]}
              style={{ marginBottom: 16 }}
            />
            {!ticket ? (
              <Form
                layout="vertical"
                onFinish={handleVerify}
                initialValues={{ answers: ['', '', ''] }}
              >
                {[0, 1, 2].map((index) => (
                  <Form.Item
                    key={index}
                    label={questions[index] ?? `密保问题 ${index + 1}`}
                    name={['answers', index]}
                    rules={[{ required: true, message: '请填写答案' }]}
                  >
                    <Input placeholder="请输入答案" />
                  </Form.Item>
                ))}
                <Button type="primary" htmlType="submit" block loading={submitting}>
                  校验密保答案
                </Button>
              </Form>
            ) : (
              <Form layout="vertical" onFinish={handleReset}>
                <Form.Item
                  label="新密码"
                  name="new_password"
                  rules={[
                    { required: true, message: '请输入新密码' },
                    { min: 6, message: '密码至少 6 位' },
                  ]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="至少 6 位" />
                </Form.Item>
                <Form.Item
                  label="确认新密码"
                  name="confirm"
                  dependencies={['new_password']}
                  rules={[{ required: true, message: '请再次输入新密码' }]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="再次输入" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={submitting}>
                  重置密码
                </Button>
              </Form>
            )}
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <Typography.Link onClick={() => navigate('/login')}>返回登录</Typography.Link>
            </div>
          </>
        )}

        {mode === 'setup' && loggedIn === false && (
          <Alert type="warning" showIcon message="尚未登录，请先返回登录页" style={{ marginTop: 12 }} />
        )}
        {mode === 'setup' && securityReady && (
          <Alert type="success" showIcon message="密保已设置，可重新填写覆盖" style={{ marginTop: 12 }} />
        )}
      </Card>
    </div>
  );
}
