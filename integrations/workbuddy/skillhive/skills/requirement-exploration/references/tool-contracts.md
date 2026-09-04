# 需求探索工具契约

本文件只描述稳定的调用契约。讨论阶段、字段解释和公司规则以 `start_exploration` 或 `get_exploration` 返回的锁定规则为准。

## 读取工具

| 工具 | 入参 | 关键回执 | 使用时机 |
| --- | --- | --- | --- |
| `get_connector_status` | 可选 `protocolVersion`，当前入口传 `1.0` | 企业、员工、权限、激活规则和兼容信息 | 首次连接、身份或权限不确定时 |
| `list_my_explorations` | 可选 `state`、`keyword`；`page`、`pageSize` | 本人记录摘要和分页信息 | 找回记录；不要用它获取他人数据 |
| `get_exploration` | `explorationId`；可选正式提交序号 `submission` | 当前 `activeRevision` / `activeContent`、状态、锁定规则、正式提交及员工可见评审 | 继续、冲突恢复、确认保存或查询评审 |
| `get_skill_file` | `slug`、`version`、`path`；受管规则必须带 `explorationId` | 锁定版本中的单个资源内容 | 仅按开始/读取回执中的精确资源清单调用 |

## 写入工具

所有 `idempotencyKey` 均应使用 UUID。同一次网络重试必须复用原值；新的业务动作使用新值。

| 工具 | 入参 | 关键回执 | 调用约束 |
| --- | --- | --- | --- |
| `start_exploration` | 可选 `initialProblem`、`idempotencyKey`、`protocolVersion: "1.0"` | 探索 ID/编号、revision、锁定规则和资源清单 | 新建需求探索时调用 |
| `save_exploration` | `explorationId`、最近 `expectedRevision`、完整 `content`、`idempotencyKey` | 新 revision、保存时间和内容摘要 | 只保存结构化总结；回执成功后才能声称已保存 |
| `submit_exploration` | `explorationId`、最近 `expectedRevision`、`idempotencyKey` | 需求 ID/编号、提交修订、提交时间和评审状态 | 内容先保存；员工明确确认提交后调用 |
| `abandon_exploration` | `explorationId`、最近 `expectedRevision`、`idempotencyKey` | 探索状态、有效 revision、保留的正式提交版本 | 再次确认员工意图后调用 |

`save_exploration.content` 是完整快照，包含 `title`、`problemDescription`、`targetUsers`、`currentProcess`、`painAndEvidence`、`objectivesAndBenefits`、`scope`、`nonGoals`、`acceptanceCriteria`、`constraintsAndRisks`、`pendingQuestions` 和 `summary`。提交缺项以服务端返回为准，不得编造内容绕过校验。

## 错误与恢复

工具错误包含机器可读错误码、可读原因、`retryable` 和 `nextStep`。按以下方式恢复：

- `UNAUTHENTICATED`、`FORBIDDEN`：停止写入，引导员工联系公司管理员；不要要求登录 SkillHive Web。
- `NOT_FOUND`：核对本人记录编号；不要探测或暗示他人记录是否存在。
- `VALIDATION_ERROR`：逐项补充服务端指出的字段，不用占位文字伪造完整。
- `REVISION_CONFLICT`：重新调用 `get_exploration`，让员工确认如何基于最新内容继续。
- `RATE_LIMITED`、`TEMPORARILY_UNAVAILABLE`：遵循 `nextStep`；同一写操作重试时复用原幂等键，持续失败则停止循环重试。
- 超时或回执丢失：先以原幂等键重试或读取记录确认结果，不得立即创建重复探索或重复提交。
