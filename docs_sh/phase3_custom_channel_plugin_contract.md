# Phase 3：自定义 Channel 插件接口与接入规范

> 目标：说明如何把一个新的消息平台接入 OpenClaw，使平台入站消息能够安全、稳定地进入 Agent 会话，并让 Agent 回复通过该平台正确送达。
>
> 分析依据：当前仓库 `2026.8.1` 源码、公开 Plugin SDK、现有 Channel 插件和消息生命周期文档。本文只使用第三方插件可访问的 `openclaw/plugin-sdk/*` 边界，不把 `src/channels/**` 私有实现当作插件 API。

## 结论

OpenClaw 的 Channel 不是 Gateway WebSocket 客户端，也不是简单的双向 `send/receive` 函数。它是运行在 Gateway 进程中的消息平台插件，通过统一的 `ChannelPlugin` 契约接入系统。

一个可用的自定义 Channel 至少要实现四层接口：

```text
控制面：manifest + package metadata + ChannelPlugin
                             │
运行面：gateway.startAccount / stopAccount
                             │
入站面：平台事件 → 安全/路由/上下文 facts → Agent turn
                             │
出站面：ReplyPayload → 平台 API → MessageReceipt
```

核心职责边界：

| OpenClaw Core 负责                                                                              | Channel 插件负责                                                                                     |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Agent 调度、模型与工具、会话持久化、共享 `message` tool、外层 session key、队列与通用回复流水线 | 平台连接、账号配置、原始事件解析、平台身份、DM/群组安全、目标语法、媒体下载、平台 API 调用与 receipt |
| 通用路由、Agent 绑定、回复 payload、durable intent、生命周期记录                                | 把平台事实准确映射到公共 inbound contract；把公共 outbound contract 准确映射到平台能力               |
| 通用审批、命令、typing 生命周期和可见结果判断                                                   | 仅在平台存在原生差异时实现对应 adapter，不复制 Core 的产品规则                                       |

后续自定义 Channel 应从外部插件开始，通过 `defineChannelPluginEntry`/`createChatChannelPlugin` 和 `openclaw/plugin-sdk/*` 接入。禁止从插件生产代码直接 import `src/**`、`src/channels/**` 或另一个插件的 `src/**`。

## 1. 开发前的接入判断

仓库已经包含大量 bundled 和外部 Channel。开发前先检查 `docs/channels/index.md`、`extensions/` 和 ClawHub 是否已有维护中的实现。如果已有插件能满足协议、权限和部署要求，应优先复用或扩展它；只有不存在、不可维护、不安全或平台协议明显不同，才新增 Channel。

新增 Channel 通常属于以下一种传输模式：

| 传输模式          | 入站形式                   | ack 特点                                  | 示例                           |
| ----------------- | -------------------------- | ----------------------------------------- | ------------------------------ |
| Webhook           | 平台 HTTP 回调             | durable append 成功后才能返回成功         | Slack、LINE、SMS、Zalo webhook |
| Polling / stream  | 拉取更新或长连接事件       | durable append 后再推进 cursor/ack        | Telegram polling、Signal、Tlon |
| Non-replay socket | 平台 socket 事件且无法重放 | durable queue 只能覆盖本进程 crash window | IRC、Mattermost、Twitch        |

这个分类会决定入站 ack policy、重试与去重设计，不能等功能完成后再补。

## 2. Channel 的统一根接口

公共根类型定义在 `src/channels/plugins/types.plugin.ts`，插件侧通过 `openclaw/plugin-sdk/channel-core` 使用。

```ts
export type ChannelPlugin<ResolvedAccount, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<ResolvedAccount>;

  configSchema?: ChannelConfigSchema;
  setupContract?: ChannelOwnedSetupContract;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  pairing?: ChannelPairingAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  message?: ChannelMessageAdapterShape;
  outbound?: ChannelOutboundAdapter;
  messaging?: ChannelMessagingAdapter;

  // 其余均为按平台能力选配的 adapters
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  threading?: ChannelThreadingAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  commands?: ChannelCommandAdapter;
  lifecycle?: ChannelLifecycleAdapter;
  secrets?: ChannelSecretsAdapter;
  doctor?: ChannelDoctorAdapter;
};
```

