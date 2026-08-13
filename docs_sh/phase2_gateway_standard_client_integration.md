# Phase 2：Gateway 标准客户端接入与接口规范

> 目标：把 Gateway 视为可由 Web UI、macOS、移动端或新客户端共同复用的完整后端，说明它的标准接入方式、核心模块、输入输出契约与二次开发注意事项。
>
> 结论基于当前源码与协议版本 `4`。本文聚焦直接连接 Gateway 的客户端；Telegram、Slack 等 `extensions/` 消息渠道是 Gateway 的传输插件，并不是这条客户端接入链路的一部分。

## 结论

**Gateway 可以被不同客户端高度复用，但复用的边界是“WebSocket 控制平面协议”，不是复制某个客户端页面或直接调用内部 TypeScript 函数。**

客户端通过一条 WebSocket 连接进入 Gateway，完成认证、设备配对与协议协商后，统一调用 RPC methods、接收事件和初始快照。Gateway 内部负责所有核心后端能力：身份与权限、会话、Agent 执行、模型/工具、插件、持久化、任务、节点与审计。不同客户端只决定：

- 呈现什么 UI；
- 申请哪一种角色（`operator` 或 `node`）及最小 scopes；
- 声明并实现哪些客户端 capabilities；
- 如何安全保存设备身份、device token 与 TLS 信任材料；
- 如何将 Gateway 的快照和事件投影为本地状态。

因此，新客户端的首选方案是：**以 `operator` 角色接入，使用公开的 `@openclaw/gateway-protocol` 与 `@openclaw/gateway-client`，先完成聊天/会话闭环；设备能力另建 `node` 连接。**

## 1. Gateway 在客户端接入中的位置

```text
┌──────────────────── 客户端层 ────────────────────┐
│ Web UI │ macOS/iOS/Android │ Linux │ TUI │ 新客户端 │
└────────┬───────────────────────┬────────────────┘
         │ operator：控制/聊天    │ node：设备能力
         └───────────────┬───────┘
                         │ WebSocket：connect / req / res / event
┌────────────────────────▼──────────────────────────┐
│ Gateway（唯一后端与控制平面）                         │
│ auth + device pairing + method registry + dispatch │
│ sessions + agents + models + tools + plugins       │
│ state(SQLite) + cron/tasks + nodes + audit          │
└───────────────────────────────────────────────────┘
```

Gateway 的生产 Control UI 同样由 Gateway 的 HTTP 服务提供；所以 Web UI 并不是独立后端。它在浏览器内通过同一端口的 WebSocket 调用 Gateway。macOS/iOS/Android/TUI 的原生实现虽然语言不同，接入的仍是同一个协议。

源码入口与边界：

| 层                  | 主要源码                                                                                              | 对客户端的意义                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Gateway 启动入口    | `src/gateway/server.ts` → `src/gateway/server.impl.ts`                                                | 运行完整 Gateway；客户端不应依赖其进程内函数。                           |
| WebSocket 连接      | `src/gateway/server/ws-connection.ts`                                                                 | 创建连接、预认证预算、challenge、心跳、出站背压、断线清理。              |
| 握手与认证          | `src/gateway/server/ws-connection/message-handler.ts`、`connect-auth.ts`、`connect-device-pairing.ts` | 验证首个 connect 请求、认证、设备身份、配对和角色/权限。                 |
| 已认证请求分发      | `authenticated-request-dispatch.ts`、`authenticated-request-dispatch.server-methods.runtime.ts`       | 校验 request frame、按 method 分发、处理 trace、失效凭据和错误响应。     |
| RPC 注册表          | `src/gateway/methods/descriptor.ts`、`registry.ts`、`core-descriptors.ts`                             | 为每个 RPC 绑定 owner、scope、是否可公开发现、启动可用性和写控制面属性。 |
| 服务端业务 handlers | `src/gateway/server-methods/**`                                                                       | 具体执行 chat、sessions、config、nodes、plugins、cron、approvals 等。    |
| 公共协议            | `packages/gateway-protocol/**`                                                                        | 客户端真正应依赖的类型、schema、版本、错误和 capability 注册表。         |
| 参考客户端          | `packages/gateway-client/**`                                                                          | TypeScript/浏览器端的连接、认证、request-id、超时、重连与事件处理参考。  |

