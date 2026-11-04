# Tapdata CLI · 最小原型 0.1.0

独立的 TypeScript CLI + Java 17 Mini Engine，直接装载 PDK 连接器 JAR，不依赖 TM、Web、MCP 或平台中间库。引擎实现参考 `tapdata/tapdata-test`，并补充了元数据发现、文件导出、取消和资源释放。

## 构建和运行

需要 Node.js 22+、JDK 17+ 和 Maven 3.9+。源码构建需要能解析 Tapdata 的 Maven SNAPSHOT 依赖；本机已完成构建。运行发行包只需要 Node.js 22+ 和 Java 17+，不需要 Maven 或 npm 依赖。

```bash
cd /home/tapdatacli
npm ci
npm run build
./bin/tapdatacli.mjs
```

打包和安装：

```bash
npm run package                 # tapdatacli-0.1.0.tgz
npm install -g ./tapdatacli-0.1.0.tgz
tapdatacli                      # 首次启动向导
npm run bundle                  # 可直接解压的 tapdatacli-0.1.0.tar.gz
```

解压包中的 `bin/tapdatacli.mjs` 可直接执行。暂未随包分发 Node/JRE。指定 Java 路径使用 `TAPDATACLI_JAVA=/path/to/java`。开发环境已缓存依赖时可 `MAVEN_OFFLINE=1 npm run build`。

## 从 Nexus 自动下载连接器

按名称加载时，CLI 自动从 `https://nexus.tapdata.net/maven-releases` 的 Maven 仓库目录查询 `io.tapdata` 下的连接器，下载主 JAR、校验仓库提供的 SHA-256，再交给 Java 引擎检查并装载。无需 Maven，也无需事先准备本地路径。这里使用实际提供制品的 Maven 布局索引；Nexus REST 搜索 API 对部分已发布制品会返回空结果。

```bash
tapdatacli connector search                 # 查看已发布的连接器和版本
tapdatacli connector search postgres
tapdatacli connector load postgres          # Nexus Maven 版本排序中的最新版本
tapdatacli connector load postgres --version 1.0.0
tapdatacli connector download postgres      # 仅下载，不装载
tapdatacli connector load postgres --repository maven-snapshots
tapdatacli connector update CONNECTOR_ID --version 1.1.0
```

版本号仅为用法示例，应以 `connector search` 返回的实际版本为准。交互模式可输入 `/connector load postgres`，或绑定 AI 后说“帮我加载 postgres 连接器”。`postgresql`、`pg` 映射为 `postgres-connector`，也可直接使用完整 artifactId。默认不自动选择 SNAPSHOT；需要时显式指定仓库。

下载缓存在工作区 `downloads/<sha256>/connector.jar`，再次加载同一制品时校验缓存后复用（仍需联网查询版本及校验信息）；缓存损坏时重新下载。使用临时文件和原子改名，失败或取消清理本次下载。只选择无 classifier 的主 JAR，拒绝缺少 SHA-256、跨源下载地址及重定向，单个制品上限 512 MiB。Ctrl+C 可以取消查询或下载。加载后的依赖隔离和 datasource 版本固定规则沿用本地 JAR 流程。

环境变量配置：

| 变量 | 用途 |
| --- | --- |
| `TAPDATACLI_NEXUS_URL` | Maven 仓库服务地址，默认 `https://nexus.tapdata.net`；程序按 `/<repository>/io/tapdata/` 读取仓库目录 |
| `TAPDATACLI_NEXUS_REPOSITORY` | 默认 hosted 仓库，默认 `maven-releases`；命令参数优先 |
| `TAPDATACLI_NEXUS_TOKEN` | 可选 Bearer token，只从环境变量读取 |
| `TAPDATACLI_NEXUS_USER` / `TAPDATACLI_NEXUS_PASSWORD` | 可选 Basic 认证；token 优先 |
| `NODE_EXTRA_CA_CERTS` | 启动前指定可信私有 CA PEM 文件，保留 TLS 校验 |

2026-11-01 实查：Nexus 查询接口可用，但 `maven-releases` 中尚未查到 `io.tapdata:postgres-connector` 等连接器主 JAR；Postgres 在 `maven-snapshots` 中也未查到。没有发布的连接器会明确报错，需先发布，或继续使用 `connector load --jar PATH`。本功能不自动编译或发布连接器，也不解析普通瘦 JAR 的 Maven 传递依赖；远端制品应为包含所需依赖的连接器分发 JAR。真实外部数据库连接仍需单独验证。

## 无需数据库的真实 PDK 示例

随包提供一个独立 `local-json-connector.jar`，读取 JSON 文件中的表和记录，通过 PDK `connectionTest / discoverSchema / batchRead` 接口执行。它不是 MySQL 的模拟器，也不代表所有数据库连接器都已验证。