`ChannelPlugin` 是组合契约，不要求所有 adapter 都实现。最小聊天 Channel 通常需要：

- 必需：`id`、`meta`、`capabilities`、`config`；
- 启动与接收：`gateway.startAccount`；
- 安全：`security`，以及默认 pairing/allowlist 体验所需的 `pairing`；
- 发送：现代 `message` adapter；为当前通用 reply pipeline 通常同时提供 `outbound` adapter；
- 目标路由：`messaging`；
- 可观测：`status`。

### 2.1 `id` 与 `meta`

`id` 必须和 manifest 的 `id`、`channels[]`、package metadata 的 channel id 一致。`meta` 用于设置页、选择器、文档和别名解析：

| 字段                       | 作用                         | 要求                                   |
| -------------------------- | ---------------------------- | -------------------------------------- |
| `id`                       | 稳定 Channel 标识            | 小写且长期不变；不要绑定可变品牌文案。 |
| `label` / `selectionLabel` | UI 展示                      | 面向用户，不参与运行时策略。           |
| `docsPath` / `docsLabel`   | 文档入口                     | 新正式 Channel 需补对应文档。          |
| `blurb`                    | 一句话能力说明               | 说明传输/产品，而不是营销文案。        |
| `aliases`                  | 目标前缀别名                 | 必须避免与其他 Channel 冲突。          |
| `quickstartAllowFrom`      | setup 是否快速配置 allowlist | 只有能可靠获得用户 ID 时启用。         |

### 2.2 `capabilities`

`capabilities` 是平台原生能力声明，不是愿望清单：

```ts
type ChannelCapabilities = {
  chatTypes: Array<"direct" | "group" | "channel" | "thread">;
  polls?: boolean;
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  effects?: boolean;
  groupManagement?: boolean;
  threads?: boolean;
  media?: boolean;
  tts?: {
    voice?: {
      synthesisTarget: "audio-file" | "voice-note";
      transcodesAudio?: boolean;
      audioFileFormats?: readonly string[];
      captionedFinalText?: boolean;
      preferAudioFileFormat?: "caf";
    };
  };
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};
```

Core 会根据这些字段决定是否暴露功能和如何构造回复。声明 `threads: true` 却不能稳定映射 thread id，会导致会话串线；声明 `media: true` 却没有可验证的媒体发送路径，会造成最终回复丢失。

## 3. 插件包与注册接口

### 3.1 最小目录

```text
openclaw-channel-acme/
├── package.json
├── openclaw.plugin.json
├── index.ts
├── channel.ts
├── accounts.ts
├── config-schema.ts
├── runtime.ts
├── inbound.ts
├── send.ts
└── channel.test.ts
```

外部插件运行依赖属于本插件 package。`package.json` 必须声明 OpenClaw extension entry 和兼容范围；`openclaw.plugin.json` 必须能在不执行插件代码时提供 discovery/config 元数据。

```json
{
  "id": "acme-chat",
  "name": "Acme Chat",
  "description": "Acme Chat channel plugin.",
  "channels": ["acme-chat"],
  "activation": { "onStartup": false },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

`package.json` 至少要声明插件入口与 host/API 兼容范围，例如：

```json
{
  "name": "@your-scope/openclaw-channel-acme",
  "type": "module",
  "peerDependencies": {
    "openclaw": ">=2026.8.1"
  },
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "acme-chat",
      "label": "Acme Chat",
      "selectionLabel": "Acme Chat",
      "docsPath": "/channels/acme-chat",
      "blurb": "Acme Chat messaging channel."
    },
    "compat": {
      "pluginApi": ">=2026.8.1"
    }
  }
}
```

实际发布时应把兼容下限设为插件已经验证过的最低 OpenClaw 版本，不能机械复制示例版本。

Channel scaffolding 目前不是 `openclaw plugins init --type channel` 的内置类型；当前 CLI scaffold 只支持 tool/provider。因此应参考 `docs/plugins/sdk-channel-plugins.md` 和一个结构相近的现有 Channel 手工建立包，不要用 tool scaffold 后只修改名称。

### 3.2 Entry 注册

外部 Channel 推荐使用 `defineChannelPluginEntry`：

```ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { acmeChannelPlugin } from "./channel.js";
import { setAcmeRuntime } from "./runtime.js";

