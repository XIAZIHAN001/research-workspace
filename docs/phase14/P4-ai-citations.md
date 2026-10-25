# Phase 14 · P4 AI 精读与可核验引用（2026-10-24）

结论：**所需状态与护栏均已存在且在测，本轮零代码改动**；未运行任何付费在线模型（离线 mock 与固定文本）。

| 关卡项                    | 现状与证据                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| sidecar 安全边界/协议不动 | 未触碰 `server/`；provider 协议、凭据、localhost 限制原样                                                                                           |
| 上下文范围披露            | 选段/当前页/整篇三种作用域在请求体与面板「会发送的范围」披露中一致——`verify:immersive` "the range disclosure matches what the request carries" PASS |
| 加载/失败/取消/重试       | ThinkingChain（可取消）+ 失败保留对话并给「重试」——AiPanel.test 29 项中的 cancel/retry/failure 用例                                                 |
| 空结果/额度/协议错误      | "evidence insufficient"、"no citation to check"、"budget-exceeded 状态词"、"不打印协议细节" 用例                                                    |
| 离线                      | "says the local service is not running rather than pretending to be offline-safe" + 运行模式行（离线模拟/在线需明确配置）                           |
| 连续追问滚动              | `stickToBottom` 粘底：用户在底部时新内容自动续滚（直接写 scrollTop，避免 scrollIntoView 连带祖先容器），上滚阅读时不拽动（AiPanel.tsx:419-463）     |
| 底部输入区可达性          | `.ai-ask` 为面板 flex 列的固定末项，答案区独立滚动（`.ai-scroll`），Scroll Edge 渐隐不遮挡输入区（条为 pointer-events:none 且输入区在滚动区外）     |
| 引用可核验                | 引用仅当服务端逐字校验通过才可点击（"turns a verified citation into something clickable"），跳转经 `locateAnchor` 保守匹配，不制造假引用            |
| 公式排版                  | KaTeX 排版 + 源码可查 + 转义防护 + 降级显示原始 LaTeX（4 项用例）                                                                                   |
| 真实联网标识              | 面板常驻 provider 行（在线模式注明型号与费用提示），运行模式行明示离线模拟                                                                          |

回归证据：`npm run check`（含 AiPanel.test 29 项）+ `verify:immersive` 33/33 本轮实测通过。
