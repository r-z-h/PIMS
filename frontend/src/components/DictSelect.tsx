import { useState } from 'react';
import { AutoComplete, Button, Form, Input, Modal, Select, Space, Tooltip, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { SelectProps } from 'antd';
import { useDict } from '../hooks/useDict';
import type { DictType } from '../types';

export interface DictSelectProps extends Omit<SelectProps<string>, 'options'> {
  dictType: DictType;
  /** 是否允许现场新增（杂费小类 / 材料 / 单位均允许） */
  allowAdd?: boolean;
  addLabel?: string;
  /**
   * `strict`（默认）：只能从字典里选。适合「材料 / 单位 / 杂费小类」这类统计维度，
   * 保证口径统一，不会因为手滑打字产生两个"水泥"。
   *
   * `free`：可以直接输入任意值，同时补全已有字典。适合「对方」这类人名字段
   * （需求第 6 条：给工人个人结工资时不该被迫先把他加进字典）。
   */
  inputMode?: 'strict' | 'free';
}

/**
 * 字典输入控件：杂费小类 / 材料 / 单位 / 对方。
 * - 严格模式：下拉选择，可现场「+ 新增」字典项
 * - 自由模式：输入框 + 已有字典补全，输入的值不自动写进字典（避免字典被人名淹没）
 */
export function DictSelect({
  dictType,
  allowAdd = true,
  addLabel = '新增',
  placeholder = '请选择',
  inputMode = 'strict',
  ...rest
}: DictSelectProps) {
  const { options, loading, create } = useDict(dictType);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const value = name.trim();
    if (!value) {
      void message.warning('请输入名称');
      return;
    }
    setSaving(true);
    try {
      await create(value);
      void message.success('已新增');
      setAdding(false);
      setName('');
    } finally {
      setSaving(false);
    }
  };

  const addButton = allowAdd && rest.disabled !== true && (
    <>
      <Tooltip title={`${addLabel}字典项`}>
        <Button icon={<PlusOutlined />} onClick={() => setAdding(true)} />
      </Tooltip>
      <Modal
        title={`${addLabel}`}
        open={adding}
        onCancel={() => setAdding(false)}
        onOk={submit}
        confirmLoading={saving}
        destroyOnClose
        width={360}
      >
        <Form layout="vertical">
          <Form.Item label="名称" required>
            <Input
              value={name}
              autoFocus
              placeholder="例如：伙食费 / 吨 / 水泥"
              onChange={(e) => setName(e.target.value)}
              onPressEnter={submit}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );

  if (inputMode === 'free') {
    return (
      <Space.Compact style={{ width: '100%' }}>
        <AutoComplete
          {...rest}
          style={{ width: '100%', ...rest.style }}
          options={options}
          placeholder={placeholder}
          filterOption={(input, option) =>
            String(option?.label ?? option?.value ?? '')
              .toLowerCase()
              .includes(input.toLowerCase())
          }
        />
        {addButton}
      </Space.Compact>
    );
  }

  return (
    <Space.Compact style={{ width: '100%' }}>
      <Select<string>
        {...rest}
        style={{ width: '100%', ...rest.style }}
        showSearch
        allowClear
        loading={loading}
        placeholder={placeholder}
        optionFilterProp="label"
        options={options}
        notFoundContent={loading ? '加载中…' : '暂无字典项'}
      />
      {addButton}
    </Space.Compact>
  );
}

export default DictSelect;