export default defineChannelPluginEntry({
  id: "acme-chat",
  name: "Acme Chat",
  description: "Acme Chat channel plugin.",
  plugin: acmeChannelPlugin,
  setRuntime: setAcmeRuntime,
});
```

`defineChannelPluginEntry` 会调用 `api.registerChannel({ plugin })`，并按 registration mode 控制运行时加载：

| Mode             | 允许的行为                                                 |
| ---------------- | ---------------------------------------------------------- |
| `full`           | 正常 Gateway 启动；注册 Channel 并运行完整 runtime。       |
| `discovery`      | 构建只读能力快照；不得启动 socket、worker、client 或服务。 |
| `setup-only`     | disabled/unconfigured Channel 的轻量 setup surface。       |
| `setup-runtime`  | 只启动 setup 必需的受限 runtime。                          |
| `cli-metadata`   | 只登记 CLI metadata。                                      |
| `tool-discovery` | 只登记 tools/capabilities，不激活 Channel。                |

所有模块顶层必须无副作用。网络连接、定时器、Webhook server、poll loop 只能从 `full` 模式的账号启动路径创建。

## 4. 配置与账号接口规范

### 4.1 `ChannelConfigAdapter`

`config` 将统一的 `OpenClawConfig` 解析为 Channel 自己的 `ResolvedAccount`。必需方法：

```ts
type ChannelConfigAdapter<ResolvedAccount> = {
  listAccountIds(cfg): string[];
  resolveAccount(cfg, accountId?): ResolvedAccount;
  // 以下按需实现
  defaultAccountId?(cfg): string;
  isEnabled?(account, cfg): boolean;
  isConfigured?(account, cfg): boolean | Promise<boolean>;
  describeAccount?(account, cfg): ChannelAccountSnapshot;
  resolveAllowFrom?({ cfg, accountId }): Array<string | number> | undefined;
  setAccountEnabled?(...): OpenClawConfig;
  deleteAccount?(...): OpenClawConfig;
};
```

设计要求：

- 所有 token、endpoint、proxy、webhook、DM/group policy 都在 `resolveAccount` 归一化；runtime 不应重复解析 raw config。
- 默认账号 ID 使用共享 `DEFAULT_ACCOUNT_ID` 语义。
- `isConfigured` 只表达凭据/必需设置是否存在，不代表网络已连接。
- `describeAccount` 不返回明文 secret，只返回来源与状态，例如 `tokenSource`、`tokenStatus`。
- 多账号 Channel 的 runtime、队列、状态与 credential 必须按 `accountId` 隔离。
- 仅当 sibling account 解析和 stop/start 生命周期完全隔离且有契约测试时，才声明 `reload.accountScopedRestart: true`。

### 4.2 `configSchema`、setup 与 secrets

- 使用严格 schema，未知字段拒绝；敏感字段标记为 sensitive。
- 新插件使用 `setupContract`，不要从 deprecated `setup` 开始。
- SecretRef 支持必须通过 `secrets.secretTargetRegistryEntries` 与 runtime assignment 契约声明；不支持的 SecretRef surface 要明确报告。
- runtime 日志不得打印 token、签名 secret、完整 webhook body 或 Authorization header。

## 5. Gateway 账号生命周期接口

`gateway.startAccount` 是 Channel 的运行时入口：

```ts
type ChannelGatewayContext<ResolvedAccount> = {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  getStatus(): ChannelAccountSnapshot;
  setStatus(next: ChannelAccountSnapshot): void;
  channelRuntime?: ChannelRuntimeSurface;
};
```

```ts
type ChannelGatewayAdapter<ResolvedAccount> = {
  startAccount?(ctx): Promise<unknown>;
  stopAccount?(ctx): Promise<void>;
};
```

`startAccount` 应完成：

1. 使用已经解析的 `ctx.account`，不重新读取磁盘配置；
2. 进行轻量 probe，区分 auth/config 错误和暂时网络错误；
3. 启动 webhook/poll/socket monitor；
4. 绑定 `ctx.abortSignal`，保证 Gateway stop/reload 能终止所有任务；
5. 通过 `setStatus` 更新 lifecycle、connected、lastInboundAt、lastOutboundAt、lastError；
6. 返回可由宿主跟踪的长生命周期任务或资源。

停止顺序必须是：停止接收入站事件 → 等待已接受 admission settle → 停止并等待 durable drain → 释放平台连接/HTTP route。否则 config reload 期间可能丢消息或重复 dispatch。

建议状态语义：

| `lifecycle`  | 含义                                        |
| ------------ | ------------------------------------------- |
| `starting`   | 正在认证/建立连接，尚不能稳定接收。         |
| `ready`      | 正常接收入站并可发送。                      |
| `recovering` | 临时网络/限流故障，后台正在恢复。           |
| `blocked`    | auth/config/permission 错误，必须人为修复。 |
| `stopped`    | 已有意停止，资源完成清理。                  |

## 6. 入站接口规范：平台消息如何进入 Agent

### 6.1 入站统一链路

```text
平台 webhook / poll / socket event
  → 验签、解析、稳定 eventId
  → durable ingress append / ack policy
  → 账号、sender、conversation、thread 归一化
  → DM/group policy、allowlist、mention、command 授权
  → resolve agent route + session envelope
  → buildChannelInboundEventContext(...facts)
  → runChannelInboundEvent / dispatchChannelInboundTurn
  → Core Agent run
  → outbound reply pipeline
