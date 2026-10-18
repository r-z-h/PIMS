import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Space,
  Switch,
  Tabs,
  Typography,
  message,
} from 'antd';
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  MinusOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import DataTable from '../components/DataTable';
import ExportButton from '../components/ExportButton';
import { authApi, systemApi } from '../api/auth';
import { dictApi } from '../api/dict';
import { useDict } from '../hooks/useDict';
import { useAppStore } from '../store/app';
import { ApiError } from '../types/api';
import type { BackupResult, DictItem, DictType } from '../types';
import { DICT_TYPE_LABEL } from '../utils/enums';

const { Text, Title, Paragraph } = Typography;

const DICT_TABS: DictType[] = ['misc_category', 'material', 'unit', 'partner'];

/** 设置：字典维护 / 修改密码 / 备份 / 显示已删除开关 / 导出（docs/01-开发手册.md 5.9） */
export default function Settings() {
  const showDeleted = useAppStore((s) => s.showDeleted);
  const setShowDeleted = useAppStore((s) => s.setShowDeleted);
  const isInitialPassword = useAppStore((s) => s.isInitialPassword);
  /**
   * 「修改密码」卡片是否收起（需求 T1 + T5）。
   * **默认收起**：进设置页时字典维护直接铺满整页，要看修改密码自己点右上角「修改密码 ＋」。
   * 初始密码提示不因此自动展开——用户想看时自己点开。
   */
  const [pwdCollapsed, setPwdCollapsed] = useState(true);

  const [questions, setQuestions] = useState<string[]>([]);
  const [pwdForm] = Form.useForm<{ answers: string[]; new_password: string; confirm: string }>();
  const [changing, setChanging] = useState(false);
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [backingUp, setBackingUp] = useState(false);

  useEffect(() => {
    void authApi
      .securityQuestions()
      .then((data) => setQuestions(data.questions ?? []))
      .catch(() => setQuestions([]));
  }, []);

  const changePassword = async () => {
    const values = await pwdForm.validateFields();
    if (values.new_password !== values.confirm) {
      void message.error('两次输入的新密码不一致');
      return;
    }
    setChanging(true);
    try {
      // 口径：必须 3 个密保问题全部答对才允许改密（00-需求冻结 FR-1.3）
      await authApi.changePassword({
        new_password: values.new_password,
        answers: (values.answers ?? []).map((a) => (a ?? '').trim()),
      });
      void message.success('密码已修改');
      pwdForm.resetFields();
    } catch (error) {
      const text = error instanceof ApiError && error.code === 403 ? '密保答案不正确' : (error as Error).message;
      void message.error(text);
    } finally {
      setChanging(false);
    }
  };

  const backup = async () => {
    setBackingUp(true);
    try {
      const result = await systemApi.backup();
      setBackupResult(result);
      void message.success('数据库已备份');
    } finally {
      setBackingUp(false);
    }
  };

  return (
    <div className="pims-page">
      <div className="pims-toolbar">
        <Space size={12}>
          <Title level={5} style={{ margin: 0 }}>
            设置
          </Title>
          <Text type="secondary">字典维护、修改密码、数据备份与导出</Text>
        </Space>
        <ExportButton label="导出全部数据（多 Sheet）" />
      </div>
      <div className="pims-page-body">
        <Row gutter={16}>
          {/* 「修改密码」收起时：卡片整体消失，字典维护铺满整页 */}
          <Col xs={24} xl={pwdCollapsed ? 24 : 14}>
            <Card
              title="字典维护"
              style={{ marginBottom: 16 }}
              extra={
                // 收起/展开「修改密码」的唯一入口：收起时显示「修改密码 ＋」，展开后变「修改密码 −」
                <Button
                  size="small"
                  type={pwdCollapsed ? 'default' : 'text'}
                  icon={pwdCollapsed ? <PlusOutlined /> : <MinusOutlined />}
                  aria-label={pwdCollapsed ? '展开修改密码' : '收起修改密码'}
                  onClick={() => setPwdCollapsed(!pwdCollapsed)}
                >
                  修改密码
                </Button>
              }
            >
              <Tabs
                items={DICT_TABS.map((type) => ({
                  key: type,
                  label: DICT_TYPE_LABEL[type],
                  children: <DictPanel dictType={type} />,
                }))}
              />
            </Card>
            {/*
              「数据与显示」里是"显示已删除记录"开关和"备份数据库"，
              这两个功能跟修改密码无关，**不能跟着一起收起**（否则默认收起后就没入口了）。
              收起时放在字典维护下面，展开时挪到右栏（见下）。
            */}
            {pwdCollapsed && (
              <DataCard
                showDeleted={showDeleted}
                onShowDeletedChange={setShowDeleted}
                backingUp={backingUp}
                onBackup={() => void backup()}
                backupResult={backupResult}
              />
            )}
          </Col>
          {!pwdCollapsed && (
            <Col xs={24} xl={10}>
              <Card title="修改密码" style={{ marginBottom: 16 }}>
                <Alert
                  type={isInitialPassword ? 'warning' : 'info'}
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={
                    isInitialPassword
                      ? '当前仍是初始密码 123456，建议尽快修改'
                      : '必须 3 个密保问题全部答对才能修改密码，无其他后门'
                  }
                />
                <Form form={pwdForm} layout="vertical" initialValues={{ answers: ['', '', ''] }}>
                  {[0, 1, 2].map((index) => (
                    <Form.Item
                      key={index}
                      label={questions[index] ?? `密保问题 ${index + 1}`}
                      name={['answers', index]}
                      rules={[{ required: true, message: '请填写密保答案' }]}
                    >
                      <Input placeholder="密保答案" />
                    </Form.Item>
                  ))}
                  <Form.Item
                    label="新密码"
                    name="new_password"
                    rules={[
                      { required: true, message: '请输入新密码' },
                      { min: 6, message: '密码至少 6 位' },
                    ]}
                  >
                    <Input.Password placeholder="至少 6 位" />
                  </Form.Item>
                  <Form.Item label="确认新密码" name="confirm" rules={[{ required: true, message: '请再次输入新密码' }]}>
                    <Input.Password placeholder="再次输入" />
                  </Form.Item>
                  <Button type="primary" icon={<SaveOutlined />} loading={changing} onClick={() => void changePassword()}>
                    修改密码
                  </Button>
                </Form>
              </Card>

              <DataCard
                showDeleted={showDeleted}
                onShowDeletedChange={setShowDeleted}
                backingUp={backingUp}
                onBackup={() => void backup()}
                backupResult={backupResult}
              />
            </Col>
          )}
        </Row>
      </div>
    </div>
  );
}

