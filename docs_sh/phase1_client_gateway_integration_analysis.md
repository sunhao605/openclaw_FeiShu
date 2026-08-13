# Phase 1：客户端与 Gateway 接入源码分析

> 目标：说明 OpenClaw 的各类客户端如何复用 Gateway 通信体系、哪些地方因运行环境而分化，以及新增一个客户端时应该从哪里开始。
>
> 分析边界：当前仓库源码（协议版本为 `4`），不把 IM 渠道插件当作“客户端”。渠道插件是 Gateway 的入/出站传输适配层；本文的客户端是直接连接 Gateway 的 UI、原生 App、终端或设备节点。

## 结论先行

所有客户端的共同中心不是某套 UI 组件，而是 Gateway 的 **WebSocket RPC 协议**：同一条连接先完成 `connect.challenge → req(connect) → hello-ok`，再用 `req/res/event` 三种 JSON 帧交互。客户端通过握手声明自身的身份、角色、权限范围和能力；Gateway 返回可调用方法、可订阅事件、快照和会话级 device token。

因此，二次开发不能只做“向 WebSocket 发送 `chat.send`”。一个可上线客户端至少要正确处理：协议协商、认证与设备配对、权限最小化、首个快照、实时事件序号、断线重连和协议版本演进。

更重要的分界是角色：

| 目标                             | 推荐角色          | 含义                                                    | 典型客户端                                           |
| -------------------------------- | ----------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| 聊天、配置、会话、审批、运维面板 | `operator`        | 人在操作 Gateway；按 `operator.*` scopes 控制可调用 RPC | Control UI、macOS 控制面、iOS/Android 聊天、TUI、CLI |
| 暴露设备能力给 Agent 调用        | `node`            | 设备接受 Gateway 的 `node.invoke`，并回传结果与设备事件 | macOS/iOS/Android/Linux node                         |
| 只嵌入既有控制界面               | 浏览器 Control UI | 不重写协议/UI，只加载 Gateway 已提供的网页              | Linux 桌面壳的主窗口                                 |

新客户端应先做一个 **operator-only 聊天 MVP**；只有确实需要相机、通知、位置、文件、系统控制等设备能力时，第二阶段再增加独立的 `node` 连接。把两者混为一条高权限连接，会扩大权限与故障面。

## 1. 共同通信内核

### 1.1 传输与协议帧

Gateway 默认在同一个端口提供 HTTP 和 WebSocket；Control UI 的生产页面也由该端口提供。所有直连客户端最终都使用 WebSocket，顶层帧约束定义在 `packages/gateway-protocol/src/schema/frames.ts`：

```text
客户端 ── WebSocket ──> Gateway
  ① 收到 connect.challenge（nonce、时间）
  ② req { method: "connect", params: ConnectParams }
  ③ res { id, ok, payload: hello-ok } 或连接/认证错误
  ④ req { id, method, params }  <──>  res { id, ok, payload/error }
  ⑤                          <──  event { event, payload, seq, stateVersion }
```

- `req/res` 的 `id` 将并发请求与响应配对；`event` 是服务端主动推送，适合聊天流式输出、presence、配置变化、节点调用和生命周期状态。
- `hello-ok.features.methods/events/capabilities` 是运行时能力发现；客户端不应假定某 RPC 在旧 Gateway 或未启用插件上一定存在。
- `hello-ok.snapshot` 是连接成功后的首份权威状态，`policy` 同时下发 payload、附件和 tick 限制。不要把前端本地缓存当作 Gateway 真相。
- 协议当前 `PROTOCOL_VERSION=4`，普通客户端最低版本为 4，而 node 可兼容至 3（`packages/gateway-protocol/src/version.ts`）。原生端协议模型由脚本生成，例如 Android 的 `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayProtocol.kt`。

### 1.2 每个客户端都必须带上的握手语义

`ConnectParams` 的关键字段如下。它们不是展示信息：Gateway 会据此做策略、配对和诊断决策。