## 2. 标准接入方式：从 WebSocket 到业务能力

### 2.1 推荐接入层级

| 目标                            | 标准做法                                                         | 复用程度 | 是否要改 Gateway                       |
| ------------------------------- | ---------------------------------------------------------------- | -------- | -------------------------------------- |
| 改造现有 Web 管理能力           | 在 `ui/` 增加页面/组件，复用 Gateway store 与 browser client     | 最高     | 通常不需要                             |
| 新 TS/Electron/Node 客户端      | 使用 `@openclaw/gateway-client` + `@openclaw/gateway-protocol`   | 高       | 通常不需要                             |
| 新 Swift/Kotlin/Rust 原生客户端 | 按协议实现 transport；对照 Apple/Android/Linux 客户端            | 高       | 通常不需要                             |
| 嵌入完整控制台                  | 打开 Gateway 已服务的 Control UI；敏感凭据留在 native host       | 高       | 不需要                                 |
| 接入新的设备能力                | 新建 `role: node` 连接，声明 commands/caps/permissions           | 中       | 可能需 Gateway command policy/插件支持 |
| 创建新的产品级客户端身份        | 新增封闭的 client id、schema、Gateway 策略、生成物与测试         | 中       | 需要                                   |
| 让 Gateway 新增业务 RPC         | 在 method registry/handler/schema 中扩展，或通过 plugin SDK 注册 | 中       | 需要                                   |

不要把新客户端通过 HTTP 直接访问 Gateway 的内部模块、SQLite 或 `src/gateway/server-methods`。这些不是稳定的外部 API；跨版本可维护的边界是公开 WebSocket 协议与已发布 package。

### 2.2 建立连接：严格的四阶段

`src/gateway/server/ws-connection.ts` 在连接建立后先发送 challenge；`message-handler.ts` 强制第一条客户端请求为 `connect`。流程如下：

```text
1. WebSocket Upgrade
2. Gateway → event(connect.challenge, { nonce, ts })
3. Client  → req(connect, ConnectParams)
4. Gateway → res(hello-ok) 或结构化 error / close
5. Client  ↔ req/res（业务 RPC） + Gateway → event（实时状态）
```

| 阶段         | Gateway 做什么                                               | 客户端必须做什么                                                               |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Upgrade      | 建立 pre-auth 连接预算；限制预认证帧                         | 不发送业务 frame，不把连接当作已登录。                                         |
| challenge    | 发送一次性 `nonce` 与时间戳                                  | 设备认证客户端用该 nonce 和 `ts` 签名；收到 malformed challenge 不可静默继续。 |
| connect      | 验证 frame/params、协议、auth、origin、角色、设备配对        | 第一帧必须是 `req` + `method:"connect"`；填写完整 client 元数据与最小权限。    |
| hello        | 返回协议、服务端信息、methods/events、snapshot、auth、policy | 保存 device token；以 snapshot 初始化 UI；仅展示服务端实际广告的功能。         |
| steady state | 校验每条请求、授权、分发、心跳、慢消费者保护、断开清理       | 使用 request id；处理 response/error/event；重连后重新建立状态投影。           |

预认证 frame 上限是 64 KiB，认证后客户端必须读取 `hello-ok.policy.maxPayload` 与 `maxBufferedBytes`。Gateway 在 socket 出站缓冲过高时会关闭慢消费者；因此客户端的事件处理和渲染不得无限阻塞主接收循环。

## 3. 客户端输入规范：发给 Gateway 的内容

### 3.1 顶层 JSON 帧

所有 WebSocket 消息是 JSON 文本帧，schema 位于 `packages/gateway-protocol/src/schema/frames.ts`。

| 类型     | 客户端是否发送            | 规范                                                     | 用途                            |
| -------- | ------------------------- | -------------------------------------------------------- | ------------------------------- |
| Request  | 是                        | `{ type:"req", id, method, params?, traceparent? }`      | `connect` 和所有 RPC 调用。     |
| Response | 否（标准 Gateway 客户端） | `{ type:"res", id, ok, payload?, error? }`               | Gateway 对 request 的对应结果。 |
| Event    | 否（标准 Gateway 客户端） | `{ type:"event", event, payload?, seq?, stateVersion? }` | Gateway 主动输出。              |

