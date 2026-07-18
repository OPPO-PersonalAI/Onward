---
name: ow_metrics_report
description: 拉取 PostHog 使用数据并生成 Onward 数据指标 HTML 报告。支持 --pull（用只读 API Key 全量抓取并存快照）与离线出报告两种模式；报告覆盖 North Star、规模、留存、时长、功能采用、稳定性、更新健康七组指标，并逐快照追踪历史变化。当用户要求"生成数据报告 / 拉取使用数据 / 看指标 / metrics report"时使用。
---

# ow_metrics_report — Onward 数据指标报告

## 这个 skill 做什么

以数据驱动方式改进产品：从 PostHog（项目 "Onward"，us.posthog.com）拉取全量使用数据，
按既定指标口径（见 `docs/html/telemetry-metrics-system-redesign.html`）计算七组指标，
生成自包含的暗色 HTML 报告，并通过快照序列追踪历史变化。

三个组成部分（都在仓库内，纯 Node、跨平台）：

| 文件 | 职责 |
|---|---|
| `scripts/metrics/pull-posthog-snapshot.mjs` | `--pull` 模式：跑固定的 HogQL 查询集，全量抓取 → 存时间戳快照 |
| `scripts/metrics/metrics-model.mjs` | 纯计算：DAU/WAU/MAU、粘性、D1/D7/D30 留存、采用率、无崩溃率、North Star（有单测锁定口径） |
| `scripts/metrics/build-metrics-report.mjs` | 读全部快照 → 渲染报告（最新快照出指标 + 快照间趋势表） |

数据落盘位置（`traces/` 已 gitignore，**使用数据永不进开源仓库**）：

- 快照：`traces/metrics/snapshots/<UTC 时间戳>.json`
- 报告：`traces/metrics/reports/metrics-report-<时间戳>.html`

## 执行步骤

### 模式一：拉取最新数据 + 出报告（用户说"拉取最新数据"、带 --pull 意图）

1. **确认 Key 可用**（只读 Personal API Key，权限仅 Query Read、限定 Onward 项目）。
   查找顺序：环境变量 `ONWARD_POSTHOG_API_KEY` → 文件 `~/.config/onward/posthog-api-key`（单行）。
   两处都没有时，脚本会打印创建引导并退出——把引导转述给用户，让用户到
   PostHog → Settings → Personal API Keys 创建**只读** Key 后放入上述任一位置；
   **绝不**把 Key 写进仓库、命令行参数或对话中。
2. 运行拉取（全量抓取，当前量级下几秒完成）：
   ```bash
   node scripts/metrics/pull-posthog-snapshot.mjs
   ```
3. 运行报告生成：
   ```bash
   node scripts/metrics/build-metrics-report.mjs
   ```
4. 用 SendUserFile 把生成的报告 HTML 发给用户（render 模式），并口头汇报"数据要点"
   一节的自动预警（North Star / 无崩溃率 / WAU 环比下降等）。

### 模式二：离线出报告（不带 --pull，或另一台没有 Key 的电脑）

直接执行第 3、4 步。报告基于本地已有快照；没有任何快照时向用户说明需要先在有 Key 的机器上拉取一次，或从其他机器拷贝 `traces/metrics/snapshots/` 目录过来。

## 参数约定

- `--pull`：先拉取再出报告（模式一）。
- `--range 7d|30d|90d`：调整报告的短窗口（会话/采用/稳定性/功能使用各节的统计窗口，默认 7d；更新健康固定 30 天，周趋势固定 12 周）。透传给 `build-metrics-report.mjs --range <N>d`。
- 不带参数：模式二（离线，默认 7d 窗口）。

## 注意事项

- **口径统一重算**：快照存的是原始查询结果，快照间趋势表用当前口径重算全部历史——指标定义升级后无需重拉数据。
- **新旧埋点过渡**：2026-07-18 指标重构（session/end 的 crashFree、feature/first-use、
  update/* 入聚合）之前的日期区间，相关表格为空属于口径切换而非数据丢失；报告内已有注释说明。
- **报告是自包含文件**：发给任何人都能直接打开，无需 Key、无需登录。网页版数据在
  us.posthog.com 登录账号即可看；给他人只读访问用 PostHog 的 Dashboard 分享链接。
- 查询集扩展规则：`pull-posthog-snapshot.mjs` 的 `SNAPSHOT_QUERIES` 只增不改
  （行形状是与 metrics-model 的契约，快照是长期历史资产）；新增指标时同步改
  `metrics-model.mjs` 并补 `test/unittest/metrics-model.test.mts` 用例。