| 字段                                 | 作用                                                           | 二次开发要求                                                                                        |
| ------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `minProtocol` / `maxProtocol`        | 版本协商                                                       | 用当前协议常量；协商失败应提示升级，不要降级猜测字段。                                              |
| `client`                             | `id`、版本、平台、mode、实例与设备信息                         | `id` 必须在封闭枚举中注册（见 `client-info.ts`）；自建客户端要同步扩展协议 schema 与 Gateway 策略。 |
| `role`                               | `operator` 或 `node` 等连接职责                                | 角色决定服务端准入、最低协议和后续行为。                                                            |
| `scopes`                             | 请求的 operator 权限                                           | 只申请功能真正需要的 scope；扩权会触发新的配对审批。                                                |
| `caps`                               | 客户端可渲染/处理的能力                                        | 例如 `approvals`、`inline-widgets`、`tool-events`；不声明就不应渲染依赖它的体验。                   |
| `commands`、`permissions`、`pathEnv` | node 可被 Agent 调用的命令、实时权限和环境能力                 | 仅 node 使用；必须由设备实际权限和可执行能力动态生成。                                              |
| `device`                             | Ed25519 身份、公钥签名、challenge nonce                        | 用于可信设备配对和 device token，不能用固定 ID 或跳过 nonce 签名。                                  |
| `auth`                               | shared token/password、bootstrap token 或已配对的 device token | 首连和后续连接的认证材料不同，不能把长期 token 暴露给 WebView/日志。                                |

客户端标识和能力的封闭注册表在 `packages/gateway-protocol/src/client-info.ts`。现有标识包括 `openclaw-control-ui`、`openclaw-macos`、`openclaw-ios`、`openclaw-android`、`openclaw-linux`、`openclaw-tui`、`cli`、`node-host` 等。它意味着“换一个字符串”不是完成新端接入；需要协议、Gateway 认证/策略、诊断和测试一起演进。

### 1.3 认证、配对与连接恢复：所有端共用但实现不同

认证在设备配对之前发生。通过 shared token/password、Tailscale 或受信代理身份完成 Gateway 认证后，新设备通常仍要人工批准。批准后 Gateway 发放设备级 token；客户端按“Gateway origin + 设备身份 + role”保存它，后续优先使用该 token。

共同安全边界：

- 不把 shared token 写入聊天 URL、普通 localStorage、WebView JS 或日志。
- 设备 token 必须按 Gateway origin 隔离；Control UI 使用 `gatewayOriginScope`，TUI 按同一 origin 查本地设备凭据。
- `wss://` 远端连接要处理 TLS 校验/指纹绑定；移动端和 Linux 原生端都将非 loopback 远端默认视为 TLS 路径。
- 设备的 role、scope、公钥或身份元数据改变时，视为权限升级并重新等待批准，不能静默继承旧授权。
- 无法认证、待配对、scope 不足、device token 失配都是不同的可恢复状态。应读取结构化错误 details，而非仅解析英文错误文本。

连接不是“一次请求”。参考实现 `packages/gateway-client/src/protocol-client.ts` 管理 challenge 超时、pending request、event 顺序间隙、重连退避与回调生命周期。Swift 的 `GatewayChannelActor` 和 Linux 的 `gateway_ws.rs` 分别自行实现相同责任；这正是跨语言客户端的主要重复成本。

## 2. 各客户端的相同点与差异

### 2.1 总览

