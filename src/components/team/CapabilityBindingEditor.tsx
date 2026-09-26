import { Button, Input, Select, Space, Tag } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { CapabilityBinding, CapabilityProvider, MemberCapabilities } from '../../lib/api';

/** 能力的三个类别 —— 就是 `MemberCapabilities` 的三个数组字段名。 */
type CapabilityKind = keyof MemberCapabilities;

/**
 * 字段名（复数）→ Provider 的 kind（单数）。
 *
 * 刻意写成 switch 而不是 `kind.slice(0, -1)`：后者对 `skills` 恰好成立，
 * 但它是「字符串刚好差一个 s」的巧合，不是规则。加第四个类别时会静默算错
 * （`entries` → `entrie`），而这里会变成编译错误。
 */
function providerKind(kind: CapabilityKind): CapabilityProvider['kind'] {
  switch (kind) {
    case 'skills':
      return 'skill';
    case 'knowledge':
      return 'knowledge';
    case 'tools':
      return 'tool';
  }
}

interface Props {
  kind: CapabilityKind;
  value: CapabilityBinding[];
  providers: CapabilityProvider[];
  onChange: (value: CapabilityBinding[]) => void;
}

/**
 * 一层能力声明的编辑器：一行一条 binding（providerId + 可选 selector）。
 *
 * 只负责「这一层写了什么」，不知道自己在 global / team / member 哪一层 ——
 * 三层的编辑体验是同一件事，层与层的差别由调用方（`CapabilitySettings`）决定。
 *
 * 下拉选项来自平台注册表，不是硬编码的 provider id：写死的列表会在换实现时
 * 悄悄过期，而界面是唯一会让人发现「这个 id 已经不存在了」的地方。
 */
export function CapabilityBindingEditor({ kind, value, providers, onChange }: Props) {
  const options = providers
    .filter((item) => item.kind === providerKind(kind))
    .map((item) => ({ value: item.id, label: item.id }));

  function update(index: number, patch: Partial<CapabilityBinding>) {
    onChange(value.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
  }

  function add() {
    // 挑第一个**这一层还没绑过**的 Provider。
    //
    // 直接取 options[0] 的话，第二次点 Add 会造出一条重复声明 —— 而重复声明在
    // effective 里什么都不改变（同层同键会被去重）。用户会以为自己加了东西，
    // 实际没有，然后去找「为什么没生效」。
    const used = new Set(value.map((item) => item.providerId));
    const provider = options.find((option) => !used.has(option.value))?.value ?? options[0]?.value;
    if (!provider) return;
    onChange([...value, { providerId: provider }]);
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="small">
      {value.map((binding, index) => (
        <Space
          key={`${binding.providerId}-${binding.selector ?? ''}-${index}`}
          style={{ width: '100%' }}
          align="start"
        >
          <Select
            style={{ minWidth: 240 }}
            value={binding.providerId}
            options={options}
            onChange={(providerId) => update(index, { providerId })}
          />

          {/*
            tools 的 selector 是罕见情况（多数工具没有选择子），所以只在
            「已经有了」或「本来就不是 tools」时显示输入框 —— 否则每一行工具
            都挂一个永远用不上的空输入框。
          */}
          {binding.selector !== undefined || kind !== 'tools' ? (
            <Input
              style={{ flex: 1, minWidth: 180 }}
              value={binding.selector ?? ''}
              placeholder={kind === 'knowledge' ? 'selector / KB key' : 'selector (optional)'}
              onChange={(event) => update(index, { selector: event.target.value || undefined })}
            />
          ) : null}

          <Button danger icon={<DeleteOutlined />} onClick={() => remove(index)} />
        </Space>
      ))}

      <Button type="dashed" icon={<PlusOutlined />} onClick={add} disabled={options.length === 0}>
        Add
      </Button>

      {value.length > 0 ? (
        <div>
          {value.map((binding) => (
            <Tag key={`${binding.providerId}#${binding.selector ?? ''}`} style={{ marginBottom: 4 }}>
              {binding.providerId}
              {binding.selector ? ` · ${binding.selector}` : ''}
            </Tag>
          ))}
        </div>
      ) : null}
    </Space>
  );
}
