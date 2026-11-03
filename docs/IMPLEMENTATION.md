# 0.1.0 实现与验证记录

2026-10-23 起持续更新。项目 `/home/tapdatacli`。需求快照来自 `/home/tapdata-ai-cli`，原始设计中的“拟支持”不能等同于这里的已实现能力。

## 已实现

- TypeScript / Node.js CLI，原始命令、交互斜杠命令、AI 提案共用命令处理。
- 首次启动绑定向导；Codex CLI、Claude CLI、自定义 Chat Completions API 的命名绑定、切换、模型 ID 设置和原生入口。
- 命令帮助、中文输入、历史、Tab 命令补全、显式多行输入，非 TTY 纯 JSON 输出。
- REPL 补全支持连接名、任务名、已加载表名和常用选项；提示符可见连接/表数量，启动时展示数据库工作区常用操作。
- 数据源状态、模型发现、表结构和样例以中文标签与紧凑列展示，减少常见数据库浏览结果的原始 JSON 噪音。
- AI 每轮获得命令参考和真实工作区摘要，返回经过校验的参数数组；主程序执行后将实际结果反馈给模型。最多 8 步，保留多轮上下文。未执行成功不能宣称成功。
- Java 17 子进程按需启动、握手、同一会话复用，JSON-RPC 控制通信；日志分离；超时、进程退出和操作失败使用非成功结果。
- PDK JAR 及依赖缓存，读取真实注解 / spec、基础能力注册、连接器版本固定、update、引用保护、unload、校验和检查。
- 数据源 create / modify / drop / list / test / load / describe / sample，JSON + key=value + ENV 引用，配置加密、基础脱敏、模型失效标记。
- 单表全量 CSV 任务 create / list / describe / start / status / stop / drop。交互期间后台运行，进度通知和取消最终状态；导出数据仅在 Java 内流动。
- 内存 PDK state map，元数据填充 tableMap，finally stop 和类加载器清理。持久化的是产品配置和任务摘要，不是连接器运行位点。
- npm 安装包与可解压运行包，运行时无 npm 第三方依赖。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| TypeScript 编译 / Maven 编译和打包 | 通过 |
| npm tgz 全局安装，直接运行 tapdatacli doctor | 通过，Java 17.0.19 握手成功 |
| tar.gz 解压后无 node_modules 独立运行 | 通过，真实装载 JAR 并采样中文记录 |
| 终端向导、跳过绑定、中文连接名和样例表格 | 通过，本机 PTY 实测 |
| 独立 local-json PDK JAR → 连接测试 → 模型发现 → 有限采样 | 通过，真实文件数据 |
| 三条中文客户记录导出 CSV，排除 phone | 通过，检查文件内容 |
| 已有输出保护、配置修改后 stale、失败 test 非零退出码 | 通过 |
| 取消活动导出后的最终 cancelled | 通过 |
| JAR update 保留原连接绑定，多个版本消歧 | 通过 |
| API Agent 命令执行 / 实际结果反馈 | 通过，本地测试 HTTP 服务 |
| Codex CLI 真实登录会话自然语言操作 | 通过；真实执行 connector list 并按实际空列表回答 |
| 本地现有 MySQL PDK JAR 装载和能力注册 | 通过；识别 mysql、MysqlConnector、1.0-SNAPSHOT、读写能力与真实配置 schema |
| MySQL 实际连接 / 数据读取 | 未执行；未使用现有环境数据库凭据 |
| Claude CLI 真实自然语言会话 | 未验证；本机 CLI 存在但未登录 |
| DeepSeek / 外部中转站真实 API 请求 | 未验证；未提供 API Key |

MySQL 检查制品为 `/home/tapdata-connectors/connectors/mysql-connector/target/mysql-connector-v1.0-SNAPSHOT-202610210835.jar`。未修改该仓库或制品。仅装载检查不证明真实数据库连接、查询或导出兼容。

