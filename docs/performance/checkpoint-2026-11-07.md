# 冷搜索与基准一致性检查点（2026-11-07）

## 本轮结论

相对上一个已发布检查点 `05d7163f8ce34a32faf2cb694025a18dac33ced8`，本轮减少全局搜索首建时不必要的展示工作：空搜索框不建立索引；只为最终显示的候选整理元信息和片段；生成展示数据后替换原始值快照，不长期保留双份结构。

同环境合成算法测量中，1 万条资料无命中冷查询 12.989 → 5.565 ms，高命中冷查询 12.274 → 5.284 ms；高命中热查询 0.670 → 0.567 ms。独立生命周期采样的首次索引保留堆中位数约 7.18 → 3.68 MB。但全部结果展示后的内存有上升，详见下文，不能说所有路径或整个生命周期都更快、更省内存。

这些数字不代表真实浏览器输入延迟或 Mac/Windows 桌面体验。比较基准是上一个发布版本，并非最初的未索引版本；不与上一份报告跨运行直接相减。本轮没有改变 PDF 渲染几何、持久化、恢复协议、schema、原生凭据或任何安全门槛，仍不合并 PR。

## 可回滚存档点与源码对应

通过已连接 GitHub 接口发布时，提交元数据会变化。每步 Git tree 均核对相同，基准保留真实测量时的本地 SHA。