```

原始平台 event 没有一个跨平台统一类型；插件拥有原始 payload。真正统一的输入边界是插件把它转换成 `BuildChannelInboundEventContextParams` 的事实对象。

### 6.2 规范化 facts

公共入口来自 `openclaw/plugin-sdk/channel-inbound`：

```ts
// 为突出传输对接而省略了少量高级字段的注释，字段名与源码保持一致。
type BuildChannelInboundEventContextParams = {
  channel: string;
  accountId?: string;
  provider?: string;
  surface?: string;
  messageId?: string;
  messageIdFull?: string;
  timestamp?: number;
  from: string;
  sender: SenderFacts;
  conversation: ConversationFacts;
  route: RouteFacts;
  reply: ReplyPlanFacts;
  message: MessageFacts;
  sessionTranscript?: SessionTranscriptContext;
  access?: BuildChannelInboundEventAccess;
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  media?: InboundMediaFacts[];
  supplemental?: ChannelInboundSupplementalFacts;
  channelContext?: PluginHookChannelContext;
  contextVisibility?: ContextVisibilityMode;
  finalize?: FinalizeInboundContextFn;
  finalizeOptions?: FinalizeInboundContextOptions;
  extra?: Record<string, unknown>;
};
```

各字段的规范：

| 区域             | 必需事实                                               | 约束                                                                         |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Message identity | `messageId`、`timestamp`                               | 用平台稳定 ID；Webhook retry 必须得到同一 event/message key。                |
| Sender           | `sender.id/name/username/isBot/isSelf`                 | `id` 使用平台不可变 ID，不用昵称做授权。                                     |
| Conversation     | `kind/id/threadId/parentId/routePeer`                  | `id` 是稳定 base conversation；thread 单独表达，不能拼接后再丢失解析规则。   |
| Route            | `agentId/routeSessionKey/accountId`                    | 通过公共 route resolver 生成；不要在插件内自创外层 session-key grammar。     |
| Reply plan       | `to/replyToId/messageThreadId/sourceReplyDeliveryMode` | 明确回复发往哪里；避免从 inbound raw payload 在出站时重新猜。                |
| Message          | `rawBody/bodyForAgent/commandBody/inboundEventKind`    | 原文、Agent 可见文本、命令文本分开；不要把 transport metadata 混入用户正文。 |
| Access           | command、mention、tool policy                          | 授权必须在可信 ingress 边界形成事实；模型不能替代授权。                      |
| Media            | 有序 `InboundMediaFacts[]`                             | 用 `toInboundMediaFacts(...)`；顺序必须与平台消息一致。                      |
| Supplemental     | quote/forwarded/thread context                         | 按 `contextVisibility` 过滤；不可把未授权参与者内容注入 prompt。             |

`buildChannelInboundEventContext` 输出最终 `BuiltChannelInboundEventContext`，包括 `Body`、`BodyForAgent`、`BodyForCommands`、`ChatType`、`CommandAuthorized`、`SessionKey`、`From`、`To` 和 `InboundEventKind`。插件不应手工拼装这些旧式大写字段。

### 6.3 安全与 admission

入站消息进入 Agent 前必须按顺序处理：

1. 验证平台 webhook 签名或 socket/polling 身份；
2. 丢弃自身 echo、明确的机器人环路与过期事件；
3. 解析账号、sender、conversation 和 target；
4. 执行 DM policy（`pairing | allowlist | open | disabled`）与 group policy；
5. 判断 mention gate；
6. 独立判断 command authorization；普通文本可进入 Agent 不代表 `/config` 等命令获得授权；
7. 决定 admission：`dispatch`、`observeOnly`、`handled` 或 `drop`；
8. 只有 `dispatch` 才启动 Agent turn。

Channel 不应自行复制 Core 的 Agent timeout。消息进入 session queue 后，Agent、tool 和 runtime lifecycle 统一拥有长运行任务。

### 6.4 durable ingress 与 ack

现代 Channel 推荐使用 `createChannelIngressMonitor`，在单一 receive chokepoint 把原始 transport envelope 写入 durable queue。队列主键是 `(queue_name, event_id)`；完成后保留 tombstone，避免平台重投再次 dispatch。

`message.receive` 可声明：

```ts
type ChannelMessageReceiveAckPolicy =
  "after_receive_record" | "after_agent_dispatch" | "after_durable_send" | "manual";