## 原型边界与下一轮

尚未实现完整 TUI、token 流式展示、CLI 模型自动发现、跨 provider 原生历史恢复、完整 PDK 动态表单、元数据分页、CDC、库到库写入、任务修改、断点恢复、常驻 daemon、完整 Maven 传递依赖解析、随包 JRE。当前单工作区一个 CLI 会话，JVM 的连接器调用串行，AI 和本地任务状态查询可继续进行，其他连接器请求可能排队。

本地文件连接器用于小文件端到端演示，读取文件时会在内存中解析，不用于证明大数据量流式文件处理性能。外部连接器的依赖隔离和运行能力应逐个验证；首版共享 PDK 和父类加载器依赖。

设计来源代码：`tapdata` revision `683974ba05` 的 tapdata-test；`tapdata-common-lib` revision `cb74cd8` 的 PDK 接口。构建依赖使用本机当前 Maven 可解析的 PDK SNAPSHOT，未来发行应固定经过认证的正式版本。

接入依据：[Codex non-interactive](https://developers.openai.com/codex/noninteractive)、[Claude headless](https://code.claude.com/docs/en/headless)。

最终测试：`npm test`，11 项测试全部通过（含多个端到端检查及 Codex / Claude / API 协议回归）。发行产物为项目根目录 `tapdatacli-0.1.0.tgz` 与 `tapdatacli-0.1.0.tar.gz`，各约 13 MB。当前环境已安装全局命令，并在 `/usr/local/bin/tapdatacli` 提供 PATH 入口。默认工作区未预填测试连接或 AI 绑定，首次运行仍展示向导。


## 自然语言协议修复（2026-10-23）

用户报告提供连接器目录后出现 `Unexpected token`：AI 返回了中文回复，宿主直接按 JSON 解析。现已将 CLI stdin 改为明确的宿主协议加对话数据，并把响应协议写入受管上下文文件。API、Codex、Claude 的命令提案均经过 JSON 和结构校验；不合规回复会请求纠正一次，连续失败显示可读错误，未校验回复不会执行。纠正仅重新请求当前提案，已执行步骤不会重放。子进程等待 close 后读取最终输出。

新增 `/connector discover --dir DIR`，列出指定目录的普通 JAR 文件及绝对路径，不递归、不装载，最多返回 200 项并标记截断。AI 上下文要求先扫描用户提供的目录，再使用实际路径；没有目标连接器时说明缺失，不能替换为其他数据库连接器。扫描文件名不等同于验证 PDK 身份。

新增 7 项测试，覆盖三类 provider 返回中文后的纠正、连续不合规回复不执行、目录扫描上限和不装载制品。原 4 项集成测试继续通过。Claude / API 的此项验证使用本地模拟服务或进程，未扩展为真实登录或外部 API 验证。

真实 Codex 多轮验证通过（退出码 0）：第一轮缺少路径时询问 JAR 或目录；第二轮提供 `/home/tapdata-connectors/connectors/dist` 后，执行 `connector discover`，按实际结果说明只有 CSV 和 MySQL、没有 PostgreSQL，未错误装载其他连接器。全局安装后的目录扫描与 Java 17 引擎 doctor 也通过。

## 本地开发命令与编译支持（2026-10-23）

原先 AI 的提示词和校验器只允许 connector/datasource/task，导致明确的编译请求被拒绝。新增跨 provider 共用的宿主命令 `local exec --cwd DIR --argv JSON_ARRAY [--timeout SECONDS]`，并补充上下文、帮助和 REPL 取消行为。程序以参数数组启动，默认 shell:false，继承当前用户权限与环境，不提供本地执行沙箱。提示词限定用户请求的范围，并把读取的文件和日志视作不可信数据。

执行结果包含真实退出码、状态、stdout/stderr 尾部（各 12000 字符）、截断标志和完整日志路径。终端输出限量进度；日志使用 0600 权限。默认 1800 秒超时，可配置 1..7200 秒。取消和退出会发送 SIGTERM，2 秒后必要时 SIGKILL；POSIX 对进程组生效，退出等待清理结束。Windows 当前只终止直接子进程。交互历史排除 local 命令参数。AI provider 失败时返回私有诊断日志路径，明确已完成的命令仍然保留。

验证记录：

- 原 11 项测试加 8 项新测试，共 19 项，覆盖参数保真（含中文、空格、shell 元字符）、输出截断与完整日志、非零退出码、参数校验、缺失程序、超时、取消、退出时强制终止忽略 SIGTERM 的进程，以及三类 provider 的“本地构建 → discover”闭环。三类 provider 回归使用本地模拟进程/服务。
- 真实 PostgreSQL 模块及其依赖经本 CLI 的 local exec 编译成功：`mvn -B -pl connectors/postgres-connector -am package -Dmaven.test.skip=true`。首次离线构建因 Maven 缓存依赖不足失败，联网重试后 12 个模块 SUCCESS。没有执行全部连接器的全量构建，也未修改连接器源码。
- 再次 discover 返回 `/home/tapdata-connectors/connectors/dist/postgres-connector-v1.0-SNAPSHOT-202610230303.jar`（约 51 MB）。完整成功日志：`/tmp/tapdatacli-build-validation/logs/local-63075387-a910-49a8-9693-1f7180fec4f1.log`。本次未装载此 JAR、未进行 PostgreSQL 数据库连接验证。
- 真实 Codex 已通过宿主执行 `npm run build:ts`（退出码 0）并扫描 dist；该次最终总结请求 provider 退出码 1，未重复执行已完成操作。独立重试通过完整的“执行 node --version → 扫描 dist → 总结”链路（退出码 0），确认 Node v23.1.0 及真实 Postgres 制品。没有把该重试描述为 Maven 自然语言端到端验证。
- 全局安装入口的 `local exec --json` 已验证，JSON stdout 未混入子进程输出。安装包和解压包重新生成。


## Nexus 自动下载（2026-11-01）

新增 `src/nexus.ts` 与 `connector search / download`；`connector load NAME` 和无 `--jar` 的 `connector update REF` 复用下载及现有 Java inspect 流程。AI 上下文说明按名称加载的能力。默认查询 `io.tapdata` 的 `maven-releases`，由 Nexus Maven 排序确定最新版本，可指定版本和仓库，分页读取结果，过滤 sources/javadoc 等 classifier。

流式下载、SHA-256 和大小校验、按内容缓存和损坏恢复、临时文件清理、取消、超时及 512 MiB 限制已实现。服务和认证通过环境变量配置，拒绝远端明文 HTTP、重定向和跨源制品 URL，保留 TLS 验证。下载成功与 Java 装载成功分别报告；下载不会创建连接器注册记录。

验证包括真实 local-json PDK JAR 经本地 Nexus HTTP fixture 下载 → Java inspect → datasource test，以及 API 自然语言循环的真实命令结果反馈。远端查询实查成功，但目前 Nexus 的目标连接器未发布，不能声明远端 Postgres 下载或数据库连接成功。普通瘦 JAR 的 Maven 传递依赖解析、BOM 兼容性选择暂未实现。

## 交互体验增量（2026-11-03）

REPL 提示增加连接数和已加载表数。Tab 补全除命令外，也提供数据源、任务、连接器引用、表名与常见选项；启动提示展示连接器、数据源、表结构、样例和导出任务等工作区入口。数据源列表/详情、模型发现、表结构和样例使用可扫读的列与状态标签。

本轮仅运行 `npm run build:ts`，TypeScript 编译通过；未运行测试套件，也未做 PTY 人工输入法体验验收。当前仍为 readline 原型，完整多面板 TUI、持续显示的下拉建议及稳定的终端缩放布局尚未实现。