interface DataCardProps {
  showDeleted: boolean;
  onShowDeletedChange: (value: boolean) => void;
  backingUp: boolean;
  onBackup: () => void;
  backupResult: BackupResult | null;
}

/**
 * 「数据与显示」：显示已删除记录开关 + 备份数据库 + 口径说明。
 * 单独抽出来是因为它**必须始终可见**——不能跟着「修改密码」一起收起（需求 T5 的连带修正）。
 */
function DataCard({ showDeleted, onShowDeletedChange, backingUp, onBackup, backupResult }: DataCardProps) {
  return (
    <Card title="数据与显示">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Switch
            checked={showDeleted}
            onChange={(value) => {
              onShowDeletedChange(value);
              void message.success(value ? '列表将显示已删除记录' : '列表已隐藏已删除记录');
            }}
          />
          <Text>显示已删除记录</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            （软删除记录默认过滤，打开后列表按 include_deleted 查询）
          </Text>
        </Space>
        <Divider style={{ margin: '4px 0' }} />
        <Space wrap>
          <Button icon={<CloudDownloadOutlined />} loading={backingUp} onClick={onBackup}>
            备份数据库
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            直接复制 SQLite 数据文件，拷走即完成备份
          </Text>
        </Space>
        {backupResult && (
          <Alert
            type="success"
            showIcon
            message="备份完成"
            description={
              <Space direction="vertical" size={2}>
                <Text copyable={{ text: backupResult.path }}>{backupResult.path}</Text>
                {backupResult.size ? (
                  <Text type="secondary">文件大小：{Math.round(backupResult.size / 1024)} KB</Text>
                ) : null}
              </Space>
            }
          />
        )}
        <Divider style={{ margin: '4px 0' }} />
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          实际成本 ＝ 人工 + 材料 + 机械 + 杂费 + 垫付（仅统计未删除记录）；预计利润 ＝ 甲方预算 − 我方成本预算；
          结算利润 ＝ 甲方预算 − 实际成本。资金流水、应收应付均不参与利润计算，系统也不提供「现金结余」指标。
        </Paragraph>
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          忘记密码只能靠 3 个密保问题找回；密保也忘记时，只能删除数据库文件重新初始化（本地单机，无管理员可找）。
        </Paragraph>
      </Space>
    </Card>
  );
}

