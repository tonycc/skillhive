# 企业 Skill 助手工具契约

本文件描述企业 Skill 与应用的稳定发现、选择和读取方式。工具返回内容已经按当前员工身份、令牌状态和部门范围过滤。

## 发现工具

| 工具 | 入参 | 返回 | 使用时机 |
| --- | --- | --- | --- |
| `search_capabilities` | `query`：1—128 字员工原始任务或关键词 | 按匹配强度排序的普通 Skill 和应用；不包含应用内部 Skill | 已知任务或大致用途时优先使用 |
| `list_capabilities` | 无 | 当前员工可使用的普通 Skill 和应用；不包含应用内部 Skill | 员工明确要求浏览全部能力时使用 |
| `search_skills` | `query`：1—128 字关键词 | 匹配的普通 Skill | 员工明确要求只检索 Skill 时使用 |
| `list_skills` | 无 | 当前员工有权访问的全部已发布普通 Skill | 员工明确要求只浏览 Skill 时使用 |

服务端先按员工身份和部门范围过滤，再进行匹配。名称和管理员配置的触发词优先于最新发布版本标签，简介和分类只作兜底；普通 Skill 与应用分别维护触发词，应用 Skill 本身不配置也不参与检索。没有返回的对象不得通过猜测 slug 或应用标识访问。

## 路由字段

- `entryType: skill`：普通 Skill，使用 `get_skill` 加载。
- `entryType: application`：独立应用目录中的应用入口，使用 `entryTool` 和对应应用工具；不调用 `get_skill`。
- `applicationKey`：应用标识；普通 Skill 为 `null`。`requirement-exploration` 必须进入需求探索应用，关联规则不出现在普通 Skill 检索中。

需求探索应用使用 `get_connector_status`、`start_exploration`、`list_my_explorations`、`get_exploration`、`save_exploration`、`submit_exploration` 和 `abandon_exploration`。本助手只负责识别并进入该流程；实际参数、修订冲突、幂等和提交确认要求以应用入口、工具契约和锁定规则为准。

## 内容与资源工具

| 工具 | 入参 | 返回 | 约束 |
| --- | --- | --- | --- |
| `get_skill` | 精确 `slug` | 普通 Skill 最新发布版本的正文和资源清单 | 只读取 `entryType: skill` 的检索结果；应用 Skill 会被拒绝 |
| `list_skill_files` | 精确 `slug` | 当前 manifest 的版本和资源路径/大小 | 需要核对普通 Skill 资源清单时使用 |
| `get_skill_file` | `slug`、`version`、精确 `path`；需求探索规则另带 `explorationId` | 该版本的单个资源内容 | 普通 Skill 使用 manifest 版本；应用资源只能按应用返回的锁定版本读取 |

普通 Skill 的正文和资源必须来自同一版本。出现无权限、资源不存在或版本不一致时停止读取并向员工说明，不遍历路径、不绕过部门范围，也不改用其他员工身份。