`id` 必须在当前连接内可关联；客户端应把它映射为 pending promise/task。不要用“下一条 response 就是当前请求”的假设，因为并发 RPC 与 event 会交错到达。`traceparent` 可携带有效且不超过 128 字符的 W3C trace context；它可选，格式错误时 Gateway 重新创建 trace，不应成为业务依赖。

### 3.2 `connect` 输入契约

首帧格式：

```json
{
  "type": "req",
  "id": "<unique-request-id>",
  "method": "connect",
  "params": {
    "minProtocol": 4,
    "maxProtocol": 4,
    "client": {
      "id": "<registered-client-id>",
      "version": "<app-version>",
      "platform": "<platform>",
      "mode": "ui"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "deviceToken": "<stored-device-token>" },
    "device": {
      "id": "<stable-device-id>",
      "publicKey": "<ed25519-public-key>",
      "signature": "<challenge-bound-signature>",
      "signedAt": 0,
      "nonce": "<challenge-nonce>"
    }
  }
}
```

示例只说明结构，不能把 `signedAt: 0` 或静态 nonce 用于实际接入。以下字段决定 Gateway 的接入语义：

| 输入                           | Gateway 的处理                                          | 客户端实现要求                                                                         |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `minProtocol/maxProtocol`      | 协商可接受 wire version                                 | 普通 operator 当前须精确协商 4；node 有 3–4 窗口。用 protocol package 常量，不要手写。 |
| `client.id/mode`               | 校验封闭 client registry，参与策略与诊断                | 使用 `GATEWAY_CLIENT_IDS`；新增身份不能只自定义字符串。                                |
| `role`                         | 区分 operator 与 node 的连接生命周期及 method 权限      | 一个连接只承担一种角色；原生 App 可持有两条连接。                                      |
| `scopes`                       | 授予的 operator RPC 权限上限                            | 最小申请；role 或 scope 扩大时会要求重新配对。                                         |
| `caps`                         | 告知 Gateway 可接收的 UI/工具体验                       | 只声明实际支持的 capabilities；cap 不等于授权。                                        |
| `commands/permissions/pathEnv` | node 的可调用系统能力与即时权限                         | 由真实 OS 授权、开关和依赖生成，不能硬编码“全允许”。                                   |
| `auth`                         | shared token/password/bootstrap token/device token 认证 | 首连可用 shared credential；已配对后优先本 origin、同 role 的 device token。           |
| `device`                       | 设备身份、签名与配对依据                                | 持久化 Ed25519 identity；使用当次 challenge；不得记录私钥或凭据。                      |

### 3.3 业务 RPC 输入：以功能而非内部模块接入

Gateway 使用 registry 将 method 映射到 handler 与 scope。`src/gateway/methods/core-descriptors.ts` 中的 method 分类可作为客户端菜单/权限设计依据，但实际可用集合应以 `hello-ok.features.methods` 为准。

| 客户端功能             | 常用输入 RPC                                                     | 最低典型 scope       | 注意点                                                                  |
| ---------------------- | ---------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| 初始化会话列表         | `sessions.list`、`sessions.subscribe`                            | `operator.read`      | 订阅替代高频轮询；缺字段的 changed event 是刷新信号。                   |
| 聊天                   | `chat.history`、`chat.send`、`chat.abort`                        | read / write         | 历史是权威投影；发送和流式 event 是不同接口。                           |
| 会话操作               | `sessions.create/send/patch/abort`                               | read/write/dynamic   | 有些 mutation 根据 params 提升为 admin，不能根据 method 名猜权限。      |
| 审批                   | `approval.get/resolve/history`                                   | `operator.approvals` | 先订阅事件，再 backfill，按 approval id 去重。                          |
| 节点与设备管理         | `node.list`、`device.pair.*`、`node.pair.*`                      | read / pairing       | 仅管理配对需要 `operator.pairing`；并非所有聊天端都应申请。             |
| 配置、插件、终端、重启 | `config.*`、`plugins.*`、`terminal.*`、`gateway.restart.request` | 多数 admin           | 是高风险控制面，不纳入普通聊天 MVP。                                    |
| 设备能力调用           | `node.invoke`                                                    | dynamic              | operator 发起；Gateway 再选择配对 node 执行，并做 command policy 检查。 |
| node 回传              | `node.invoke.result`、`node.event`、`node.invoke.progress`       | node                 | 仅已认证 node 连接允许。                                                |