```bash
cd /home/tapdatacli
tapdatacli init
tapdatacli connector load --jar ./runtime/local-json-connector.jar
tapdatacli datasource create demo --pdk-id local-json --set "path=$PWD/examples/customers.json"
tapdatacli datasource test demo
tapdatacli datasource capabilities demo
tapdatacli datasource load demo
tapdatacli datasource describe demo --table customers
tapdatacli datasource sample demo --table customers --limit 2
tapdatacli datasource page demo --table customers --limit 2
tapdatacli datasource count demo --table customers
tapdatacli datasource query demo --table customers --filter '{"match":{"status":"active"}}' --sort '[{"key":"created_at","sort":"desc"}]' --limit 20 --fields id,name,status
tapdatacli datasource sql demo --type query --sql 'SELECT id,name FROM customers LIMIT 20' --yes
tapdatacli datasource command demo --command 'show databases' --params '{}' --yes
tapdatacli task create export-customers --source demo --table customers --output /tmp/customers.csv --exclude phone
tapdatacli task start export-customers
```

输出为真实的三行中文客户数据，CSV 不含 phone。目标文件或同名 `.partial` 已存在会返回错误，选择新路径重试。失败或取消时可能保留 `.partial`，不自动续传或覆盖。

`datasource page` 按连接器返回顺序读取最多 100 行；若返回游标，可在同一个交互会话继续下一页：

```text
/datasource page demo --table customers --limit 20
/datasource page demo --table customers --limit 20 --cursor <上次结果中的游标>
```

游标保存在当前 Mini Engine 会话内，退出 CLI 后失效。`page` 走连接器 `batchRead`，不保证数据库端分页。

CDC 连接器可以用前台订阅查看新事件：

```text
/datasource stream demo --table customers
```

默认以当前时间调用连接器的 `timestampToStreamOffset`（若已注册），再启动 `streamRead` 并逐批显示带有 `before` 或 `after` 行数据的变更事件；心跳等不含行数据的事件会被忽略，返回计数也只统计展示的数据变更。可用 `--since 2026-11-04T00:00:00Z` 指定起始时间、用 `--record-size 20` 调整请求批量，按 Ctrl+C 请求停止。没有 `timestampToStreamOffset` 时会把 null offset 交给 PDK，连接器可能从最早位置开始。它不会创建 task 或保存检查点，不支持断点续读。

`datasource query` 需要连接器注册 PDK `queryByAdvanceFilter`，然后把过滤器、排序、skip/limit 和字段投影交给连接器执行，不在 CLI 本地模拟。`--filter` 接受 `TapAdvanceFilter` JSON（例如 `{"match":{"status":"active"}}`）；`--sort` 接受包含 `key` 与 `sort`（`asc`/`desc`）的 JSON 数组。缺少此能力时命令会明确拒绝。

`datasource command` 需要 PDK `executeCommand`，命令名称和参数由连接器定义，请先查看对应连接器说明。该接口可能产生写入等副作用，必须显式传入 `--yes`；CLI 不会把它假定为只读 SQL。

`datasource sql` 需要连接器注册 PDK `executeCommandV2`。`--type query` 返回最多 1000 行；`--type execute` 执行语句。由于连接器未必能可靠区分 SQL 是否有副作用，两种类型都要求显式 `--yes`。连接器没有该能力时命令会拒绝执行。

`datasource capabilities NAME` 会按当前 JAR 的 `registerCapabilities` 结果显示全部已注册 API，并指出已有 CLI 入口。已适配的探查操作还包括：`tables`（`getTableNames`）、`table-info`（行数/存储估算）、`count`（`batchCount`）、`indexes`、`constraints`、`minmax` 和 `now`。每项操作由引擎按实际注册能力校验；详情和未独立适配的流式/事务/DDL 生命周期接口见 [PDK 能力映射](docs/PDK-CAPABILITY-MAP.md)。

所有命令也可在交互会话中使用 `/connector ...`、`/datasource ...`、`/task ...`。不加子命令可列出该组资源。`/help` 查看完整命令；Tab 补全命令、↑ 查历史、行末 `\` 继续多行、`/clear` 清空当前 AI 对话、`/exit` 退出。

脚本使用 `--json` 或 `--output json`：成功输出 `{ "ok": true, "data": ... }`，失败输出 `{ "ok": false, "error": ... }` 并返回非零退出码。stdout 不混入 Java/连接器日志。

## 绑定 AI

### Codex / Claude CLI

先安装并用各自 CLI 登录。本工具复用它们的认证，不复制凭据。

```bash
tapdatacli ai bind codex
# 或
tapdatacli ai bind claude --name claude-main