function DictPanel({ dictType }: { dictType: DictType }) {
  const { items, loading, reload, update, remove } = useDict(dictType);
  const [name, setName] = useState('');
  const [sortNo, setSortNo] = useState<number>(900);
  const [saving, setSaving] = useState(false);
  /** 正在编辑的字典项（名称 + 备注）；启用/排序不在这里改，仍留在表格行内 */
  const [editing, setEditing] = useState<DictItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editRemark, setEditRemark] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const add = useCallback(async () => {
    const value = name.trim();
    if (!value) {
      void message.warning('请输入名称');
      return;
    }
    setSaving(true);
    try {
      await dictApi.create({ dict_type: dictType, name: value, sort_no: sortNo });
      await reload();
      void message.success('已新增');
      setName('');
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSaving(false);
    }
  }, [name, sortNo, dictType, reload]);

  /** 打开「编辑」弹层：只改名称与备注（排序、启用仍在表格行内操作） */
  const openEdit = (row: DictItem) => {
    setEditing(row);
    setEditName(row.name);
    setEditRemark(row.remark ?? '');
  };

  const saveEdit = async () => {
    if (!editing) return;
    const value = editName.trim();
    if (!value) {
      void message.warning('名称不能为空');
      return;
    }
    setSavingEdit(true);
    try {
      await update(editing.id, { name: value, remark: editRemark.trim() });
      void message.success('已保存');
      setEditing(null);
    } catch {
      /* 拦截器已提示 */
    } finally {
      setSavingEdit(false);
    }
  };

  const columns: ColumnsType<DictItem> = [
    { title: '名称', dataIndex: 'name' },
    {
      title: '排序',
      dataIndex: 'sort_no',
      width: 110,
      align: 'right',
      render: (value: number, row) => (
        <InputNumber
          size="small"
          min={0}
          value={value}
          onChange={(next) => void update(row.id, { sort_no: next ?? 0 })}
          style={{ width: 80 }}
        />
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 90,
      render: (value: number, row) => (
        <Switch size="small" checked={value !== 0} onChange={(checked) => void update(row.id, { enabled: checked ? 1 : 0 })} />
      ),
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 150,
      render: (value: string) =>
        value ? (
          <Text style={{ maxWidth: 140, display: 'inline-block' }} ellipsis={{ tooltip: value }}>
            {value}
          </Text>
        ) : (
          '-'
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_: unknown, row) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              Modal.confirm({
                title: `删除「${row.name}」？`,
                content: '已被业务数据使用的名称只会置为「停用」，不影响历史记录。',
                okType: 'danger',
                onOk: async () => {
                  await remove(row.id);
                  void message.success('已处理');
                },
              });
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          placeholder={`新增${DICT_TYPE_LABEL[dictType]}名称`}
          value={name}
          style={{ width: 200 }}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => void add()}
        />
        <InputNumber
          min={0}
          value={sortNo}
          onChange={(value) => setSortNo(value ?? 900)}
          style={{ width: 140 }}
          addonBefore="排序"
        />
        <Button type="primary" icon={<PlusOutlined />} loading={saving} onClick={() => void add()}>
          新增
        </Button>
      </Space>
      <DataTable<DictItem>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={false}
        scroll={undefined}
        locale={{ emptyText: '暂无字典项' }}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        字典项被业务数据使用后，删除只会置为「停用」，不会影响历史记录。
      </Text>

      <Modal
        title={`编辑「${editing?.name ?? ''}」`}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={() => void saveEdit()}
        okText="保存"
        confirmLoading={savingEdit}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text type="secondary">名称</Text>
            <Input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder="请输入名称"
              onPressEnter={() => void saveEdit()}
              style={{ marginTop: 4 }}
            />
          </div>
          <div>
            <Text type="secondary">备注</Text>
            <Input.TextArea
              value={editRemark}
              onChange={(event) => setEditRemark(event.target.value)}
              placeholder="选填"
              rows={3}
              style={{ marginTop: 4 }}
            />
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            「排序」与「启用」不在这里改，直接在上面的表格行内操作。
          </Text>
        </Space>
      </Modal>
    </>
  );
}
