import type { Request } from 'express';
import { isAdminAuthorized } from './apiScope.js';
import { isTeamAdmin } from './teamScope.js';

/**
 * Admin 面的统一判定：有效的 ADMIN_API_TOKEN，或当前 Team 里的 owner/admin 角色。
 *
 * 两个条件都成立才算数，是刻意的：token 用于服务间调用（没有 human actor），
 * Team role 用于界面上的人（没有 token）。任一即可，因为它们表达的是同一件事
 * ——「这个人有权改这一层的东西」。
 *
 * 之所以抽出来：skills 安装、knowledge 写文档、会话文件 promote 到知识库
 * 是同一类动作（改的是「别人也会用到的东西」）。各写一份的话，新增一个入口时
 * 很容易只想起 token 那一半，于是界面上就出现「点得动但总是 403」的按钮。
 */
export function canAdmin(req: Request): boolean {
  if (isAdminAuthorized(req)) return true;
  return isTeamAdmin(req, 'owner', 'admin');
}
