import type { Member } from '../../lib/api';
import { ScopedSkillLibrary } from './ScopedSkillLibrary';

interface MemberSkillsProps {
  member: Member;
}

/**
 * Member 页签里的 skill 文件库。
 *
 * 只剩一层壳：内容投放的三个 scope 走同一个组件（见 `ScopedSkillLibrary`），
 * 这里只是把「当前这个 Member」翻译成 `scope="member"`。
 */
export function MemberSkills({ member }: MemberSkillsProps) {
  return <ScopedSkillLibrary scope="member" memberId={member.id} title="Member Skills" />;
}