带副作用的 method 需要遵循其 schema 中的 idempotency key 约束；不能靠网络重试简单重复发送写操作。

## 4. Gateway 输出规范：客户端应如何消费

### 4.1 `hello-ok`：连接级能力合同

成功 connect 的 response payload 必为 `hello-ok`。它同时是“连接成功信号”和“本次连接的后端能力清单”。

| 输出字段                               | 语义                            | 客户端动作                                                    |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| `protocol`                             | 实际协商版本                    | 不兼容时停止继续调用并引导升级。                              |
| `server.version/connId`                | 服务端版本和连接实例            | 用于诊断；connId 不是长期设备 ID。                            |
| `features.methods/events/capabilities` | 当前 Gateway 公开的运行时能力   | Feature-gate UI；禁用而非调用一个不存在的方法。               |
| `snapshot`                             | 连接时权威状态                  | 初始化 session、health、presence 等本地 projection。          |
| `auth.role/scopes`                     | 最终生效身份与权限              | 以实际返回值覆盖客户端请求的预期。                            |
| `auth.deviceToken/deviceTokens`        | 可持久化的后续连接凭据          | 按 Gateway origin + role + device 保存；不可跨 Gateway 复用。 |
| `policy`                               | payload、buffer、tick、附件限制 | 每次连接更新上传/发送/心跳策略。                              |
| `pluginSurfaceUrls` / UI descriptors   | 受限插件页面或渲染能力          | URL 会过期，按接口刷新；不要缓存为永久地址。                  |

### 4.2 RPC 成功与失败输出

每个 request 得到同一 `id` 的 response：

```json
{ "type": "res", "id": "<same-id>", "ok": true, "payload": {} }
```

或：

```json
{
  "type": "res",
  "id": "<same-id>",
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "...",
    "details": {
      "code": "MISSING_SCOPE",
      "missingScope": "operator.approvals",
      "requiredScopes": ["operator.read", "operator.approvals"]
    }
  }
}
```

错误处理规则：以 `error.code` 和 `error.details.code` 分支，`message` 仅用于展示。客户端至少应区分：

- `FORBIDDEN/MISSING_SCOPE`：隐藏或禁用对应功能，提示用更高 scope 的设备重新配对；
- pairing/device identity/auth 错误：停止盲目重连，进入“等待批准/重新登录”；
- `UNAVAILABLE` 且 `retryable`：遵守 `retryAfterMs`，尤其是 Gateway 启动 sidecar、重启或 suspend；
- payload/validation 错误：在本地纠正 payload，不做无界重试；
- device token 失配/被撤销：清除该 origin+role 的旧 token，重新进入认证与配对。

### 4.3 事件输出：实时体验与断线恢复

事件 frame 格式为 `{ type:"event", event, payload, seq?, stateVersion? }`。它承载聊天流式 agent 输出、sessions changed、approvals、presence、health、node lifecycle、config changed 等。

客户端需要遵守以下消费规则：

1. 外层 `seq` 只在当前 socket 内排序，重连后会重置；发现向前 gap 时刷新权威数据。
2. `agent` event 内的 run sequence 是按 run 排序；每个 run 独立保存最高 accepted seq，重复或更低的 event 忽略。
3. 重连后的 hello 不是“恢复到旧内存”，而是新 projection：重建 subscriptions、调用 `chat.history`、接管 `inFlightRun`，再继续消费 event。
4. 所有 capability-gated event 都要先在握手声明 cap。例如没有 `tool-events`，Gateway 不会为该连接注册 live tool stream；这不是网络故障。
5. 订阅是连接级状态。每次重连都重新执行 `sessions.subscribe` 和选定会话的消息订阅。

