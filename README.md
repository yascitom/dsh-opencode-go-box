# dsh-opencode-go-usage

中文 | [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web-GUI 插件，为接入 **OpenCode Go** 模型的用户提供完整用量观测：

- **额度窗口**：5 小时滚动 / 每周 / 每月 三个窗口的已用百分比、套餐参考限额和重置时间；
- **DSH 会话明细**：DeepSeek Harness 中每个使用 opencode-go 模型的会话的 token 用量，并可下钻到**每一次模型调用**（turn/step 级）；
- **缓存统计**：会话累计、单会话、单次调用三个层级都展示**缓存读取（命中）/ 缓存写入**，并计算**缓存命中率**（缓存读取占全部输入的比例）；
- **模型筛选**：按模型分组筛选会话（chips），查看每个模型的用量与缓存情况，并附**按模型汇总**对比表；
- **双语界面**：内置中文 / English 两套文案，面板右上角可**一键切换语言**（与「设置 → 通用 → 语言」联动并持久化）；
- **底栏常驻挂件**：输入框下方一行实时额度（30s 轮询），按阈值自动变色；
- **数据新鲜度**：额度页与底栏挂件均标注「最近成功更新」时间；轮询失败时**保留最后一次成功数据**并标注「未更新」（stale），不会误清空为失败状态；
- **诊断区块**：额度页可展开「诊断」——HTTP 状态码、解析版本、凭证来源与掩码 key、最近 3 次请求快照（含原始响应体），便于与官方页面核对；
- **计费口径提示**：DSH 明细标注「本地统计仅供参考」，提醒日志 token 与官方账单可能存在的差异。

## 功能特性

- 设置侧边栏新增 **"OpenCode Go"** 栏目（`settings.section` 贡献），内含「额度」「DSH 会话明细」两个标签页
- Host 端 Typert Remote `opencodeUsage`：`usage` / `dshUsage` / `dshSessionMessages` 三个方法
- **DSH 会话明细完全基于 DeepSeek Harness 自身的会话日志**（每条 `assistant/message` 事件自带 token 记账），不依赖本机是否安装 OpenCode 客户端，任何 DSH 部署都能用
- 缓存统计：`cacheReadTokens`（命中）/ `cacheWriteTokens`（写入）按会话、按调用展示；命中率 = 缓存读取 ÷（非缓存输入 + 缓存读取）
- 模型筛选：会话按 `source.model` 分组，chips 一键筛选，筛选后累计卡片与列表同步收窄；全部模型时展示「按模型汇总」表（会话数 / 输入 / 缓存读取 / 缓存写入 / 输出 / 推理 / 命中率）
- 推理 token 说明：opencode-go 由 DSH 的 pi-ai 适配器接入，该适配器把推理消耗**并入输出 token**，不单独记录 `reasoningTokens`，因此推理列显示为 **—**（未上报），而非误导性的 0；单独上报推理的适配器（如 dsh-llm-deepseek）会正常显示数值
- 调用明细：单会话下钻展示**每次模型调用**的时间、模型与五项 token 计数；长会话保留**最近 400 次**调用（累计统计始终覆盖全部调用）
- 底栏挂件（`conversation.composer.dock` 贡献）：`🟢 5h 22% · W 13% · M 13% · ↻ 2h13m`（W=每周、M=每月、↻=重置倒计时，悬停显示完整文字），按 5 小时滚动窗口阈值变色（默认 <60% 绿 / 60–85% 橙 / ≥85% 红）
- 数据新鲜度：额度页每 30s 自动刷新（与底栏挂件同频），显示「最近成功更新」时间；任何一次拉取失败都保留上一次成功数据并标注「未更新」，手动点「刷新」才显示加载态
- 诊断：额度页可展开「诊断」区块——最近成功拉取时间 / HTTP 状态码 / 解析版本 / 凭证来源与掩码 key / 最近 3 次请求快照（每次含时间、状态、错误与原始响应体，超长响应自动截断为预览）
- 前置校验：若 **设置 → 模型** 中未添加 opencode-go，或未找到 API key，会显示引导说明而非报错
- API key 解析链：opencode-go provider 配置所声明的凭证引用（`apiKeyEnv`，通过 `llm` provider 目录动态发现）→ DSH 凭证层的常规引用 `OPENCODE_GO_API_KEY` → OpenCode 的 `auth.json`

## 安装

```sh
dsh plugin --profile web add github:yascitom/dsh-opencode-go-box
```

或从本地源码目录安装：

```sh
dsh plugin --profile web add file:/path/to/dsh-opencode-go-usage
```

本包声明了 `dsh.bundle.patch`，因此 `dsh plugin add` 会自动将其 reconcile 进
`dsh.profile.bundles` —— 无需手动修改 `cordis.patch.yml`。
安装后请重启 `dsh web`，让 Host 半部与托管的 Client bundle 生效。
该插件依赖标准 web bundle 组合（`api-gateway` Client Remote 与 `settings.section` slot）——默认的 `dsh web` profile 均包含。

## 配置

Host 端可调项位于插件行（`id: opencode-go-usage`）；在
`$DSH_HOME/profiles/web/cordis.patch.yml` 中覆盖：

```yaml
- id: opencode-go-usage
  config:
    baseUrl: https://opencode.ai/zen/go/v1/usage   # 默认值
    timeoutMs: 15000                                # 默认值
    warnPercent: 60                                 # 默认值：≥60% 变橙
    dangerPercent: 85                               # 默认值：≥85% 变红
    maxSessions: 30                                 # 默认值：DSH 明细最多扫描的会话数
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `https://opencode.ai/zen/go/v1/usage` | 用量查询接口地址。 |
| `timeoutMs` | `15000` | 请求超时时间（毫秒）。 |
| `warnPercent` | `60` | 5 小时滚动窗口达到该百分比后挂件变橙。 |
| `dangerPercent` | `85` | 5 小时滚动窗口达到该百分比后挂件变红。 |
| `maxSessions` | `30` | DSH 会话明细扫描的最近会话数上限。 |

## 用量接口

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <API_KEY>
```

`<API_KEY>` 即接入模型时已存储的 OpenCode Go key（`sk-opencode-…`）。接口返回：

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 9,  "resetsAt": "…" },
    "weekly":  { "status": "ok", "percent": 12, "resetsAt": "…" },
    "monthly": { "status": "ok", "percent": 6,  "resetsAt": "…" }
  }
}
```

`percent` 取值 0–100；`resetsAt` 为 ISO-8601 时间。该接口尚未出现在 OpenCode 的公开文档中。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半部 —— `OpencodeUsageGateway`（`TypertRemoteService`，服务键 `opencodeUsage`） |
| `typert.host.js` | 手写 Typert Host 清单，通过 `exports["./typert"]` 注册 |
| `client.js` | `window.__ModuleLoader__.load` 格式的浏览器 bundle —— 挂载 Remote、注册栏目与底栏挂件、渲染页面 |
| `cordis.patch.yml` | Bundle patch，插入插件行（`id: opencode-go-usage`） |
| `package.json` | 双面声明：`main` + `exports["./client"]` + `exports["./typert"]` + `dsh.client` + `dsh.bundle` |

## 已知限制

- 用量接口未公开文档，可能变更；解析做了防御性处理，非 200 响应会以友好状态提示而非崩溃。
- 限额（$12 / $30 / $60）仅作展示参考，并非接口返回内容；它们随 OpenCode Go 套餐而定，可能漂移。
- DSH 会话明细统计的是 DSH 会话日志中的 token 记账（不含花费金额），只覆盖 DeepSeek Harness 内的对话。
- 本地 token 统计与服务端计费可能存在差异（计费规则、舍入、重试、隐藏 token 等），面板已标注「仅供参考」，以官方账单为准。

## License

MIT