| 阶段                   | 本地测量/提交 | 对应远端提交                                                                                                    |
| ---------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| 基准来源校验与计划     | `3aa891f`     | [`fb5ed808`](https://github.com/XIAZIHAN001/research-workspace/commit/fb5ed808fbe6ed93c0c22cf376223b06858818e1) |
| 冷搜索优化             | `65b3a2f`     | [`ba973b60`](https://github.com/XIAZIHAN001/research-workspace/commit/ba973b60d1baa3f99f09ce9ca5b6dc5a23ec2e6d) |
| 并发回归与生命周期测量 | `c7debcc`     | [`3a066320`](https://github.com/XIAZIHAN001/research-workspace/commit/3a0663208ba372580f84572d61f0cf98a86ff08a) |

被测应用代码固定于 `65b3a2fcab859b5dd56141234eab6d9e438298ba` / 远端 `ba973b60d1baa3f99f09ce9ca5b6dc5a23ec2e6d`，tree 为 `c13d131761710c0f1fd1d8c74d8292f88c0c9dc9`。其后仅补测试、测量工具和报告。最终发布提交及 CI 状态以 PR #3 顶部为准。

## 正确性与独立复核

- 原版在新环境重新执行 `npm run check`：122 文件 / 2385 测试通过，构建通过。
- 最终应用、并发回归和测量工具重新执行完整 `npm run check` 与 `npm run build`：124 文件 / 2435 测试通过，类型、lint、格式和生产构建通过。
- TDD 验证了空框不读取资料、展示工作有界、原始快照释放、无效基准来源拒绝。新增 StrictMode 空框用例在原版读取资料 6 次而非 0 次，候选通过。
- 原有 49 组搜索兼容黄金快照未改。实现者 15120 次、独立复核 23400 次完整结果差分通过，覆盖 Unicode、长/空文本、重复 ID、缺失关联、稳定顺序、特殊 limit、源对象和数组变更、返回值污染。
- StrictMode 清空/重开和 Suspense 中断 source transition 后继续搜索、替换 source、打开正确结果的两个独立用例已入库。
- 34 个正式场景的完整输出逐项相等；复核确认源码 blob、harness/lock 指纹、环境、采样、全部中位数/p95/checksum 和生命周期记录算术一致。
- 新的严格来源校验在源码归档、编译、计时前拒绝不兼容报告。缺字段不能因双方缺失而绕过；commit、时间戳、实现 mode 和测量值允许不同。
- 生产构建保留既有 chunk 警告：App 657.92 kB / gzip 196.05 kB；没有提高警告阈值。

## 时间测量与完整数据

Linux x64 / Node 24.22.1 / AMD EPYC 9V74，9 logical CPUs。同一最终 harness，先基线后候选，3 次预热、15 次采样。p95 使用 nearest-rank；在 15 个样本下仍等于样本最大值，不能当作稳定尾延迟估计。冷热路径沿用[复现说明](README.md)。

资料规模为四类记录的总数，平均分配给论文、注释、概念和证据。完整报告：[基线](round2-baseline-05d7163.json.gz)、[候选](round2-candidate-65b3a2f.json.gz)。未改动的身份解析、PDF 查找和滚动场景作为正确性控制保留，不把其计时浮动归因于本轮优化。

| 场景                            | 基线中位数 ms | 候选中位数 ms | 基线 p95 ms | 候选 p95 ms |
| ------------------------------- | ------------: | ------------: | ----------: | ----------: |
| `workspace/1000/no-hit/cold`    |         1.379 |         0.851 |       1.936 |       1.387 |
| `workspace/1000/no-hit/warm`    |         0.078 |         0.071 |       0.122 |       0.187 |
| `workspace/1000/high-hit/cold`  |         1.323 |         0.712 |       2.252 |       1.602 |
| `workspace/1000/high-hit/warm`  |         0.100 |         0.093 |       0.255 |       0.200 |
| `workspace/1000/cjk/cold`       |         1.466 |         0.590 |       2.180 |       1.071 |
| `workspace/1000/cjk/warm`       |         0.048 |         0.048 |       0.093 |       0.090 |
| `workspace/10000/no-hit/cold`   |        12.989 |         5.565 |      23.485 |       9.767 |
| `workspace/10000/no-hit/warm`   |         0.598 |         0.496 |       0.895 |       0.692 |
| `workspace/10000/high-hit/cold` |        12.274 |         5.284 |      22.447 |       6.199 |
| `workspace/10000/high-hit/warm` |         0.670 |         0.567 |       0.900 |       0.814 |
| `workspace/10000/cjk/cold`      |        10.446 |         4.986 |      14.439 |       6.168 |
| `workspace/10000/cjk/warm`      |         0.215 |         0.209 |       0.435 |       0.415 |

空框不建索引由结构回归证明，没有单独记录真实浏览器打开耗时。首个非空查询仍需要索引，但上表冷路径包括该成本；收益不只是把原成本挪到第一次按键。部分微小热路径变化可能是噪声，不能宣称每项都改善。

## 原始报告的无损存档

为避免大文本发布失败，三份原始 JSON 使用 gzip 无损保存，未重新测量、改写或删减字段。压缩文件约 108 kB，原始文件约 2.21 MB；[校验清单](round2-archive-checksums.json) 记录压缩前后字节数及 SHA-256。解压后的时间报告仍可按原有格式读取；只有同一 harness、依赖、环境和采样设置下的报告才能相互比较。

以下命令只使用 Node 内置模块，先验证压缩字节，再验证解压内容，最后写入独立输出目录：

```sh
node --input-type=module <<'JS'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = 'docs/performance/';
const manifest = JSON.parse(readFileSync(root + 'round2-archive-checksums.json', 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
mkdirSync('/tmp/research-workspace-round2', { recursive: true });
for (const entry of manifest.files) {
  const packed = readFileSync(root + entry.file);
  if (packed.length !== entry.compressedBytes || digest(packed) !== entry.compressedSha256) throw new Error(entry.file + ': compressed checksum mismatch');
  const raw = gunzipSync(packed);
  if (raw.length !== entry.originalBytes || digest(raw) !== entry.originalSha256) throw new Error(entry.file + ': original checksum mismatch');
  JSON.parse(raw.toString('utf8'));
  writeFileSync('/tmp/research-workspace-round2/' + entry.originalFile, raw);
  console.log(entry.originalFile + ': verified');
}
JS
```

## 生命周期保留堆与负收益

[完整生命周期报告](search-lifecycle-65b3a2f.json.gz) 由仓库内 `scripts/performance/search-lifecycle.mjs` 和 `search-lifecycle-workload.mjs` 产生。两个固定 revision × 1k/10k × 5 个独立 Node 进程，交替顺序；每进程重复 3 个生命周期，共 60 个。源数据始终强引用，每阶段跨事件循环后强制 GC 3 次；全展示使用 Infinity 查询生成所有四类结果，再释放返回数组后读取堆。

下表单位是字节，为 5 个独立进程的中位数，各阶段相对该轮 source-only heap。

| 记录数 / 生命周期 |  首建基线 |  首建候选 | 全展示基线 | 全展示候选 |
| ----------------- | --------: | --------: | ---------: | ---------: |
| 1000 / 1          |   712,024 |   381,352 |    746,672 |    795,264 |
| 1000 / 2          |   695,432 |   380,800 |    814,528 |    789,208 |
| 1000 / 3          |   696,048 |   381,416 |    729,328 |    824,256 |
| 10000 / 1         | 7,180,008 | 3,682,432 |  7,562,720 |  7,702,360 |
| 10000 / 2         | 6,816,872 | 3,879,088 |  7,211,016 |  7,539,248 |
| 10000 / 3         | 6,855,192 | 3,818,736 |  7,237,936 |  7,684,360 |

- 首轮首建保留堆下降约 46%（1k）/49%（10k）。这与普通时间基准中的 GC 后堆差是不同实验，不混为同一个内存指标。
- 全展示有真实负收益：首轮 1k 增加约 6.51%，10k 增加约 1.85%；三个生命周期中最高分别增加约 13.02% / 6.17%。展示层比原先扁平记录多一层包装，但不会保留已替换的原始快照，也不按查询次数无限积累缓存。
- 60/60 次释放后观察到索引被回收，所有完整结果 checksum 相同。进程堆残留并非零，可能涉及字符串表示、JIT/代码缓存、记录开销等，未把所有残留字节归为泄漏或噪声。
- 这是受控 Node 保留 JS 堆，不是峰值、RSS、DOM、浏览器/WebView 内存或一般性无泄漏证明。未观察到 WeakRef 回收本身也不能断言存在强引用或泄漏。

复现命令（已有依赖；输出目录须存在）：

```sh
node scripts/performance/run.mjs --ref 05d7163f8ce34a32faf2cb694025a18dac33ced8 --warmups 3 --samples 15 --out /tmp/search-baseline.json
node scripts/performance/run.mjs --ref ba973b60d1baa3f99f09ce9ca5b6dc5a23ec2e6d --warmups 3 --samples 15 --out /tmp/search-candidate.json --compare /tmp/search-baseline.json
node scripts/performance/search-lifecycle.mjs --baseline 05d7163f8ce34a32faf2cb694025a18dac33ced8 --candidate ba973b60d1baa3f99f09ce9ca5b6dc5a23ec2e6d --out /tmp/search-lifecycle.json
```

生命周期报告使用独立格式，不能作为时间基准的 `--compare` 输入。指纹证明使用了相同记录代码和元数据，不证明机器负载一致、安装依赖无篡改或不同设备上的普遍收益。

## 平台核验与延后事项

本环境没有列出可用 Mac。本轮只读检查确认当前原生桌面版仍只承诺 Windows：默认 NSIS 打包；非 Windows 凭据后端拒绝读写，因此 Mac 桌面在线 AI 不可用；没有 Mac 安装包或 macOS CI/本机构建运行证据。源码具有部分跨平台准备，但这不等于 Mac 原生支持。Mac 浏览器源码开发路线可供测试数据试用，未作 Mac 实测承诺。

新云环境按既有脚本尝试 Chromium，仍在启动时因 socket 权限被拦住（0 项应用验收运行），未调整安全设置。正式 Linux 浏览器验收以发布提交的 CI 为准，不能替代 Windows 或 Mac。完整 PDF 组件窗口化、混合页几何重构和持久化架构仍未实施，等待对应专项测量和恢复/原生验收条件。
