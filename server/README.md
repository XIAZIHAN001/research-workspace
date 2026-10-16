# 本地 AI 精读服务

浏览器端**不保存任何 API Key**。所有模型调用都由这个只监听 `127.0.0.1` 的本地进程完成，
前端只发送结构化请求（哪篇论文、哪一页、哪几段原文、什么问题），由服务端组装提示词。

## 启动

```bash
npm run ai:serve
```

不配置任何环境变量时使用 **mock provider**：不联网、不计费，用于开发与验收。
应用启动本身不会产生任何在线调用。

## 连接真实模型

需要同时设置两项，缺一不可：

```bash
AI_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-… npm run ai:serve
```

这是刻意设计的两道门：只设置 Key 不会生效，必须显式声明使用在线提供方。
界面会在发送前显示「回答来自 DeepSeek …：会调用在线模型，可能产生费用」。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_PROVIDER` | `mock` | `mock` 或 `deepseek` |
| `DEEPSEEK_API_KEY` | 空 | 仅从环境变量读取，不进前端、不进仓库 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 官方当前型号名；也可填 `deepseek-v4-pro` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 必须是 https |
| `AI_PORT` | `8787` | 监听端口；监听地址固定为 `127.0.0.1`，不可配置 |
| `AI_TIMEOUT_MS` | `60000` | 单次请求超时 |
| `AI_ALLOWED_ORIGINS` | 空 | 额外允许的 Origin（逗号分隔）；回环来源始终允许 |
| `AI_LOG_REQUESTS` | 开启 | 设 `0` 关闭访问日志 |

模型名与请求格式核对自官方文档 `api-docs.deepseek.com`（`POST /chat/completions`、
`Authorization: Bearer`、`choices[0].message.content`）。使用在线提供方时以 JSON 输出模式
请求，因为引用校验需要可解析的结构。

## 边界

- 只监听 `127.0.0.1`，且**不可配置**——改错一个环境变量不能把它暴露到网络上。
- 只有两个接口：`GET /api/ai/health`、`POST /api/ai/ask`。没有任何形式的转发。
- 提供方、端点、模型全部来自进程环境，**从不来自请求**；页面无法把调用指向别处。
- 请求体上限 256 KB，每分钟 30 次，同时最多 4 个在途请求。
- `Host` 必须是回环地址（防 DNS rebinding）；`Origin` 必须是回环或显式允许的来源。
- 日志只有方法、路径、状态、耗时、段落数与字符数——没有原文、没有问题、没有密钥。
- 系统提示词由服务端从常量组装；**论文文本永远只出现在 `user` 消息的数据块里**，
  并且数据块分隔符会在拼接前被消解。
- 引用一律校验：段落 id 必须是本次发出去的，引文必须是该段落逐字的子串；
  页码只取自服务端自己的段落记录，从不采信模型给出的页码。

## 测试时用到的故障开关

mock provider 会识别问题里的几个标记，用来在浏览器验收里走到每条失败路径
（真实模型上它们只是普通文字）：

| 标记 | 行为 |
| --- | --- |
| `[[mock:error]]` | 返回模型服务错误 |
| `[[mock:timeout]]` | 一直不返回，直到调用方超时或取消 |
| `[[mock:bad-citation]]` | 返回编造的引文与不存在的段落 id |
| `[[mock:plain-text]]` | 不返回 JSON |
| `[[mock:ungrounded]]` | 明确表示依据不足 |
| `[[mock:html]]` | 回答里带 `<img onerror>` 与 `<script>` |