## 5. Gateway 后端复用的核心模块

下表说明当新客户端接入时，哪些后端模块已经被 Gateway 统一复用，客户端不应重复实现。

| Gateway 模块                    | 已统一提供的后端能力                                        | 客户端应做的事                             | 不应做的事                                                |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| Auth + device pairing           | shared auth、device identity、device token、scope/role 升级 | 安全保存身份/凭据，展示配对状态            | 自造 token、绕过配对、复制 admin 凭据。                   |
| Method registry + authorization | method discovery、scope、owner、启动状态、控制面写操作标识  | 按 hello methods/scopes gating UI          | 从 UI 推断或硬编码“某方法一定可用”。                      |
| Sessions + transcript           | session 生命周期、持久化、历史投影、并发状态                | 渲染、订阅、重连后刷新                     | 直接改 SQLite/JSONL 或在客户端维护另一份权威 transcript。 |
| Agents + model/tool runtime     | prompt、模型调用、工具、run 生命周期、队列                  | 展示 agent events、发起规范请求            | 在客户端复制 agent loop 或模拟服务端终态。                |
| Plugin system                   | capability discovery、plugin method/Surface 注册            | 按 methods/surfaces 可用性渲染             | 直接 import 插件私有源码或假定某插件已安装。              |
| Nodes                           | pairing、inventory、command policy、invoke routing          | node 端报告真实能力，operator 发起受控调用 | 直接从 UI 调用 OS API 或让 node 自行扩权。                |
| State / SQLite                  | 配置、设备、会话、任务与运行时状态的权威存储                | 缓存仅做本地 UX，加失效策略                | 读取/写入 Gateway state DB 作为集成 API。                 |
| Cron/tasks/approvals/audit      | 后台工作、审批工作流、持久化任务和审计                      | 订阅、展示、提交显式动作                   | 在客户端私自补偿或重放未知写操作。                        |

## 6. 二次开发新客户端：技术实施清单

### 6.1 MVP 实施顺序

1. **选角色和边界**：默认 `operator`；目标仅为会话列表 + 文本聊天。暂不申请 `operator.admin`，不做 node。
2. **选实现方式**：TypeScript 用公开 packages；Swift/Kotlin/Rust 以现有原生实现为协议参考。不要从零定义自有 JSON 协议。
3. **实现 credential vault**：持久化 Ed25519 device identity；按 endpoint origin/role 保存 device token；shared token/password 只用于首连 bootstrap。
4. **实现 connection state machine**：Upgrade → challenge → connect → hello → req/res/event；每个阶段均有 timeout 和明确 UI 状态。
5. **用 hello 驱动界面**：读取实际 scopes、methods、policy、snapshot；错误/缺方法时降级显示。
6. **完成聊天闭环**：`sessions.list`、`sessions.subscribe`、`chat.history`、`chat.send`、agent event、`chat.abort`。
7. **加入可靠性**：断线重连、订阅重建、history 回填、run seq 去重、慢消费者保护、幂等写请求。
8. **再扩展能力**：审批 → questions → pairing 管理 → 设备 node → plugins/config/terminal；每加一项都重新审视 scopes 和 capabilities。

### 6.2 新 node 客户端的附加要求

node 是“Gateway 可调用的设备”，不是普通聊天界面。实现 node 前必须额外完成：

- 独立 `role:"node"` 连接与设备身份；不得复用 operator scopes 作为 node 授权。
- 从 OS 实际授权和开关生成 `commands`、`caps`、`permissions`；参考 Android `node/ConnectionManager.kt` 与 macOS `NodeMode/MacNodeModeCoordinator.swift`。
- 对 `node.invoke` 建立 command 白名单与类型校验；处理 timeout、cancel、idempotency key，并调用 `node.invoke.result` 返回结构化结果。
- 将 OS 权限、用户确认和 Gateway command policy 三层分开：连接/配对成功不意味着可以调用相机、文件或系统控制。
- 面对后台、网络切换和 Gateway 重启，失效旧 route；绝不能把旧 socket 的 result 投递到新连接。

### 6.3 安全、兼容与性能细节

