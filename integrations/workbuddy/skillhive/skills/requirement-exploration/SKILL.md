---
name: requirement-exploration
display_name: 需求探索
display_name_en: Requirement Exploration
description: 当员工想讨论、梳理、保存、继续或提交业务需求时，使用 SkillHive 需求探索工具。
description_zh: 帮助员工把模糊业务问题整理为可评审需求，并将草稿和正式提交保存到公司服务器。
description_en: Turn an employee's business problem into a reviewable requirement and save drafts and submissions to the company server.
allowed-tools: get_connector_status, start_exploration, list_my_explorations, get_exploration, save_exploration, submit_exploration, abandon_exploration, get_skill_file
version: 1.1.0
author: SkillHive
user-invocable: true
---

# 需求探索

当员工表达“探索需求、梳理问题、继续需求讨论、提交需求或查询评审结果”等意图时使用本技能。

开始前读取 @references/tool-contracts.md，按其中的稳定参数、回执和错误恢复约定调用工具。公司讨论规则仍以服务器为当前探索返回的锁定版本为准。

## 不可省略的边界

- 仅处理当前需求探索的结构化业务总结，不上传完整聊天记录，也不收集员工的其他对话。
- 管理员可以查看草稿和正式提交，但不能代员工修改、提交或放弃。
- “正式提交”表示进入公司需求池，不表示业务评审通过，也不表示完成正式签署。
- 不从员工自报姓名或 WorkBuddy 昵称推断身份；身份和归属只由员工专属令牌确定。

## 首次使用与开始

1. 首次连接或身份不确定时调用 `get_connector_status`。若令牌失效或写权限未启用，引导员工联系公司 SkillHive 管理员，不要求登录 SkillHive Web。
2. 新建探索时调用 `start_exploration`。
3. 继续历史探索时，先调用 `list_my_explorations` 定位，再用 `get_exploration` 读取 `activeRevision` / `activeContent` 和评审反馈。若员工此前放弃了正式提交后的未提交修改，有效内容会回到最近正式提交，不能把历史修订列表中的已放弃草稿当成当前内容。
4. `start_exploration` 或 `get_exploration` 返回的规则含资源清单时，只按其中的 `explorationId`、`rule.slug`、`rule.version` 和精确 `path` 调用 `get_skill_file`；不得省略探索编号，也不得改用通用 Skill 的最新版本。

## 讨论方法

讨论阶段以后端返回并锁定的应用 Skill 为唯一业务规则。按照其中的 Grill Me 决策树推进：每轮提出当前 frontier 中所有前置条件已明确且彼此不依赖的问题，不设置固定问题数量；员工回答后重新计算 frontier。当前 WorkBuddy 客户端支持原生 `AskUserQuestion` / `AskQuestion` 时，优先使用弹窗；互斥答案用单选，可同时成立的答案用多选。原生交互不可用、调用失败或需要自由描述时，降级为同一消息内的编号文本问答。交互形式不得改变完整 frontier，也不得替员工预选或提交答案。先理解问题，再讨论方案；员工不知道的数字、事实和约束放入 `pendingQuestions`，不得编造。

结构化草稿字段：

- `title`：1—128 字的简短标题。
- `problemDescription`、`targetUsers`、`currentProcess`：问题、受影响对象和当前流程。
- `painAndEvidence`：痛点列表；依据需标记为员工陈述或待验证。
- `objectivesAndBenefits`：目标和预期收益。
- `scope`、`nonGoals`：本次范围和非目标。
- `acceptanceCriteria`：可检查的验收条件。
- `constraintsAndRisks`、`pendingQuestions`：约束风险和待确认事项。
- `summary`：与上述字段一致的总结。

## 保存、提交与恢复

- 每完成一个有实质变化的阶段，调用 `save_exploration` 保存完整结构化快照；不要上传原始聊天记录。只有收到成功回执后才能说“草稿已保存”。
- `expectedRevision` 必须使用最近一次读取或保存返回的版本；发生冲突时重新调用 `get_exploration`，结合最新内容继续，绝不覆盖。
- 同一网络重试复用原 `idempotencyKey`；内容或操作变化时使用新键。
- 员工只说“先到这里”时保存草稿，不推断为正式提交。
- 只有员工明确确认最终总结并表达提交意图后，才调用 `submit_exploration`。服务端指出缺项时逐项补充，不能用空洞占位文本绕过。
- `abandon_exploration` 调用前必须再次确认员工意图。已有正式提交时，该操作只放弃未提交修改并保留正式快照。
- 服务不可用时不要反复写入或声称已保存。保留当前对话中的结构化总结，恢复后读取服务器最后修订再补交。

完成保存或提交后，用员工可理解的语言展示服务端返回的探索/需求编号、修订、提交时间和实际评审状态，不返回 SkillHive 管理端链接。
