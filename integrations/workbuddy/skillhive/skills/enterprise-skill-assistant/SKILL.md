---
name: enterprise-skill-assistant
display_name: 企业 Skill 助手
display_name_en: Enterprise Skill Assistant
description: 当员工想查找、选择或使用公司提供的普通 Skill 或应用，或提出可能由企业能力处理的工作任务时使用。
description_zh: 根据员工当前任务统一检索其有权使用的普通 Skill 和应用；不检索应用内部 Skill。
description_en: Find employee-accessible enterprise skills and applications for the current task, then load the selected entry's effective instructions.
allowed-tools: search_capabilities, list_capabilities, search_skills, list_skills, get_skill, list_skill_files, get_skill_file, get_connector_status, start_exploration, list_my_explorations, get_exploration, save_exploration, submit_exploration, abandon_exploration
version: 1.2.0
author: SkillHive
user-invocable: true
---

# 企业 Skill 助手

当员工想查找、选择或使用公司发布的 Skill，或者提出一个可能已有企业能力支持的工作任务时，使用本助手。

开始前读取 @references/tool-contracts.md，按其中的检索、选择、版本和资源读取约定调用工具。

## 发现与选择

1. 员工明确要求查看全部可用能力时调用 `list_capabilities`；其他情况优先从员工原话提炼简短关键词并调用 `search_capabilities`。这两个工具统一返回普通 Skill 和应用，但不返回应用内部 Skill。
2. 员工明确要求只查看普通 Skill 时，可以使用 `list_skills` 或 `search_skills`；这两个工具永远不返回应用及应用 Skill。
3. 结果只有一个且与意图清晰匹配时可以直接加载；有多个合理候选时，最多展示三个候选的名称和简介，让员工选择，不根据名称臆测 Skill 正文。
4. 没有匹配项时如实说明。可以换用更接近名称、简介、分类、标签或应用关键词的查询再搜索一次，但不要循环尝试或编造标识。
5. 只使用工具返回的、当前员工可见的结果；不得尝试猜测或读取未返回的 Skill 或应用。

## 普通 Skill 与应用路由

检索结果包含 `entryType` 和 `applicationKey`：

- `entryType: skill`：这是普通 Skill。调用 `get_skill` 获取当前发布版本的正文和资源清单，再按该版本执行。
- `entryType: application`：这是独立应用目录返回的应用入口。按照结果中的 `entryTool` 和应用工具进入流程；不要调用 `get_skill` 读取应用内部 Skill。
- `applicationKey: requirement-exploration`：使用需求探索应用流程。必须经过 `start_exploration` 或 `get_exploration` 锁定规则版本，不能搜索、直接读取或执行需求探索应用 Skill。

员工明确选择连接器中的“需求探索”快捷入口时可直接使用该入口；从本助手检索到需求探索时，最终进入的是同一个需求探索应用。

进入需求探索后，首次检查使用 `get_connector_status`，新建使用 `start_exploration`，继续历史记录使用 `list_my_explorations` 和 `get_exploration`，阶段成果使用 `save_exploration`，员工明确确认后使用 `submit_exploration`，明确放弃时才使用 `abandon_exploration`。所有参数、版本锁定和确认边界以应用目录返回的入口、MCP 工具契约及服务端锁定规则为准。

## 加载普通 Skill

1. 使用结果返回的精确 slug 调用 `get_skill`，不要自行拼写标识。
2. 以 `get_skill` 返回的正文、版本和资源清单为准。正文要求读取参考资料时，可先调用 `list_skill_files` 核对清单，再调用 `get_skill_file`。
3. 调用 `get_skill_file` 时必须原样传递 manifest 中的 `slug`、`version` 和 `path`；版本发生变化时重新读取 `get_skill`，不要混用不同版本的正文和资源。
4. 资源不存在、无权限或版本不一致时停止使用该资源并说明原因，不尝试遍历路径。

加载 Skill 只表示取得公司发布的工作方法，不自动授权外部写入、发送消息、审批、删除数据或其他高影响操作。仍应依据员工当前请求和工具确认要求执行。
