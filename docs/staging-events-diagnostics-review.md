# P0：Staging MCP Events 最小诊断变更评审

日期：2026-10-21。状态：已按 Nora 本轮“查看评审并执行代码”完成本地诊断实现与测试，未提交、未推送、未部署。下文原方案作为设计依据保留；实际交付与限制见末尾。

对应 [P0 原任务](https://app.notion.com/p/3fe5fa8281598111a9f9d3e04d88d949)。继续使用 ChatGPT Work + MCP Events，保留现有 OAuth、D1 和 Webhook；不引入 API 执行器或第三方投递服务。

## 结论与证据边界

建议先实施只增加可观测性的 Staging 诊断，不先改变 Callback Origin 策略。现有源码的主要协议顺序可对上官方要求，但缺乏能解释线上失败的安全日志。当前不能认定是 Origin、challenge 或平台 Task Service 的任何一项导致失败。

12:11 JST 的既有只读结果是：Staging D1 订阅0、投递0；Cloudflare 历史观测查询 HTTP403/API code10000。此次评审没有刷新远程状态。零订阅不能证明没有请求：challenge 成功后才存储。403 是观测查询的错误，不是订阅的返回码。Work 的 unexpected error 也不包含可用的 MCP RPC 证据。

## 官方及开源对照

| 项目 | 核对发现 | 对本项目的决定 |
| --- | --- | --- |
| OpenAI 官方 MCP Events | 认证后发现事件；客户端提供 callback；签名 challenge 验证后激活；稳定订阅身份、原始字节签名、有限重试；2xx 仅确认接收 | 保留现有实现顺序，逐阶段取证，不以工具成功或 HTTP200 代替订阅成功 |
| Hookdeck callback.ts | 公共地址检查与连接时 DNS 校验结合，保留 TLS 主机名验证；不跟随跳转；challenge 失败按固定类别归类 | 借鉴安全要求和失败分类，不复制 Node 网络栈，不增加 Outpost 依赖 |
| Hookdeck subscriptions.ts | 稳定身份、验证缓存、challenge 后配置交付；其示例日志遮盖 secret 后仍输出参数和完整 callback | 采用固定字段白名单日志；不复用 describeParams()、完整 URL 日志或自由格式错误日志 |
| rohanprichard starter README | 展示最小协议和本地 receiver；明确没有生产 OAuth/数据库，部分启动流程会打印临时 token | 仅参考隔离测试场景，不运行其安装/启动脚本，不替换现有 OAuth/D1，不把本地 receiver 当真实 Work |
| Appwrite Events 文档 | 订阅阶段的分类指标；签名验证、权限复核、幂等；另有 push/stream 实现 | 借鉴固定 operation/outcome/reason 指标，不移植其他传输模式或重写持久化 |

Hookdeck README 声明于2026-10-01与 ChatGPT 端到端测试；这是维护者的案例报告，不是本项目或当前账号已成功的证据。以上均为2026-10-21读取的公开源码/文档，未执行第三方代码。

本次读取的 GitHub 内容 blob SHA：callback.ts `75d683ddd7a41d9401335127d97a44c1131613a1`；subscriptions.ts `9bfe470c150a06419152f22ed4fef7d78d0d3800`。它们是内容标识，不冒充仓库 commit。

## 现有实现的重点评审

1. `src/auth/staging-oauth.ts` 要求两个 MCP scopes、允许身份及资源绑定；`src/mcp/http.ts` 在认证后路由 Events。入口、认证通过和 RPC 处理需要不同证据，不能混为一谈。
2. `validateCallbackUrl()` 要求精确公共 HTTPS origin，拒绝凭据、fragment、localhost 和 IP 字面量等。该限制可能导致 `-32602`，但未取得本次真实 origin 或拒绝证据；不能据此删除白名单。
3. 精确 origin 限制缩小了出站范围，但源码没有自行实现连接时 DNS 地址验证。它不等价于官方要求的完整 DNS rebinding/非公网地址防护。Hookdeck 的 Node `lookup`/socket 做法不能未经 Workers 运行时验证直接照搬。任何替代出站方案都另行评审；本轮不声称已解决这一缺口。
4. 当前 challenge 使用签名 verification envelope，要求2xx和常量时间 echo；manual 且不跟随3xx。成功后才写 D1；同身份刷新、事件投递主键及条件认领均已实现。
5. `McpEventError` 直接转换为 RPC error（通常 HTTP200），没有安全阶段日志。非2xx、JSON解析失败、echo不匹配同归 `challenge_failed`；仅靠现有返回分类难以定位。
6. 同事件去重不能抑制 AI 写回产生的新事件。跨事件防循环仍是后续完整验收项，不包含在本次诊断变更中。

## 拟修改范围：最小可审阅补丁

| 文件 | 拟变更 |
| --- | --- |
| `src/staging.ts` | 仅对 `/mcp` 生成随机内部 correlation，记录入口与最终 HTTP 状态；创建每请求独立 observer，经参数传递到 Provider；所有认证/其他路径不记录 URL |
| `src/auth/staging-oauth.ts` | 为 Provider 增加可选诊断上下文；记录认证通过阶段，将上下文传给认证后的 MCP handler；不记录身份、scope原值或token |
| `src/mcp/http.ts` | 接受可选 observer；仅映射固定 RPC 方法，记录解析、dispatch、RPC结束及固定数字错误码；Staging 诊断路径不输出原始 error 对象 |
| `src/mcp/events.ts` | 向参数、origin、存储读取、签名、challenge、存储写入检查点传递可选 observer；不更改现有 RPC 响应、白名单、签名、超时、TTL或重试逻辑 |
| `src/mcp/diagnostics.ts`（新增） | 严格类型及运行时字段白名单的 logger；默认 no-op，调用方仅可提供固定枚举/有限数字；logger异常不影响订阅结果 |
| `wrangler.jsonc` | 只在 `env.staging` 声明应用诊断开关及日志设置；关闭 Staging 自动 invocation URL 日志，保留安全 custom logs；生产层配置不改 |
| `worker-configuration.d.ts` | 若新增开关需要生成绑定类型，运行 Staging `wrangler types`，审阅生成差异，不部署 |
| `test/mcp-events.spec.ts`、`test/oauth.spec.ts`、新增诊断测试、`test/staging-config.spec.ts` | 实现下述路径、隔离性、敏感值不进入输出的验证 |

共享模块的可选 observer 缺省为 no-op；生产调用链不提供 observer。不能仅靠一个可由生产配置误开的变量启用：需同时经过 Staging 入口注入和 Staging 开关。不得使用模块级“当前请求”变量，避免并发串线。

开关名拟为 `MCP_EVENTS_DIAGNOSTICS`，值 `"1"`。该项、`env.staging.observability.logs.invocation_logs=false` 和 Staging采样设置只作为拟议变更，当前未应用。采样诊断窗口拟用1；自定义日志每个 `/mcp` 请求至多16条，固定字段单条上限1KiB，结束有唯一 end 记录。现有其他自定义日志的历史保留不由本方案清除。

Cloudflare invocation 日志可能包含请求 URL，故单改自定义 logger 不足以满足授权 URL 不入日志的要求。Staging 关闭 invocation logs 会减少自动请求详情：用不含URL的入口/认证/RPC日志补充。仅查询本次新 custom log 命名空间，不导出历史自动日志。

## 日志契约及失败分类

仅允许：固定 `schema="staging_mcp_diag_v1"`、内部UTC `time`、内部随机 `correlation_id`、固定 `method`/`stage`/`outcome`/`reason`、有限数字 `rpc_code`/`http_status`。不存在的数值字段省略；不得把HTTP或RPC错误混用。

方法枚举：`unclassified`、`server/discover`、`events/list`、`events/subscribe`、`events/unsubscribe`、`other`。先认证再解析body，未知方法只记other。内部correlation不取自用户的RPC id、header、subscription id或事件ID。

| 阶段 | 可诊断的固定结果/原因 |
| --- | --- |
| ingress / authentication / rpc_parse | received、passed、http_rejected、invalid_json、invalid_request |
| authenticated_dispatch / arguments_validation | passed、invalid_event、invalid_arguments、invalid_delivery、invalid_secret、invalid_ttl、invalid_cursor |
| callback_origin_validation | passed、invalid_url、invalid_configured_origin、https_required、origin_mismatch、unsafe_url |
| subscription_lookup / challenge_signing | passed、storage_failure、internal_error；签名异常不能误记成连接失败 |
| challenge_transport / challenge_http | passed、timeout、connection_failed、non_2xx；记录实际HTTP数值，不存响应文本、Location |
| challenge_json / challenge_echo | passed、invalid_json、invalid_echo；不记录challenge或任何响应字段 |
| challenge_cache / subscription_persist / rpc_end | skipped_verified、passed、storage_failure、success、rejected、internal_error；end含实际RPC code及HTTP status |

实际发生的阶段均先设置再执行，失败end保留最后阶段；所有原因使用明确分支产生，禁止根据 error.message 猜测DNS/TLS。网络栈没有可靠结构化证据时只记connection_failed。公共RPC `data.reason`保持原样；更细的分类仅在内部日志。

本版不记录callback origin。若命中origin_mismatch，再走单独、经过审阅的仅HTTPS origin取证方式；不能临时打开原始请求调试。日志中没有参数、页面内容、headers、callback URL/路径/query、授权URL、token、Cookie、密钥、签名、PKCE、原始异常或任意字符串透传。不允许展开未知对象或用JSON.stringify(params/error/response)。

示例（仅虚构内部关联号，无真实请求）：

```json
{"schema":"staging_mcp_diag_v1","time":"2026-10-21T04:00:00.000Z","correlation_id":"00000000-0000-4000-8000-000000000001","method":"events/subscribe","stage":"callback_origin_validation","outcome":"rejected","reason":"origin_mismatch","rpc_code":-32602,"http_status":200}
```

这条记录才支持“认证后订阅到达，Origin校验拒绝”；如果只看到ingress，不能声称认证后订阅已到达。如果日志缺失，还须排除权限、采样、延迟、开关和运行时中断，不能直接认定平台没发请求。

## 测试及验收策略

1. 在真实本地Provider/KV认证流下验证现代协议发现与路由，再验证正确订阅：单个correlation串联认证、challenge、D1及end；所有RPC/body行为和现有结果保持一致。
2. 覆盖参数/密钥/TTL/cursor错误、非法或不匹配origin；断言错误阶段准确、回调未访问、D1未插入，公共RPC响应不变。
3. 覆盖签名失败、受控timeout/连接失败、3xx/4xx/5xx、2xx非法JSON、echo不匹配、正确echo及验证缓存命中；不可记录未实际发生的后续阶段。
4. 模拟D1读取/写入故障和logger抛错；存储故障阶段正确，logger失败不改变原结果。并发两次请求的correlation不得混用；重复订阅不多建记录。
5. 将独特哨兵注入完整URL各部分、secret、token、Cookie、PKCE、RPC id、未知方法、异常message/stack、响应body/Location；捕获全部console通道，断言哨兵及其常见编码均未出现。校验字段白名单、类型、行数/字节上限和仅固定枚举。
6. 验证生产入口和开关关闭时没有新增诊断输出；源级配置测试确保invocation日志关闭仅在Staging。验证新开关的绑定类型。
7. 实施后执行源码/测试TypeScript、Staging完整回归、原入口回归和diff检查；共享模块有变化所以需要两入口回归，不把重叠测试数相加。此次仅文档评审，没有实施或运行上述测试，不引用历史63项为本方案已通过。

## 线上读取、风险与审批顺序

先确认有人能读取新日志：Nora使用已有Dashboard权限，或在当前权限下验证Staging短时tail是否可用。历史Observability API403没有被这份代码方案解决；没有读取渠道时，不应先部署后盲目重试，更不能自动扩权。读取只投影固定字段，原始输出不得保存到磁盘或Notion。

1. Nora审阅批准“本方案本地实现与测试”；完成补丁后提交实际diff和测试结果。
2. Nora另行批准Staging部署及明确的Staging日志配置范围；生产、callback allowlist、OAuth权限、D1 schema及订阅业务行为不变。部署前仍核对实际diff和当前线上版本，不默认旧版本始终最新。
3. 部署完成且日志读取可用后，记录UTC窗口，安排一次Work真实订阅；先不改业务记录。定位后另行评审所需修复，Origin变更不包含在这次部署许可内。
4. 若订阅成功，后续再执行签名交付、Work响应、Notion原记录写回与跨事件防循环验收；诊断完成不等于P0完成。

风险：增加少量日志写入与存储成本；禁用自动invocation日志降低通用排查细节；共享函数签名变化需防止生产误启用；故障/终止可能缺少end；已有403仍可能阻断读取。关闭Staging诊断开关可停止新增应用诊断日志，但仍需配置部署；不以恢复自动URL日志作为默认回退。发生行为回归时回退诊断补丁/此前Staging版本，仍需部署授权，生产不参与。

## 参考来源

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Hookdeck callback.ts](https://github.com/hookdeck/mcp-events-outpost-demo/blob/main/src/server/callback.ts)
- [Hookdeck subscriptions.ts](https://github.com/hookdeck/mcp-events-outpost-demo/blob/main/src/server/subscriptions.ts)
- [Hookdeck README](https://github.com/hookdeck/mcp-events-outpost-demo)
- [MCP Events starter](https://github.com/rohanprichard/mcp-events-starter)
- [Appwrite Events](https://github.com/appwrite/mcp/blob/main/docs/events.md)
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)


## 本地诊断实施交付（2026-10-21）

### 实际范围

- 只在 `src/staging.ts` 的 `/mcp` 请求、且 `ENVIRONMENT=staging` 和 `MCP_EVENTS_DIAGNOSTICS=1` 时创建 observer，经每请求独立的 Provider 闭包传递。共享模块不默认启用；原入口不注入。
- 固定字段 `schema/time/correlation_id/method/stage/outcome/reason/rpc_code/http_status`；UTC 时间与 UUID 均由内部产生。运行时也检查枚举和数值，未知方法只记 `other`。每请求最多16条、每条最多1KiB，为唯一最终记录预留额度；sink 抛错不影响 RPC。
- 最终记录 outcome 为 `success/rejected/internal_error/completed`。成功的已知 RPC 使用 `rpc_end`；失败保留实际失败阶段和真实 RPC code；`completed/http_returned` 只表示 SDK 转交路径的 HTTP 已返回，未解析其 RPC 成败。中间记录只使用 `received/passed/failed`，回调 HTTP 状态与最终入站 HTTP 状态分别记录。
- 细分参数、Origin、订阅身份计算（`subscription_identity`）、D1读取、签名、连接、回调HTTP、JSON、echo、缓存命中及D1写入。签名错误内部记 `challenge_signing/internal_error`，公共 `-32015` 和原 `data.reason` 不变。失败操作后不会记录该操作通过。
- 仅 `env.staging` 增加日志设置：100%采样，关闭 invocation logs；增加诊断开关。已实际运行 Staging 类型生成，生成差异只有新变量及其类型索引/配置hash。原入口配置、OAuth范围、callback白名单、D1 schema、签名、TTL、缓存与轮换行为、重试均未调整。

### 验证

- 源码和测试 TypeScript 均通过。
- Staging：5文件/99项通过；原入口：2文件/24项通过。两套有重叠，不合计独立测试数。
- 新增34项诊断测试；另新增1项真实本地Provider/KV/PKCE后订阅集成测试、1项配置隔离测试。覆盖故障分类、秘密哨兵、全部常见console通道、异常message、callback响应/Location、OAuth token、未知枚举、行数/字节上限、logger故障、并发correlation、缓存命中、unsubscribe与双入口开关隔离。
- 本地OAuth后订阅测试实际观察到同一correlation的authentication、challenge、subscription_persist与唯一最终记录；签名HTTP使用本地受控transport，不是真实Work callback。
- `wrangler deploy --dry-run --env staging` 仅完成本地打包并退出，没有上传或发布。
- 测试在不含真实 `.dev.vars` 的临时源码副本中执行，仅使用本地D1/KV和已安装依赖；没有运行远程迁移、真实订阅或业务触发。

### 安全待办与部署门槛

评审列出的以下原有问题未在本次“诊断且行为不变”补丁中修改：投递时账号/grant撤销复核；Workers连接时公网地址验证；verified_at滑动缓存；旧密钥宽限期刷新；D1自由格式last_error；事件发生时间与接收时间分离；跨事件防循环。不能声称这些问题已修复，也不导出last_error。

应用字段白名单不等于整个Cloudflare日志平台已脱敏。仍须在独立批准的Staging验证中，用合成哨兵核对实际存储记录、tail envelope、平台自动附加元数据和未捕获异常，不能使用真实授权URL。当前没有本轮日志读取成功证据，历史403未解决；部署列表/D1只读查询成功不代表日志可读。

下一步：审阅本次实际diff，确认现有权限下的安全日志读取渠道，然后另行批准Staging部署与合成日志验收。部署前重新核对线上版本；不修改callback Origin或权限，不做生产操作，不引入额外API执行器。P0仍受阻，等待本地实现阶段审核；本轮指令不是部署许可。
