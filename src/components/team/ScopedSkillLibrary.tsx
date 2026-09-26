import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, List, Space, Spin, Upload } from 'antd';
import { DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import { api, type MemberSkill, type SkillScope } from '../../lib/api';

interface Props {
  scope: SkillScope;
  memberId?: string;
  title?: string;
}

/**
 * 某个 scope 的 skill 文件库（内容投放）。
 *
 * 三个 scope 的**操作**完全一样，区别只有落盘位置：
 *
 *   global  `.data/global/skills/`
 *   team    `.data/team/skills/<teamId>/`
 *   member  `.data/members/<memberId>/skills/`
 *
 * 所以这里只留一个组件、一个 `scope` 参数，而不是三份复制粘贴的实现。
 *
 * 它回答「磁盘上装了哪些 skill」，启用关系归能力目录（`CapabilitySettings`）：
 * 那边勾选了这里装的东西，Agent 才能用。两者混在一起时，界面上会出现
 * 「装了一个 skill 却不知道谁在用它」。
 */
export function ScopedSkillLibrary({ scope, memberId, title }: Props) {
  const [skills, setSkills] = useState<MemberSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listScopedSkills(scope, memberId);
      setSkills(result.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.uploadScopedSkill(scope, file, memberId);
      // 同名覆盖：列表里那一条换成新的，而不是出现两行同名 skill
      setSkills((current) => [
        ...current.filter((item) => item.name !== result.skill.name),
        result.skill,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    return false;
  }

  async function remove(name: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteScopedSkill(scope, name, memberId);
      setSkills(result.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {title ? <strong>{title}</strong> : null}

      {loading ? (
        <Spin size="small" tip="Loading skills…" />
      ) : (
        <List
          size="small"
          dataSource={skills}
          locale={{ emptyText: 'No skills installed.' }}
          renderItem={(skill) => (
            <List.Item
              actions={[
                <Button
                  key="remove"
                  danger
                  size="small"
                  icon={<DeleteOutlined />}
                  disabled={busy}
                  onClick={() => void remove(skill.name)}
                >
                  Remove
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={skill.name}
                description={`${skill.description || '(no description)'} · ${skill.fileCount} files`}
              />
            </List.Item>
          )}
        />
      )}

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Upload
        accept=".zip,application/zip"
        showUploadList={false}
        disabled={busy}
        beforeUpload={(file) => {
          void upload(file);
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={busy}>
          Upload skill zip
        </Button>
      </Upload>
    </Space>
  );
}