```

| Policy                 | 何时对平台 ack                    | 适用情况                                   |
| ---------------------- | --------------------------------- | ------------------------------------------ |
| `after_receive_record` | 入站已持久化，可安全去重/恢复     | 多数要求快速返回的 webhook。               |
| `after_agent_dispatch` | Agent run 已成功提交              | 平台允许较长 ack 窗口且必须保证 dispatch。 |
| `after_durable_send`   | 最终出站 intent 已 durable commit | 平台 ack 窗口足够且需要端到端保障。        |
| `manual`               | 插件显式控制                      | 只有平台协议不能映射到前三者时使用。       |

Webhook durable append 失败时不能返回成功；poll/stream 不能推进 cursor；non-replay socket 则只能记录失败并提供本地恢复/可观测结果。

## 7. 出站接口规范：Agent 回复如何发送到平台

### 7.1 推荐 `message` adapter

现代统一接口来自 `openclaw/plugin-sdk/channel-outbound`：

```ts
const adapter = defineChannelMessageAdapter({
  id: "acme-chat",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: sendAcmeText,
    media: sendAcmeMedia,
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});
```

声明能力必须有对应实现与 contract proof。不要声明 `media/thread/replyTo` 后在 send 函数里静默忽略。

### 7.2 发送输入

最基本的 text context：

```ts
type ChannelMessageSendTextContext = {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
  signal?: AbortSignal;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: (result) => Promise<void> | void;
};
```

媒体 context 在此基础上增加 `mediaUrl`、`mediaAccess`、`mediaLocalRoots`、`mediaReadFile`、`audioAsVoice`、`gifPlayback`、`forceDocument`。插件必须通过提供的授权 media loader 访问本地内容，不能任意读取宿主文件路径。

发送函数应：

1. 解析已经规范化的 `to/accountId/threadId/replyToId`；
2. 在真正的平台可见 I/O 前调用 `onPlatformSendDispatch`（如果提供）；
3. 尊重 `AbortSignal`；
4. 调用平台 SDK/API；
5. 每个成功的 sub-send 立即通过 `onDeliveryResult` 报告（如果提供）；
6. 返回统一 `ChannelMessageSendResult`；
7. 对 auth、permission、rate-limit、invalid payload、not found 等错误保留可分类信息，不吞错或返回伪成功。

### 7.3 标准输出 `MessageReceipt`

```ts
type ChannelMessageSendResult = {
  receipt: MessageReceipt;
  messageId?: string;
};

