# team-member-copilot-agent 项目约定

## Member 身份字段的分工（用户明确过，不要再"顺手合并"）

| 字段 | 给谁看 | 写什么 | 进 system prompt |
| --- | --- | --- | --- |
| `name` | 身份 / UI | 显示名 | 否 |
| `handle` | mention / routing | 唯一句柄 | 否 |
| `role` | UI / 路由 / Task assignment | 短职责标签 | 是 |
| `description` | 人 | 职责范围摘要 | **否** |
| `systemPrompt` | 模型 | 工作契约 | 是 |
| `model` | 运行时 | 模型选择 | 否 |

- `description` **是身份字段，要保留**：出现在 Member 列表 / Profile / picker /
  Task assignee selector / 搜索筛选。
- **它不是 Persona**，不写「你是一个严谨、友好、富有同理心的专家」。
- 唯一约束：不要被当成主要人格提示，也不要和 `systemPrompt` 重复写一大段。
- 真正该删的是「重复的人格字段」：`Personality` / `Style` / `Soul` / `Bio`。
- 曾把它误判为可删项，用户已纠正。防复发：DDL 注释、字段 doc 注释、
  MemberEditor 的 `extra`、README 表格四处都写了这条边界。

## Schema 纪律

- `SCHEMA_VERSION` 只有「空库才建」这一条路：`migrate()` 对 `from !== 0` 直接 throw，
  **没有升级代码**。所以版本号就是形状的唯一身份 —— 同版本号下增删列 = 改形状，不是清理。
- 删列的真实后果：`mapRow` 走 `SELECT *` 取到 `undefined` → 边界 `undefined.trim()`；
  INSERT/UPDATE 直接 `no such column`。

## 交付门（必须串行）

```
python3 scripts/mutation-check.py
npm run typecheck
npm test
npm run build
npm run smoke:boot
```

- 先 `unset CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR NODE_OPTIONS`。
- **变异脚本运行期间绝对不要并发跑 typecheck/test**：会读到变异中间态，
  表现为 TS6133 / TS2393 这类莫名错误，下一次读又是好的。
- 排查写入冲突：先比 `md5` 再比 mtime。