| 客户端            | 主要技术与入口                                                           | 连接角色                                           | 通信实现                                                        | 额外职责 / 与其他端的关键差异                                                         |
| ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Control UI（Web） | Vite + Lit；`ui/src/main.ts`                                             | `operator`                                         | `GatewayBrowserClient`，封装 `@openclaw/gateway-client/browser` | 同源页面/WS、浏览器身份与 tab 级 token 存储、路由与完整控制面。                       |
| macOS App         | Swift/SwiftUI；`apps/macos/Sources/OpenClaw/GatewayConnection.swift`     | 独立 `operator` + `node`                           | 共享 Swift `GatewayChannelActor` / `GatewayNodeSession`         | 管理本机 Gateway 进程、Keychain/TLS、原生菜单/Canvas/语音，并把 Mac 能力注册成 node。 |
| iOS App           | SwiftUI；`apps/ios/Sources/Gateway/GatewayConnectionController.swift`    | `operator` + `node`                                | 复用 `apps/shared/OpenClawKit`                                  | 移动配对、push、前后台限制、系统权限、聊天/语音/设备能力。                            |
| Android App       | Kotlin/Compose；`gateway/GatewaySession.kt`、`node/ConnectionManager.kt` | `operator` + `node`                                | Kotlin 自实现协议与 WebSocket                                   | 发现、TLS、前台服务、Android permission 快照、`node.invoke` dispatcher。              |
| Linux Desktop     | Tauri（Rust + WebView）；`apps/linux/src-tauri/src/gateway_ws.rs`        | native Quick Chat 为 `operator`；CLI node 另行接入 | Rust 自实现握手、Ed25519、TLS pin                               | 主窗口优先承载 Gateway Control UI；Quick Chat 使用 native WS，避免凭据进入 WebView。  |
| TUI / CLI         | TypeScript；`src/tui/gateway-chat.ts`、`src/cli/gateway-rpc.runtime.ts`  | `operator`                                         | Node `GatewayClient`                                            | 脚本/终端交互；`tui --local` 是例外，直接运行内嵌 Agent，不经过 Gateway。             |

### 2.2 共同部分：不是复制 UI，而是复用同一“连接状态机”

尽管语言不同，成熟客户端都包含相同的逻辑层：

1. **Endpoint 解析**：本机默认地址、远端配置/QR、Bonjour 发现或 URL 手工输入。
2. **安全连接准备**：远端 TLS、可选证书指纹、shared credential 与已有 device token 的选择。
3. **Challenge 与 signed device**：收到 nonce 后签名，再发 `connect`；不能预生成旧 nonce 的 payload。
4. **hello admission**：检查协议版本、保存服务端 methods/events、持久化新 device token、以 `snapshot` 初始化 UI。
5. **RPC multiplexer**：按 request id 等待 `res`，给每个请求设超时；业务方法不直接读 socket。
6. **event projection**：以 event 更新聊天流、审批、session、node 调用等状态；检测 `seq` 间断后应刷新权威数据而非盲目拼接缓存。
7. **断线生命周期**：可重试的网络错误指数退避；认证/配对/权限类错误暂停无意义重连，并给用户精确下一步。

这也是为何 Web 端可直接复用 `packages/gateway-client`，而 Swift、Kotlin、Rust 原生端各自拥有 Transport/Channel/Session：JavaScript 包不能直接被它们调用，但协议职责必须等价。

### 2.3 Web Control UI：标准 operator 控制面

Web UI 是最完整的 operator 参考实现：

- `ui/src/api/gateway-browser-socket.ts` 适配浏览器 `WebSocket` 到共享客户端；它处理浏览器连接阶段超时和浏览器不接受 1008 close code 的差异。
- `ui/src/app/gateway-store.ts` 是 UI 与 transport 的边界：维护 `stopped/connecting/connected/reconnecting/offline`，统一派发 events、记录连接状态并在首次 hello 后启用 Canvas surface lease。
- `ui/src/app/settings.ts` 按 Gateway origin 保存设置、session 选择和 token；token 是 session storage，而非可跨站复用的全局值。
- 生产环境页面与 WS 同源（Gateway 服务 `dist/control-ui`）；Vite 开发服务器只托管静态资源，WS 仍直连 Gateway。开发端跨 origin 时需要让 Gateway 的 `gateway.controlUi.allowedOrigins` 显式允许开发页面 origin。