type MessageReceipt = {
  primaryPlatformMessageId?: string;
  platformMessageIds: string[];
  parts: Array<{
    platformMessageId: string;
    kind: "text" | "media" | "voice" | "poll" | "card" | "preview" | "unknown";
    index: number;
    threadId?: string;
    replyToId?: string;
    raw?: MessageReceiptSourceResult;
  }>;
  threadId?: string;
  replyToId?: string;
  editToken?: string;
  deleteToken?: string;
  sentAt: number;
  raw?: readonly MessageReceiptSourceResult[];
};
```

Receipt 是 Core 做 threading、edit/finalize、durable commit、恢复和去重的依据：

- chunked text、text+media、card fallback 产生多个平台消息 ID 时，必须全部写入 `parts`；
- `primaryPlatformMessageId` 选择后续 reply/edit 最合适的主消息；
- 平台只返回一个 ID 时，也要构造单 part receipt；
- 不得平台调用失败却返回空 receipt；这会制造静默丢消息；
- 可用 `createMessageReceiptFromOutboundResults(...)` 归一化平台结果。

### 7.4 `outbound` adapter 的作用

`ChannelOutboundAdapter` 仍承载当前共享 reply pipeline 的格式化与通用发送策略：

| 字段                                          | 用途                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `deliveryMode`                                | `direct`、`gateway` 或 `hybrid`，决定发送所有权。普通 API Channel 常用 `direct`。 |
| `textChunkLimit/chunker/chunkerMode`          | 平台长度限制和 Markdown 安全分块。                                                |
| `sanitizeText`                                | 移除平台不能显示的控制内容；不能删除真实用户可见语义。                            |
| `resolveTarget`                               | 校验/规范化出站目标。                                                             |
| `sendText/sendMedia/sendPayload/sendPoll`     | legacy/common pipeline 的平台发送桥。                                             |
| `presentationCapabilities/renderPresentation` | 将便携按钮、select、table 等渲染成平台原生 payload。                              |
| `deliveryCapabilities`                        | 旧 outbound 能力声明；应与现代 `message.durableFinal.capabilities` 保持一致。     |

如果已有正确的 `outbound` send methods，可用 `createChannelMessageAdapterFromOutbound(...)` 推导 `message` adapter，避免维护两套平台 API 调用。新的实现可像 Zalo 一样，让两套 adapter 复用同一 `sendAcmeDelivery` 底层函数。

## 8. 目标、会话与线程接口

`messaging` adapter 负责平台目标语法，不负责 Agent 路由策略：

```ts
messaging: {
  targetPrefixes: ["acme", "ac"],
  normalizeTarget(raw) { /* 移除前缀并返回平台稳定 ID */ },
  targetResolver: {
    looksLikeId(raw) { /* 只做语法判断 */ },
    hint: "<conversationId>",
  },
  resolveSessionConversation(params) { /* base conversation + thread + parents */ },
  resolveOutboundSessionRoute(params) { /* provider-native outbound route */ },
}
```

约束：

- base conversation ID、thread ID 和 parent candidates 必须可逆、稳定；
- `parentConversationCandidates` 从最窄父级排到最宽/base conversation；
- target normalization 只处理语法，不调用网络；需要查用户名/群名时放入 `resolver.resolveTargets`；
- outbound 不应重新解析 inbound raw event，应该消费已经准备好的 `to/threadId/replyToId`；
- 插件需要比较 route 或构造 dedupe key 时使用 `openclaw/plugin-sdk/channel-route`，避免数字/string thread ID 漂移。

## 9. 安全、可靠性与失败边界

### 9.1 必须防住的失败

| 风险                                     | 正确处理                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 未授权 DM 触发 Agent                     | 在 ingress 执行 DM policy/pairing/allowlist；不要把决定交给模型。                                 |
| 群内未 mention 消耗模型                  | 使用共享 mention gating；命令授权与 mention 判断分开。                                            |
| Bot 回复被再次摄入                       | 用平台 self/bot fact + shared outbound echo registry；稳定平台消息 ID 记录到 receipt。            |
| Webhook 重投导致重复 Agent turn          | durable event ID + completion tombstone；必要时额外按 logical message key 去重。                  |
| 平台已发送但进程在 receipt commit 前崩溃 | 状态为 `unknown_after_send`；只有实现 `reconcileUnknownSend` 并能证明 `not_sent` 才允许安全重发。 |
| 部分发送成功                             | 返回/抛出 partial delivery 语义，保留已成功 receipts；不得把整批当作完全失败盲目重试。            |
| Auth/permission 错误无限重试             | status 进入 `blocked`，提示修改配置；只自动重试 transient/rate-limit。                            |
| 配置 reload 丢正在处理的消息             | stop admission → settle → drain dispose/await → 释放连接。                                        |
| 明文 secret 泄漏                         | SecretRef/secret store；日志只记录 source/status；错误信息脱敏。                                  |

### 9.2 durable final 能力

可声明的 final capabilities 包括：`text`、`media`、`poll`、`payload`、`silent`、`replyTo`、`thread`、`nativeQuote`、`messageSendingHooks`、`batch`、`reconcileUnknownSend`、`afterSendSuccess`、`afterCommit`。

它们是 Core 的可靠性交付前提，不是 UI 标签。声明 capability 之前必须使用：

- `verifyChannelMessageAdapterCapabilityProofs(...)`；
- `verifyDurableFinalCapabilityProofs(...)`；
- live preview 则使用 `verifyChannelMessageLiveCapabilityAdapterProofs(...)` 与 `verifyChannelMessageLiveFinalizerProofs(...)`；
- receive ack 使用 `verifyChannelMessageReceiveAckPolicyAdapterProofs(...)`。

## 10. 推荐的最小实现

第一版只做：单账号、DM、纯文本、固定平台 conversation ID、polling 或 webhook 二选一、pairing/allowlist、durable ingress、文本回复和 receipt。

```ts
import {
  buildChannelConfigSchema,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";

const message = defineChannelMessageAdapter({
  id: "acme-chat",
  durableFinal: {
    capabilities: { text: true, messageSendingHooks: true },
  },
  send: {
    text: async (ctx) => {
      const result = await sendAcmeText({
        accountId: ctx.accountId,
        conversationId: ctx.to,
        text: ctx.text,
        signal: ctx.signal,
      });
      return {
        messageId: result.id,
        receipt: {
          primaryPlatformMessageId: result.id,
          platformMessageIds: [result.id],
          parts: [{ platformMessageId: result.id, kind: "text", index: 0 }],
          sentAt: Date.now(),
        },
      };
    },
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});

export const acmeChannelPlugin: ChannelPlugin<ResolvedAcmeAccount> = createChatChannelPlugin({
  base: {
    id: "acme-chat",
    meta,
    capabilities: { chatTypes: ["direct"] },
    configSchema: buildChannelConfigSchema(AcmeConfigSchema),
    config: acmeConfigAdapter,
    gateway: { startAccount: startAcmeAccount },
    status: acmeStatusAdapter,
    messaging: acmeMessagingAdapter,
    message,
    outbound: acmeOutboundAdapter,
  },
  security: { resolveDmPolicy: resolveAcmeDmPolicy },
  pairing: acmePairingAdapter,
});
```

示例中的 `sendAcmeText`、account/config/status/messaging/security adapters 必须由插件实现。入站 `startAcmeAccount` 内应使用 `channel-inbound` 和 durable ingress helper，不要直接调用内部 Agent 函数。

## 11. 开发与验收顺序

### 11.1 实施顺序

1. 建立 manifest、package metadata、entry 与空 ChannelPlugin；
2. 实现严格 config schema 和单账号解析；
3. 实现 `status.probeAccount`，先证明凭据和网络；
4. 实现 outbound text + MessageReceipt，单独验证主动发送；
5. 实现 webhook/poll monitor 和 durable ingress；
6. 实现 sender/conversation facts、DM policy、route 与 inbound context；
7. 打通入站 → Agent → 出站文本闭环；
8. 验证 restart、平台重投、auth 失效、rate-limit 和部分失败；
9. 再增加群组、mention、thread、媒体、typing、reactions、poll、native actions；
10. 更新 `.github/labeler.yml` 和 GitHub labels（新增正式 Channel/插件 surface 的仓库要求）。

### 11.2 最小验收矩阵

| 用例                 | 验收标准                                                             |
| -------------------- | -------------------------------------------------------------------- |
| 未配置账号           | 插件可被 discovery；runtime 不启动；status 明确 `not configured`。   |
| 配置有效             | probe 成功；lifecycle 进入 `ready`；secret 不出现在日志。            |
| 未授权 DM            | 不启动 Agent；返回 pairing 指引或记录 intentional drop。             |
| 已授权文本           | 路由到正确 agent/session；回复发回同一 conversation。                |
| Webhook 重投         | 同一 eventId 只 dispatch 一次。                                      |
| Gateway 在入站后重启 | durable queue 恢复未完成 event，不丢消息。                           |
| 出站成功             | receipt 包含正确平台 message ID、thread/reply 信息。                 |
| 出站限流             | 分类为 retryable/rate-limit，按平台 retry hint 恢复。                |
| 出站 auth 失效       | 不无限重试；status 为 blocked 并给出修复动作。                       |
| 部分发送             | 已发送 parts 被记录，未整批盲目重发。                                |
| reload/stop          | 不再接收新 admission；已有 drain 完成或可恢复；无悬挂 timer/socket。 |

建议运行：

```bash
pnpm openclaw plugins validate --entry <plugin-entry>
pnpm test <channel-focused-test-file>
pnpm openclaw channels status --probe
pnpm openclaw channels logs --channel <channel-id>
```

插件、manifest 或进程级元数据变化后必须重启 Gateway；运行时不会轮询插件文件变化。

## 12. 源码导航

| 主题                             | 源码/文档                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ChannelPlugin 根契约             | `src/channels/plugins/types.plugin.ts`                                                                       |
| meta/capabilities/inbound facts  | `src/channels/plugins/types.core.ts`、`src/channels/turn/types.ts`                                           |
| config/gateway/status adapters   | `src/channels/plugins/types.adapters.ts`                                                                     |
| legacy/common outbound adapter   | `src/channels/plugins/outbound.types.ts`                                                                     |
| 公共 inbound SDK                 | `src/plugin-sdk/channel-inbound.ts`、`docs/plugins/sdk-channel-inbound.md`                                   |
| 公共 outbound SDK                | `src/plugin-sdk/channel-outbound.ts`、`docs/plugins/sdk-channel-outbound.md`                                 |
| message/receipt/durability types | `src/channels/message/types.ts`                                                                              |
| 插件注册                         | `src/plugin-sdk/plugin-entry.ts`、`docs/plugins/sdk-channel-plugins.md`                                      |
| 现代参考实现                     | `extensions/zalo/src/channel.ts`、`extensions/zalo/src/monitor.ts`、`extensions/zalo/src/channel.runtime.ts` |
| 插件边界规则                     | `extensions/AGENTS.md`、`src/channels/AGENTS.md`、`src/plugin-sdk/AGENTS.md`                                 |

## 最终建议

把自定义 Channel 的 MVP 控制在“单账号、单一传输、DM 文本、pairing、durable ingress、文本 receipt”六件事。首先证明每条入站消息都能被安全路由、每个可见回复都有明确 receipt、每种失败都有可见结果；之后再扩展群组、媒体、streaming 和 native actions。Channel 最难的部分不是调用平台 API，而是身份、会话、ack、重放与部分失败的边界，这些必须在第一版架构中就正确。