tapdatacli model YOUR_MODEL_ID
tapdatacli ai list
tapdatacli ai use codex
tapdatacli ask '查看 demo 的表结构，然后读取 customers 的两条样例'
```

在交互模式直接输入自然语言即可。每步会展示等价原始命令、实际结果，并把结果交给 AI 继续处理。Codex 使用官方 `exec --output-schema`，Claude 使用 `-p --json-schema --output-format json`。AI 只提出参数数组，实际操作通过本工具统一命令注册表执行，本地操作通过 `local exec` 以程序和参数数组执行，默认不经过 shell。上下文包含命令参考和实际资源 ID，通过每轮提示词注入，同时写入工具自己管理的上下文目录；不会覆盖用户项目的 AGENTS.md 或 CLAUDE.md。

AI 返回普通文本或不合规 JSON 时，CLI 会自动要求纠正一次；连续失败会显示协议错误，不执行未校验的回复。若用户提供连接器目录，AI 可调用 `/connector discover --dir DIR` 列出该目录的 JAR，再使用真实路径加载。扫描不递归、不加载 JAR，最多返回 200 项；多个版本需要根据实际候选确认，缺少目标 JAR 时会说明缺失。

`/model MODEL_ID` 切换模型；`/ai native` 暂时进入原生 CLI，使用其模型选择、登录等原生能力，退出后返回。原生模式是独立会话，首版不桥接其内部工具和会话历史；需要操作数据时返回 Tapdata。CLI 模型列表自动发现、推理参数、原生会话恢复和 token 级流式响应尚未实现；`/ai models` 会明确给出可用方式。

API 绑定未设置对应的 Key 环境变量时，CLI 仍会正常启动；自然语言请求会提示缺失的变量名和配置方式。此时可输入 `/commands` 查看并继续使用斜杠命令，设置 Key 后即可恢复自然语言操作。Codex 和 Claude 原生 CLI 绑定使用各自的登录状态，不依赖 TapdataCLI API Key。

### OpenAI-compatible API / DeepSeek / 中转站

```bash
export TAPDATACLI_API_KEY='你的密钥'
tapdatacli ai bind api --name deepseek \
  --url https://api.deepseek.com \
  --key-env TAPDATACLI_API_KEY --model deepseek-chat
tapdatacli ai models
tapdatacli ask '列出已装载的连接器'
```

`--url` 是 Chat Completions 基地址，例如 `https://host/v1`，本工具追加 `/chat/completions`；模型发现追加 `/models`。模型接口不可用时仍可手工设置 `/model ID`。首版使用非流式 Chat Completions 和经校验的 JSON 命令提案，不要求服务端支持 function calling。每次请求最多串联 8 步，可继续发消息；不是所有中转站都兼容。API 密钥只通过环境变量引用，不落入配置文件。

## 本地编译和文件操作

AI 可通过 `/local exec` 完成用户要求的本地工作，包括读取构建说明、调用 Maven/npm 和检查构建结果，三类绑定共用同一宿主执行能力。例如：

```text
帮我编译 /home/tapdata-connectors 的 postgres 连接器，再查看 /home/tapdata-connectors/connectors/dist
```

也可直接执行：

```bash
tapdatacli local exec --cwd /home/tapdata-connectors \
  --argv '["mvn","-B","-pl","connectors/postgres-connector","-am","package","-Dmaven.test.skip=true"]'
tapdatacli connector discover --dir /home/tapdata-connectors/connectors/dist
```

`--argv` 必须是包含程序名的 JSON 字符串数组，`--cwd` 必须是实际目录。程序继承当前用户权限和环境；本地执行没有沙箱，绑定的 AI 可提出本地程序操作。提示词要求只完成用户请求的操作，读取的文件和日志不构成新指令。不要把密码放进参数或输出；使用本地配置及环境变量。AI 提案仍会先展示等价原始命令。

终端显示限量进度，结果返回真实退出码、stdout/stderr 尾部和日志路径，失败按错误反馈给模型。完整原始日志保存到工作区 `logs/local-*.log`，文件权限 0600；本地命令参数不写入交互历史。默认超时 1800 秒，可用 `--timeout 1..7200` 调整。Ctrl+C 停止当前回答和本地进程；POSIX 系统取消整个进程组，Windows 暂仅停止直接子进程。数据导出任务仍使用 `/task stop`。构建依赖或源代码有错时会如实返回失败，不把已有制品当作本次构建成功。

## 外部连接器和数据源

### 运行连接器仓库集成测试

Connector repositories compile integration tests from `src/it/java` and run them with Maven Failsafe. `test run` invokes the repository's existing Maven profile, so the shared `tapdata-connector-it` artifact must already be installed in the local Maven repository (see that connector's `src/it/README.md`).