适合二开：管理控制台、浏览器聊天、会话工作台、已有 Control UI 的插件 tab/widget。若业务只需 UI，不应重写 WebSocket 客户端，优先在 `ui/` 增页并复用既有 store/API。

### 2.4 原生 App：同一产品里常有两条连接

macOS 代码最能说明这一点：

- `GatewayConnection.swift` 创建 `role: "operator"`、`clientId: "openclaw-macos"`、`clientMode: "ui"` 的连接，用于配置、聊天、会话和审批。
- `NodeMode/MacNodeModeCoordinator.swift` 创建另一条 `role: "node"`、`clientMode: "node"` 连接，并在握手中携带当前可用 `caps`、`commands`、`permissions`。Gateway 可以通过它反向调用 Mac 的系统能力。

iOS 复用 `apps/shared/OpenClawKit` 的 `GatewayChannelActor`、`GatewayNodeSession`、`GatewayConnectOptions` 和 `OpenClawProtocol`。Android 则在 `ConnectionManager.kt` 根据运行时权限构造命令/能力，并将协议类型生成到 `GatewayProtocol.kt`。两者的产品差异来自操作系统：权限弹窗、前后台、Push、相机、位置、音频和文件授权，而不是 Gateway RPC 的不同版本。

### 2.5 Linux Desktop 与 TUI：值得注意的“非完全对称”

- Linux app 的主要 dashboard 是 Gateway 已服务的 Control UI；它增加 Rust native Quick Chat。Quick Chat 保持自己的 device identity 与 token，明确不把 WebSocket 或凭据交给 WebView。这是一条可借鉴的安全分层：网页负责呈现，原生进程负责敏感连接。
- TUI/CLI 是 operator 的 TypeScript 参考。`GatewayChatClient` 显式请求 `operator.admin/read/write/approvals` 和 tool/approval capabilities，适合参考 RPC 调用和事件消费；但最小化新端权限时不应照抄其全权限 scope 集。
- `openclaw tui --local` / `openclaw chat` 的本地嵌入模式绕过 Gateway，是开发和单机工具的特殊路径；不能拿它证明一个远程客户端的接入方案。

## 3. 接入新客户端：推荐决策与配置

### 3.1 先选路径

| 需求                                          | 推荐路径                                                                  | 不建议                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| 只是改变页面、增加管理功能                    | 扩展 `ui/`，复用 `GatewayBrowserClient` 和 gateway store                  | 另写一套 WS 协议与认证。                                 |
| 在 Electron/Tauri/原生壳中展示既有管理台      | 加载 Gateway Control UI；敏感认证放 native host                           | 让 WebView 长期持有 shared token。                       |
| 新的聊天客户端（桌面/移动/终端）              | 做 operator-only 客户端，参考 gateway-client 或现有原生 transport         | 首版同时实现 node、Canvas、Talk、全部设置。              |
| 让 Agent 调用新硬件/OS 能力                   | 在已有客户端或新原生客户端增加 node role                                  | 把设备命令做成 operator RPC 或直接让浏览器执行系统操作。 |
| 全新客户端类型要被 Gateway 识别、展示与策略化 | 扩展 `GATEWAY_CLIENT_IDS` + schema + server admission + 各语言生成物/测试 | 发送未注册 client id；schema 会拒绝。                    |

### 3.2 Gateway 侧前置配置

