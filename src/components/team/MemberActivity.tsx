import { useEffect, useState } from 'react';
import { Collapse, Spin, Typography } from 'antd';
import { api, type Conversation, type Member, type Team } from '../../lib/api';

/**
 * Member 视角的动态：参与过哪些 conversation、在哪些 Team 里。
 *
 * 不建新表 —— 两条都是现成 roster / membership 的 join，
 * 这里只读、只展示最近 8 条。
 */
export function MemberActivity({ member }: { member: Member }) {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConversations(null);
    setTeams(null);
    void Promise.all([api.listMemberConversations(member.id), api.listMemberTeams(member.id)])
      .then(([c, t]) => {
        if (cancelled) return;
        setConversations(c.conversations);
        setTeams(t.teams);
      })
      .catch(() => {
        if (!cancelled) {
          setConversations([]);
          setTeams([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [member.id]);

  if (conversations === null || teams === null) return <Spin size="small" tip="Loading activity…" />;

  const teamName = new Map(teams.map((team) => [team.id, team.name]));
  const recent = conversations.slice(0, 8);

  return (
    <Collapse
      ghost
      items={[
        {
          key: 'activity',
          label: `Recent activity (${conversations.length})`,
          children:
            recent.length === 0 ? (
              <Typography.Text type="secondary">还没有参与过任何会话。</Typography.Text>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {recent.map((conversation) => (
                  <div key={conversation.id}>
                    <Typography.Text strong ellipsis style={{ display: 'block' }}>
                      {conversation.title}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {teamName.get(conversation.teamId) ?? 'Team'} · {conversation.kind} ·{' '}
                      {new Date(conversation.updatedAt).toLocaleString()}
                    </Typography.Text>
                  </div>
                ))}
              </div>
            ),
        },
      ]}
    />
  );
}
