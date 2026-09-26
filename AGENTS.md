# AGENTS.md

给在本仓库里干活的人（和 Agent）的规则。**先说红线，再说事实。**

## 1. 不写兼容层

这条是硬规则，不接受折中。

- **不留旧版本**。被替代的代码直接删掉，不注释、不 `@deprecated` 标记、不「先留一版观察」。
- **不做向后兼容**。不认旧请求体、不认旧环境变量、不认旧配置字段、不认旧数据形状。
- **不写降级分支**。`if (oldShape) {...} else {...}` 里的 `oldShape` 分支就是下一个要删的东西，只是它躲进了 `else`。
- **不写迁移**。数据库只有一个 shape，改了就直接改 schema 定义（见 §4）。
- **不留「以后可能有用」的东西**。没被调用的导出、没被读的字段、没被走的分支，全删。

需要表达「换个部署环境怎么办」时写**条件句**，不要写成阶段规划：

```ts
// 对：描述当前约束
// 进程内锁。多副本部署前必须换成 DB lease。

// 错：写成一个不存在的第二版
// 当前是进程内锁，多副本阶段会升级成分布式锁。
```

改造一个入口时，**调用方一起改**。留下一个「兼容旧签名的重载」等于让新老两条路径同时存在，
而旧那条永远不会再被测试。

## 2. KISS

- 能用 10 行写完，就不要写 30 行。
- 不要为了「更通用」引入抽象层。第二个调用方出现时再抽。
- 不要引入新的运行时依赖，除非现有依赖真的做不到。
- 常量内联比配置项好；只出现一次的东西不要提成变量。
- 删代码优先于加代码。一个改动如果净增行数，先问能不能净减。

## 3. 项目事实

| 项 | 值 |
|---|---|
| 形态 | Vite + React 前端（`:5173`）+ Express 服务端（`:3001`），TypeScript |
| 数据库 | `node:sqlite`（Node 内置，**同步 API**） |
| 前端入口 | `src/` |
| 服务端入口 | `server/` |
| 生产构建 | `npm run build` → `dist/` + `dist-server/` |
| 本地数据 | `.data/`（sqlite + member home + workspace + copilot session state） |
| 默认团队 | `config/member-templates/<dir>/`（provisioning baseline） |
| 能力层 | `server/capabilities/`：Member 只引用 Provider ID + selector，实现可换 |

命令：

```bash
npm run dev        # 前后端一起起
npm run typecheck  # 三个 tsconfig 全查
npm test           # server/test/*.test.ts
npm run build      # 交付前必须跑
```

## 4. 数据库只有一个 shape

`server/db-migrations.ts` 里**只有一份** `SCHEMA_SQL`，没有版本链。

```
空库              → 建 SCHEMA_SQL
user_version 相等  → 什么都不做
其它              → 拒绝启动
```

改 schema 的流程：**直接改 `SCHEMA_SQL`，然后删掉本地库重建**（`rm -rf .data`）。
默认 Member 会在下次启动时重新 provision，不需要人工补数据。

不要新增 `migrateVxToVy()`。迁移代码只在升级那一瞬间被执行，是最不可能被日常测试覆盖的代码；
宁可在启动时明确报错，也不要维护一条没人验证的升级路径。

新增表时：

- 直接写在 `SCHEMA_SQL` 里，按最终形状写 `CREATE TABLE`，**不要**「建表 + 一串 `ALTER TABLE ADD COLUMN`」。
- 只有全新的库会走到这里，没有历史行需要照顾，所以列顺序可以按可读性排。
- 外键可以前向引用（SQLite 建表时不校验目标表是否存在），表顺序按可读性排即可。

## 5. 数据与配置

- **默认数据不进代码，也不进 migration**。新增默认 Member = 新增一个模板目录，不改 TypeScript。
- 模板目录是 **provisioning baseline，不是运行时 source of truth**。只读一次，已存在的（含已归档）一律跳过。
- Member 的身份判据是 `seed_key`，**不是** `handle` / `name` —— 后两个是用户随时会改的显示属性。
- 业务内容（角色定义、system prompt、初始记忆）只放 `config/member-templates/`。
  `server/*.ts` 只负责「怎么加载 Member」，不负责「谁是 Architect」。
- **能力引用只写 Provider ID**（`capability_binding`），不写实现。
  「换 KB 后端」= 注册一个新 Provider（或替换同 ID 的实现），不是改调用方。
- **能力是三层叠加**：`effective = global + team + member`，按 `providerId\0selector`
  去重、先出现的赢（global 是基线，member 是增量，member **不覆盖** global）。
  执行路径上唯一合法的读入口是 `CapabilityService.getEffective(teamId, memberId)` ——
  出现 `getMember(id)` 当「这个人能用什么」就是回退：global / team 两层会静默消失。