1. 启动并验证 Gateway：`pnpm gateway:watch`，再执行 `pnpm openclaw health`。默认本机地址是 `ws://127.0.0.1:18789`；生产/远端优先 HTTPS/WSS。
2. 选择认证方式并安全提供首次凭据。shared token/password 用于首次入站认证；后续用 Gateway 签发的 device token。不要把 token 写进仓库、深链、截图或日志。
3. 为首台测试设备完成配对：Control UI 的 Devices 页面或 `openclaw devices list` / `openclaw devices approve <requestId>`。用不同 role 或更高 scopes 再连时，要预期产生新的 approval request。
4. 若浏览器开发服务器与 Gateway 不同源，配置 `gateway.controlUi.allowedOrigins`；这是浏览器 Origin 策略，不是给 native app 放行的万能开关。
5. 远端设备使用 TLS 与受控网络暴露（例如 tailnet）；移动/原生端要保存并验证 TLS 指纹。不要为开发便利把 Gateway 绑定到公网或关闭 auth。
6. node 还需要两层授权：设备配对仅允许设备连接；其实际 caps/commands 的扩展还需要 Gateway 的节点命令与审批策略允许。设备“已连接”不代表 Agent 已可调用任何系统命令。

### 3.3 新 operator 客户端的最小实现清单

推荐先只实现聊天闭环，按以下顺序推进：

1. **Endpoint 与安全存储**：支持本机 `ws://127.0.0.1:18789` 和一个明确的远端 `wss://` endpoint；token、password、device identity、device token 分开保存。桌面/移动端用 Keychain/Keystore；浏览器用现有 browser-device-auth 方案。
2. **协议层**：实现 challenge、`connect`、request-id pending map、`req/res/event` JSON codec、ping/pong、request timeout、重连退避。优先直接使用 `@openclaw/gateway-client`（TS），其他语言以 Swift/Rust/Kotlin 端为对照。
3. **最小握手**：`role: "operator"`；选一个已有 `client.id`（仅在明确是该官方表面时）或先完成协议注册；申请 `operator.read` + `operator.write`，只有要审批时才加入 `operator.approvals`，绝不因“方便”申请 `operator.admin`。
4. **首屏**：校验 `hello-ok.protocol`、读取 `features.methods`、用 `snapshot` 初始化 session/agent；功能入口按 methods、scopes、caps 进行 gating。
5. **聊天闭环**：调用 `chat.history` 加载历史、`chat.send` 发送、订阅 session/run 相关 event 做流式渲染，并实现 abort、失败和重连后的权威刷新。
6. **可恢复 UX**：分别显示“Gateway 不可达”“缺首次凭据”“等待配对审批”“缺 scope”“TLS trust failed”“客户端/服务端版本不兼容”；不要只显示“连接失败”。
7. **验证**：先用本地 Gateway 做首次配对、重启后 device-token 重连、撤销 token、网络断开/恢复、权限提升、服务端缺少某 RPC、超大附件与 event seq 间隙测试。

### 3.4 新 node 客户端（第二阶段）从哪些功能点入手

node 的任务不是主动代替用户聊天，而是可信地执行 Gateway 转发的设备动作。最小安全范围建议只做一个低风险能力，例如“本机通知”或“读取设备状态”。

1. **独立 node 会话**：使用 `role: "node"`、`mode: "node"`，不要复用 operator session 的 scopes 或凭据状态；node 最低协议版本规则与普通 operator 不同。
2. **能力清单生成器**：从真实的 OS 授权、功能开关与依赖可用性生成 `caps`、`commands`、`permissions`。Android 的 `ConnectionManager.buildInvokeCommands/buildCapabilities` 是直接参考。
3. **调用分发器**：处理 `node.invoke`，严格按白名单将 command 映射到系统 API；校验 payload、超时、取消与 idempotency key，并以 `node.invoke.result` 回传结构化成功/失败。
4. **人工和平台闸门**：把 OS 权限、危险动作确认、Gateway command allowlist 分层处理。缺权限时返回可行动的错误，不能假装成功，也不能由 node 自行提升系统权限。
5. **连接与状态恢复**：设备进入后台、权限变化、网络切换、App 被杀掉时要撤销过期 route，重连后重新发布 inventory；不要继续向旧 socket 回传 invoke result。
6. **最小测试矩阵**：未配对、已配对但 command 未批准、OS 权限拒绝、invoke 超时/取消、网络切换重连、重复 idempotency key、Gateway 重启中的调用。

