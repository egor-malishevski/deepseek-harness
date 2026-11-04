# Agent Note：路由模型发现

Status: implemented

[English](2026-11-04-route-model-discovery.md) | 中文

## 问题

CLIProxyAPI 这类 OpenAI 兼容网关提供的模型列表跟随其实时凭据变化：harness 运行期间模型会出现也会消失。`llm-pi-ai` 路由过去只能提供硬编码的 `models` 数组，因此选择器会提供网关已不再服务的模型，也不会显示新模型，直到有人编辑 `cordis.patch.yml`。已有路由必须保持与以前完全一致的行为。

## 决定

路由通过 `discoverModels: true` 选择启用，并可设置 `modelsTimeoutMs`（默认 5,000）和 `modelsMaxAgeMs`（默认 600,000，`0` 表示每次访问都刷新且不运行定时器），名称和取值范围与 `dsh-llm-deepseek` 相同。启用后，`GET {baseURL}/models` 按列表顺序决定提供哪些模型。`models` 条目成为按 id 匹配的元数据种子：种子字段优先，列表提供的名称、上下文窗口与输出上限只填补种子未设置的字段。没有种子条目的列表 id 采用路由默认值，且不启用推理。列表未提及的种子条目仍可解析但不被提供，因此点名它的角色和进行中的会话不会以 `UNKNOWN_MODEL` 失败；现有发送闸门会拒绝对未列出模型的新选择。

每个启用发现的路由持有一个内存中的 `RouteListingCache`（`listing.ts`），由插件的 `apply` 闭包在路由切换该选项时创建和销毁。它与 `dsh-llm-deepseek` 的 `ModelListingCache` 语义一致：单飞加载、受 `modelsTimeoutMs` 限制的首次等待、按 `modelsMaxAgeMs` 的后台刷新、失败或空回复时保留最近成功的列表、每个连续失败区间一条警告，以及由端点、协议和标头加密钥哈希组成的范围键，范围变化时丢弃列表。该缓存是本地副本，因为 deepseek 缓存只能使用字符串凭据加载，而网关路由可能仅靠路由标头认证，且 `llm-pi-ai` 不得依赖 `llm-deepseek`。

profile 的缓存以原始配置标识与列表版本为键，版本只在列表真正变化时递增，适配器快照随之重建；已捕获快照的操作保持原快照。变化时为该路由发出 `llm/models-updated`（GUI 已监听并重新加载），并为每个消失的 id 记录警告。`listModels` 在读取前等待该路由的列表；当启用发现的路由尚无列表且模型未知时，`resolveModel` 与 `prepareCall` 会等待一次并重试。

请求代码是 `discovery.ts` 中的 `fetchModelListing`，与草稿发现共用。它发送路由的标头与密钥，且只在 `anthropic-messages` 上添加 `anthropic-version`：CLIProxyAPI 看到该标头或 `claude-cli` 用户代理时会返回不同的响应格式并重命名 id。

无法物化的列表模型会被跳过并通过 `listingProblems` 报告，不进入 `modelErrors`，因为第一个模型错误会成为路由的目录错误，端点数据不应把配置标记为损坏。

## 备选方案

**复用 `dsh-llm-deepseek` 的 `ModelListingCache`。** 否决：这会让本包依赖 DeepSeek 提供方，而且它只能使用字符串凭据加载。

**由缓存调用 `discoverModels`。** 否决：它对目录路由直接用已安装目录回答、不发请求，并且接收草稿的密钥而非路由的标头。

**把列表持久化到磁盘。** 否决：过期文件会提供网关已不再服务的模型，而列表获取成本很低。离线启动时改用种子。

**把 `models` 当作白名单、列表当作过滤器。** 否决：目标是让新模型无需编辑就能出现。

**把列表模型的失败放入 `modelErrors`。** 否决：一行格式错误的端点数据会把整条路由标记为损坏。

## 影响

网关的模型变化在 `modelsMaxAgeMs` 内到达选择器，无需编辑配置。启用发现的路由首次 `listModels` 最多延迟 `modelsTimeoutMs`。列表只给出 id，因此无种子的模型采用路由默认值：不推理、文本输入。种子条目按精确 id 匹配，不支持模式覆盖，也不在磁盘上存储任何内容。列表缓存复制了 deepseek 缓存的语义；修改其中一个时应对照审查另一个。