```text
/test run --repo /home/tapdata-connectors --module postgres-connector --suite integration --datasource pg_test
/test run --repo /home/tapdata-connectors --module postgres-connector --suite performance --datasource pg_test --timeout 7200
/test run --repo /home/tapdata-connectors --module postgres-connector --suite tpcc --datasource pg_test
```

Supported suites are `integration` (the connector's default Failsafe group selection), `performance`, `tpcc`, and `long-transaction`. `--datasource` passes saved connection values to the connector IT framework as `CONNECTOR_IT_*` environment overrides; secrets stay out of the Maven command line. Without it, the connector repository's own IT configuration source applies. The command streams Maven output and summarizes Failsafe XML results. It returns the actual Maven exit code and private full log path. Integration suites can create or modify objects in the selected test database.

```bash
tapdatacli connector discover --dir /home/tapdata-connectors/connectors/dist
tapdatacli connector load --jar /path/mysql.jar
# 若依赖不在主 JAR：
tapdatacli connector load --jar /path/connector.jar --deps /path/dependency-jars
# 若一个 JAR 有多个 PDK 实现：加 --class fully.qualified.ConnectorClass

tapdatacli connector describe CONNECTOR_ID
tapdatacli datasource create crm --pdk-id mysql --connector CONNECTOR_ID --config /path/crm.json
tapdatacli datasource test crm
tapdatacli datasource load crm
tapdatacli datasource modify crm --set host=127.0.0.1
tapdatacli connector update CONNECTOR_ID --jar /path/new-version.jar
```

从真实 `@TapConnectorClass` 及其 spec 提取 pdkId 和配置。制品及依赖按 SHA-256 缓存，连接绑定精确制品 ID。多个版本时必须指定 `--connector`。update 注册新制品；已有连接仍固定旧版，使用 `datasource modify NAME --connector NEW_ID` 显式迁移。存在连接引用时不能 unload，存在任务引用时不能 drop 数据源。unload 不删除缓存 JAR。Maven 制品下载尚未实现。

配置可组合 JSON 和重复 `--set key=value`，显式参数覆盖 JSON；值按 JSON 标量解析，复杂对象使用 JSON 文件。PDK 表单 schema 校验目前是基础实现，完整动态表单和条件校验未实现，以真实连接测试为准。修改连接会使测试状态失效、模型缓存标记 stale。

敏感配置可在 JSON 中使用环境变量引用：

```json
{"host":"127.0.0.1","port":3306,"database":"crm","username":"reader","password":"${ENV:CRM_PASSWORD}"}
```

工作区默认为 `~/.tapdatacli`，可用 `TAPDATACLI_HOME` 隔离。数据源配置使用 AES-256-GCM 加密，密钥存于同目录的 0600 文件；这是本地文件保护，不是系统凭据保险库。元数据、任务状态和制品登记持久化，凭据展示脱敏。连接器自身诊断日志写入该目录的 `engine.log`，第三方连接器仍可能自行打印连接信息。单工作区只允许一个 CLI 会话，避免并发写状态；暂不支持共享 daemon。

## 任务和引擎边界

- 仅实现单表全量 CSV 导出。交互模式后台执行并可继续聊天、查询 `/task status NAME`、发出 `/task stop NAME`；脚本 `task start` 等待最终结果。
- 退出会话会停止本会话引擎；任务不脱离终端运行。重新启动把未完成任务标记 interrupted，不宣称恢复成功。
- JVM 内单工作线程串行执行连接器操作；取消信号独立接收。任务状态在 TS 中可即时查询；其他需要连接器的请求可能排队。
- 控制、模型和最多 100 条样例跨 JSON-RPC，批量导出记录始终留在 Java。long / decimal / BigInteger 编码为字符串，二进制有 base64 标记。元数据发现上限 5000 表，大库可用 `--table` 定位。
- 当前本地 JSON 连接器会将小型 JSON 文件载入内存；大文件流式读取不是这个示例连接器的目标。
- 暂无 CDC、数据库目标写入、DAG、断点恢复、任务修改、调度。普通终端输入已实现，复杂 TUI、粘贴/IME 的全面跨终端验证、稳定多区域渲染仍待迭代。

## 验证

```bash
npm run build
npm test
```

测试覆盖真实 JVM/PDK 装载、中文元数据和采样、CSV 字段排除、防覆盖、取消最终状态、配置加密、失败退出码、API Agent 命令与实际结果闭环。API 集成测试使用本地测试服务，不代表外部服务已认证。其他实际验证记录见 [实现状态](docs/IMPLEMENTATION.md)。原始需求保留在 [整体设计](docs/DESIGN.md) 和 [CLI 体验设计](docs/CLI-EXPERIENCE.md)。
