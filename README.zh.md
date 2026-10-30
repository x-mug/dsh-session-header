# dsh-session-header

[English](README.md) | 中文

> **维护中的 fork。** 本仓库是 [`x-mug/dsh-session-header`](https://github.com/x-mug/dsh-session-header)，从 [`homily707/dsh-session-header`](https://github.com/homily707/dsh-session-header) 的 `79a96e6` 分叉而来。相对上游的加固见 [CHANGELOG.md](CHANGELOG.md)；上游仍是原始项目。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给 harness 发出的**每一个 LLM 请求**注入 `x-session-id` header，值为**发起该次调用的 harness session id**。

## 为什么需要它

harness 没有请求级 header 缝——`GenerateOptions` 没有 headers 字段，每个 adapter 都在自己内部构造线上 header。如果你的模型网关（或中间代理）按 session header 做路由、缓存或审计，harness 自身发不出这个 header。

本插件把两个官方拦截点组合起来补上这个缺口：

- **`llm/stream` waterfall** 标记出哪些调用是 LLM 调用，并携带 `options.sessionId`；
- **`globalThis.fetch` 补丁** 注入 header，所有基于 fetch 的 adapter（`llm-deepseek`、`llm-pi-ai`，以及任何传输层最终落在全局 fetch 上的 SDK）都被覆盖，无需改 adapter 代码。

上下文传播用 `AsyncLocalStorage`。默认 `toolEndpoints` 为空时不会建立 `tools/execute` 作用域，因此只有发生在某次 LLM 调用流内部的 fetch 会被处理；web RPC、遥测、工具流量都原样通过。`toolEndpoints` 非空时，每次带 agent id 的 `tools/execute` 调用也会在作用域内执行，但其中的 fetch 只有 URL 以某个配置前缀开头才会注入；其余情况（web RPC、遥测、第三方工具目标）仍原样通过。`llm/stream` 作用域本身没有 URL 白名单——该门控只在工具阶段生效——因此 LLM 调用流内的任意 fetch 都是注入候选（仅剩的限制是确有可解析的取值与下面的覆盖规则）。别人已设置的 header 默认保留原值，仅当 `overwriteHeaders` 显式列入本插件的 header 名时才覆盖（大小写不敏感，遵循 HTTP 语义）。插件卸载时还原原始 `fetch`，但仅当 `globalThis.fetch` 仍指向本插件的补丁时才还原；若之后被别的补丁包住，则只输出告警、不还原。

取值语义：

- 默认：取当前调用 `GenerateOptions.sessionId`，发送前先归一：形如 `<agentId>-session-<uuid>` 的取其中的 UUID，其余只剥掉开头的 `session-` 前缀——因此持久化 `session-<uuid>` 发出纯 UUID，配置型 agent 也发出同一个 UUID，而不是它的 `<agentId>-session-<uuid>` 形态；主会话各轮次、压缩/起标题辅助调用、in-process 子 agent 各自上报**自己的** session id（子 agent 拥有独立的 child session id）；工具执行期（`tools/execute`）改取 `exec.agent.id`（正在运行该工具的 agent），同样做归一；
- 配置 `value`：所有调用使用固定值（按配置原样发送，不剥前缀）；
- 两者皆无的调用不发这个 header。

## 安装

需要 `dsh` CLI 与 Node ≥ 22。

### 作为 bundle 安装（推荐）

```sh
dsh plugin --profile <name> add github:x-mug/dsh-session-header#v0.3.0
```

本包是纯 JavaScript、无构建脚本，不需要 pnpm ≥ 10 的构建授权。要获得可复现的安装，请锁定 tag 或 commit（`github:x-mug/dsh-session-header#<tag-or-sha>`）。验证层并启动：

```sh
dsh --profile <name> --dump-config   # 应能看到 "# == dsh-session-header" 层
dsh --profile <name>
```

### 本地 checkout 用 `--patch` 覆盖层加载

```yaml
# my-overlay.yml —— 此处插件行需要绝对模块路径
- insert:
    - id: session-header
      name: /absolute/path/to/dsh-session-header/index.js
      config:
        header: x-session-id
        # value: my-fixed-session-id
```

```sh
dsh --patch ./my-overlay.yml
```

## 配置

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `header` | string | `x-session-id` | 注入的 header 名；线上大小写不敏感 |
| `value` | string | — | 固定值；不设 = 取当前调用的 harness session id |
| `toolEndpoints` | string[] | `[]` | 工具执行期匹配的 URL 前缀。非空时，`tools/execute` 瀑布内的 fetch（例如工具里调用的网关 web-search Messages API）仅当 URL 以某前缀开头才注入 header——第三方工具目标（web_fetch 抓任意网页、GitHub、MCP 服务器等）不受影响。前缀解析出的路径为 `/` 时等于放行整个 origin，该 origin 下所有路径都会带上 session id。默认空 = 保持原有仅 LLM 注入行为 |
| `llmEndpointAllowlist` | string[] | `[]` | LLM 阶段允许注入的 URL 前缀。**空数组表示不限制**——与 `toolEndpoints` 相反（它为空等于关掉工具阶段）：空时 `llm/stream` 作用域内任何 fetch 都是候选，adapter 自身的内部请求因此能正常工作。非空时只有 URL 命中前缀才注入（与 `toolEndpoints` 相同的 origin 全等 + 路径边界规则）。建议开启限制。前缀路径写成 `/` 等于覆盖整个 origin（同域 OAuth token 端点也会命中），要排除就必须写具体路径前缀。每一项都必须是 http(s) URL：非法项会让配置在加载时被拒绝（不同于 `toolEndpoints`，那里非法项只会被丢弃、不影响加载）。 |
| `overwriteHeaders` | string[] | `[]` | 必须包含本插件自己的 `header` 名（大小写不敏感）才允许替换该头已存在的值；列其它名字没有任何效果。未列出的头仍遵守"不覆盖"规则。某些官方 provider 会硬编码占位值（如 `dsh-web-search-deepseek` 发送 `x-opencode-session: dsh-web-search`），网关会当作缺失拒绝；要替换该占位值，需同时把该头设为本插件的 header，例如 `header: x-opencode-session` 配 `overwriteHeaders: [x-opencode-session]`，这样真实的会话 id 才会替换它。 |
| `redirectGuard` | boolean | `false` | 开启后，本插件实际注入 header 的请求会带上 `redirect: 'error'`，避免 header 跟随重定向跳到别的 origin——fetch 跨源重定向会剥掉凭据，但不会剥掉自定义 header。仅当调用方通过 `init.redirect` 显式指定时保留其值；`Request` 形态下非默认的 `redirect`（如 `manual`）会保留，但默认的 `follow` 会被改成 `error`。默认关闭，不开启则不改变任何现有行为。 |

注意两个列表的空值语义相反：`toolEndpoints` 为空会关掉工具阶段注入，而 `llmEndpointAllowlist` 为空表示「不限制」——这是向后兼容的默认值，建议显式开启限制。前缀路径写成 `/` 等于覆盖整个 origin（同域的 OAuth token 端点也会命中），要排除就必须写具体路径前缀。`redirectGuard` 未开启时不改变任何行为；开启后也只作用于真正被注入、且调用方没有自行指定重定向策略的请求。

配置在插件加载时校验一次。`header` 必须是运行时 `Headers` 接受的字段名，且不能是凭据、路由或分帧类 header（完整名单见 `index.js`）；`value` 一旦设置必须非空且是合法 header 值。校验不通过会先记日志再抛错，插件在插件列表里显示为失败，而不是加载成功却从不注入。唯一的软失败是 `toolEndpoints`：其中无法解析或非 http(s) 的前缀会被丢弃并告警。`llmEndpointAllowlist` 的每一项都在加载时校验，非法项会让配置被拒绝。

## 验证

把某个 provider 的 `baseURL` 指向会记录请求 header 的网关（或任何回显请求头的端点），开一个会话：

```
x-session-id: ba104306-a748-4052-a6e3-ab60be2e4c1f
```

同一会话的所有请求带同一 id；spawn 出的子 agent 的请求带 child session id。

## 说明

- `llm-deepseek` adapter 自身每次请求已带 `x-deepseek-harness-session-id`；本插件是 provider 中立的，默认绝不覆盖已有 header——仅当 `overwriteHeaders` 显式列入本插件的 header 名时才覆盖。
- 绝不触碰 `attributionHeaders()`（harness 的 User-Agent 归因契约）。
- 并发会话正确处理：header 值按调用经由 AsyncLocalStorage 解析，不经过共享可变状态。
- `globalThis.fetch` 补丁是共享的单例分发器：每个实例（以及每次 HMR 重载）都只往版本化 `Symbol.for` 键下那一个包装层注册 hook，叠加不会增加层数。卸载只移除本实例的 hook；当最后一个 hook 移除且没人再包住我们的 dispatcher 时，还原原始 fetch。若已被别的补丁包住，则保留那层包装、我们的 dispatcher 变为纯透传，只告警一次。
- hook 契约：hook 绝不读取或消费 `input.body`；返回 `{ input }` 或 `{ init }` 以替换分发器转发的内容，返回空表示原样透传。hook 按注册顺序执行；抛错的 hook 只对该请求被跳过（按签名限流告警），不影响其它 hook，也不影响请求本身。

## 许可

[MIT](LICENSE)