| 维度     | 必须关注的细节                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------- |
| 权限     | scopes 是协议契约；最小授权。`caps` 只声明 UI/客户端能力，不提升权限。                                  |
| 认证     | 不在 URL、日志、截图或 WebView JS 中暴露 shared token/device token；Token 按 origin 和 role 隔离。      |
| TLS/网络 | 非 loopback 远端使用 WSS；原生端支持证书指纹；反向代理环境正确配置 origin/trusted proxy。               |
| 版本     | client 和 Gateway 的 protocol version 要协商；升级前检查 `protocol.schema.json`、`since` 与 changelog。 |
| 输入     | 用公开 schema/types 校验；附件同时检查 decoded 限额和 JSON/base64 后的完整 frame 大小。                 |
| 输出     | `hello-ok` 是本连接事实源；event 是增量而非永久历史；断线后重新投影。                                   |
| 并发     | request-id 与 event 分离；不要串行阻塞 socket 回调；对写操作遵守 idempotency。                          |
| 可观测   | 保存不含秘密的 conn/version/error code/close cause；对用户显示下一步动作，而非泛化“失败”。              |
| UI       | 按 `features.methods`、scopes、caps gating；不可用功能应隐藏或说明原因，避免 dead-end。                 |

## 7. 验收用例

| 用例                   | 预期结果                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| 首次连接               | token/password 认证后生成 pending pairing；客户端明确显示等待批准。                               |
| 完成批准后重连         | 收到 hello 与 device token；后续无需重复 shared credential。                                      |
| scope 升级             | Gateway 创建新的 pairing request；旧权限不被静默扩大。                                            |
| 普通聊天               | `chat.send` response 成功，agent events 流式渲染，最终结果与 `chat.history` 一致。                |
| 重连                   | subscriptions 重新建立；history 回填；同一 run 无重复增量。                                       |
| Gateway 刚启动/重启    | 收到 retryable `UNAVAILABLE` 时按 `retryAfterMs` 恢复，不把它当作永久认证失败。                   |
| 缺少 capability/method | 功能被 gating，不发送未知 RPC。                                                                   |
| 大附件                 | 发送前校验 `policy.attachments` 与 `maxPayload`，拒绝给出可读原因。                               |
| node（如实现）         | 未配对、未批准 command、OS 拒权、invoke cancel/timeout 均返回可操作的结构化失败；危险动作不执行。 |

## 8. 源码与公开文档导航

| 主题                       | 优先阅读                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebSocket 协议、错误、版本 | `packages/gateway-protocol/src/schema/frames.ts`、`packages/gateway-protocol/src/version.ts`、`packages/gateway-protocol/src/gateway-error-details.ts` |
| 连接/认证/重连参考实现     | `packages/gateway-client/src/protocol-client.ts`、`connect-auth.ts`、`browser-device-auth.ts`                                                          |
| Gateway 准入与请求分发     | `src/gateway/server/ws-connection.ts`、`src/gateway/server/ws-connection/message-handler.ts`、`authenticated-request-dispatch.ts`                      |
| RPC/权限归属               | `src/gateway/methods/descriptor.ts`、`registry.ts`、`core-descriptors.ts`                                                                              |
| Web UI 接入范例            | `ui/src/api/gateway-browser-socket.ts`、`ui/src/app/gateway-store.ts`                                                                                  |
| Apple 原生接入范例         | `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift`、`GatewayNodeSession.swift`                                                         |
| Android node 能力范例      | `apps/android/app/src/main/java/ai/openclaw/app/node/ConnectionManager.kt`、`InvokeDispatcher.kt`                                                      |
| 公开接入说明               | `docs/gateway/protocol.md`、`docs/gateway/clients.md`、`docs/web/control-ui.md`                                                                        |

## 最终建议

对新的业务客户端，先把 Gateway 当作“认证后的 Agent 控制平面 API”，而不是可直接嵌入的后端代码库。先以最小 `operator` 权限完成连接、会话、聊天、实时事件和重连；在真实设备能力被验证需要后，才以独立 `node` 连接增加系统能力。这样既能最大化复用 Gateway 的完整后端，又不会在第一版就把权限、协议兼容和设备安全复杂度带入客户端。