- **Member 模板只写这个人的增量**。把 global / team 的基线复制进每个人的私有层不是
  「多几行数据」，而是**静默的复制**：之后管理员改 Team 能力，这些人不变，而且没有
  任何地方看得出原因。基线放 `config/capability-templates/`。
- **只有 Member 层推进 `member.updated_at`**。global / team 层变化不能 touch 任何
  Member：否则改一次 Team 能力，所有 execution 快照里的 `memberRevision` 集体漂移，
  「这个人改过没有」从此答不出来。
- **`RuntimeTool.guard` 必须在 Policy 之前执行**（`CopilotCapabilityAdapter.evaluateToolUse`）。
  guard 是 Provider 对自己的输入边界的判定，Policy 是部署对风险等级的判定；前者说了不行
  就是不行。它放在适配器里而不是只依赖注入进来的 `ToolPolicy` —— 授权判定的第一道闸
  不该取决于「装配时传了哪个 policy 实现」。因此 guard **必须无副作用**：它可能被求值
  一次以上，而「检查两次」和「执行两次」是完全不同的后果。
- **`CopilotService` 不认识任何具体 Provider**。它只接受一份解析好的
  `RuntimeCapabilities`；`TeamService` 里也不允许出现直接读 `config.teamSkillRoot`
  或直接调某个 Knowledge 实现的路径 —— 有了旁路，`capabilityManifestHash`
  就不再反映这一轮真的用了什么。
- **skill 内容投放只有一个入口**（`server/skill-service.ts`），三个 scope 共用同一套
  安全闸：解压前校验条目（绝对路径 / `..` 穿越）、解压后体检（文件数 / 总字节数 /
  拒绝 symlink）、先解到暂存目录再 rename。只看「压缩包 ≤ 25MB」是不够的 —— 压缩比
  可以极高，而一个指向 workspace 之外的 symlink 会把宿主机文件带进运行环境。
- **工具授权不看工具名**。新工具只需要在 Provider 里声明 `risk` /
  `requiresHostAccess`，`tool-policy.ts` 不动。出现 `if (toolName === '...')`
  就是回退。
- **「部署开关」不能由 Member 的能力声明替代**。绑定 `runtime.host-coding-tools`
  只是「想要」；放行与否由 `DefaultToolPolicy` 看部署开关决定，两个判据各写各的。
- **「什么算一份可索引的资料」只写一处**。磁盘扫目录与 API 写文档共用
  `capabilities/providers/knowledge-document-limits.ts`；一边接受、一边拒绝是
  这类不一致最常见的形态。

## 6. 代码纪律

- TypeScript `strict` + `noUnusedLocals`。未使用的导入/变量是**错误**，不是警告。
- 注释用中文，**只描述当前实现与当前约束**。不写「第一版」「下一版」「暂时」「后续会」。
- 注释解释 **为什么**，不复述代码在做什么。写「为什么这里是 409 而不是 400」，不写「返回 409」。
- 空 catch 必须留一句 `console.warn` 或注释说明为什么可以吞。
- `node:sqlite` 是同步 API。事务用 `BEGIN` / `COMMIT` / `ROLLBACK` 手写，
  多语句写入必须包事务；返回值要在 COMMIT 之后才对外广播。
- 时间戳统一用 `new Date().toISOString()`。

## 7. 交付标准

一个改动算完成，必须同时满足：

1. `npm run typecheck` 全绿
2. `npm test` 全绿（新增行为要有对应断言）
3. `npm run build` 全绿
4. README / `.env.example` 里被这个改动影响的部分已经同步（新增的写上，删掉的删掉）
5. 改了别人的契约（HTTP 形状、环境变量、schema）时，调用方与文档一起改，不留过渡期

跨层不变量（schema 形状、ACL 判据、授权判据、幂等键、manifest 指纹）还要跑一次
**变异验证**：`python3 scripts/mutation-check.py` 把实现改回错误写法，确认对应断言
真的变红。没有区分度的断言要改断言，不是删断言。

跑服务验证时用真实 HTTP + 真实 SQLite，不要只跑单测就宣布完成。

### 测试节奏：全量只在收尾跑

`npm test` 是全量套件，跑一次要消耗大量时间和上下文。**开发过程中反复跑全量
不是「更严谨」，是把预算烧在重复确认没改过的地方。**

- **过程中**：只跑 `npm run typecheck`（秒级）＋ 受影响的**单个测试文件**：
  ```bash
  node --import tsx --test server/test/xxx.test.ts
  ```
- **收尾**（交付前最后一次）：跑一次完整 `npm test` + `npm run build`，通过即交付。
- 变异验证同理：只对本次改动对应的断言、只跑受影响的文件变红，不做全量变异循环。
- 中途确认某个断言的行为时，优先缩小到那一条测试，而不是指望全量绿给自己安全感——
  全量绿不能证明新逻辑对，只能证明没改坏旧的。