## 4. 可复用源码地图

| 你要解决的问题               | 首先阅读                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议信封、hello、版本        | `packages/gateway-protocol/src/schema/frames.ts`、`packages/gateway-protocol/src/version.ts`、`packages/gateway-protocol/src/client-info.ts` |
| TypeScript 新客户端          | `packages/gateway-client/src/protocol-client.ts`、`packages/gateway-client/src/connect-auth.ts`、`packages/gateway-client/src/browser.ts`    |
| 浏览器 Control UI            | `ui/src/api/gateway-browser-socket.ts`、`ui/src/app/gateway-store.ts`、`ui/src/app/settings.ts`                                              |
| Swift / Apple 平台 transport | `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift`、`GatewayConnectOptions.swift`、`GatewayNodeSession.swift`                |
| macOS 的 operator/node 分离  | `apps/macos/Sources/OpenClaw/GatewayConnection.swift`、`apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift`                   |
| Android 接入与设备能力       | `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt`、`node/ConnectionManager.kt`、`node/InvokeDispatcher.kt`          |
| Linux 原生安全连接           | `apps/linux/src-tauri/src/gateway_ws.rs`、`gateway_device_identity.rs`                                                                       |
| CLI/TUI operator RPC 用法    | `src/tui/gateway-chat.ts`、`src/cli/gateway-rpc.runtime.ts`                                                                                  |
| Gateway 配对与部署配置       | `docs/web/control-ui.md`、`docs/gateway/pairing.md`、`docs/gateway/protocol.md`、`src/config/types.gateway.ts`                               |

## 5. MVP 边界、指标与主要风险

### 推荐 MVP

一个可展示、可验证的新端 MVP 应限制为：一台 Gateway、一个 operator 身份、设备配对、会话选择、文本聊天流式回复、断线重连、清晰错误状态。暂不做 node、插件安装、配置编辑、Talk、Canvas、后台自动化和多 Gateway 切换。

### 建议验收指标

| 维度           | 可验证指标                                                                    |
| -------------- | ----------------------------------------------------------------------------- |
| 连通性         | 首连认证→配对→重启后 device token 重连均成功；失败状态可区分。                |
| 兼容性         | hello 协议协商与 methods gating 正确；低版本/缺方法不崩溃。                   |
| 会话正确性     | 发送、流式 event、最终消息、abort、重连后历史刷新不重复/不丢失。              |
| 安全           | 凭据不进入 URL/日志/WebView；scope 最小化；TLS 失败不可静默绕过。             |
| node（如实现） | command 未获 Gateway 批准或 OS 未授权时，Agent 获得明确失败结果，动作未执行。 |

### 主要风险与待确认项

- **已知事实**：官方原生端维护多套协议实现；协议 schema 是封闭的，client id 和 payload 不能自由扩展。
- **主要风险**：为了快速演示而复制 shared token、绕过 device pairing 或申请 `operator.admin`，会得到“能跑但不可交付”的客户端。
- **主要风险**：把 operator 与 node 合并，会让一次 UI 连接同时拥有管理面与系统调用面，难以做权限、崩溃恢复和审计隔离。
- **待确认项**：你计划接入的是浏览器、桌面、移动还是硬件设备？目标是控制 Gateway、聊天，还是让 Agent 操作设备？这会决定应扩展 Control UI、写 operator 客户端，还是开发 node。
- **待确认项**：如果要新增一个全新的产品级 client id，需要先确认维护者是否接受 Gateway 公共协议扩展；这不是单端应用内可完成的改动。

## 下一步建议

如果目标是作品集或二次开发验证，优先做“独立轻量 operator Chat 客户端”：完成 QR/URL 配对、`chat.history`/`chat.send`/事件流和错误恢复即可。它能完整展示你对 Agent 产品中连接、权限、流式交互与失败可见性的理解；待该闭环稳定后，再选一个低风险 node 能力（如通知）做第二阶段增量。
