<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# 方案1：Windows EDR 性能税的环境侧根治（彻底整体方案）

> 本文是 **方案1**（修环境、从源头消除 EDR 进程创建税）的完整落地方案。
> 它需要**管理员权限或 IT 介入**，因此自动化代理无法自行执行——本文把方案1
> 拆到"只差一步提权/提单"的程度，并提供现成脚本与工单模板。
>
> 与之并行的 **方案2**（测试架构加固，已落地、已达成 STABLE 3/3）是跨机器持久的
> 兜底；方案1 解决的是**根因**（机器环境），两者不冲突，理想状态是两者都有。

---

## 1. 根因证据

本机（Windows 11，企业 Intune 托管）上，每次进程创建被同步的 Defender/EDR
按需扫描拦截 **1.3–12.9 秒**。全量回归跑到几十个套件后，后续套件累积的进程税
使"读一次即断言"的定时逻辑被击穿——表现为**每轮失败的套件都不同**（shifting
failure set）。

复现/取证命令（只读，安全）：

```powershell
Get-MpComputerStatus | Select-Object IsTamperProtected, AMRunningMode, RealTimeProtectionEnabled
Get-MpPreference     | Select-Object PerformanceModeStatus, DisableRealtimeMonitoring
fsutil devdrv query                      # 当前是否已有 Dev Drive
[int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber  # 需 >= 22621
```

本机实测：`IsTamperProtected = True`、Defender 受 Intune 中央托管。这意味着
**本地（即便管理员）也无法增删 Defender 排除项**——排除项只能由 Intune 策略下发。
这就是方案1 无法在本地直接"加排除项"完成的硬约束。

---

## 2. 两条落地路径（任选其一，可叠加）

| 路径 | 机制 | 需要 | 谁来做 | 持久性 |
|---|---|---|---|---|
| **A. Dev Drive** | Win11 ReFS Dev Drive 走 Defender **性能模式**（异步/写后扫描），消除同步进程税 | 管理员权限 + 把仓库迁到新盘 | **你**（提权运行脚本） | 强（新盘永久免同步扫描） |
| **B. Intune 排除项** | 由 IT 在 Intune 策略中为仓库路径/进程加 Defender 排除 | IT 工单 + 中央批准 | **IT**（你提交工单） | 取决于策略保留 |

> 推荐 **A（Dev Drive）**：它不需要 IT、不动 Defender 策略、不触碰 Tamper
> Protection，完全在你本机一条提权命令内完成，且对系统盘无破坏（用 VHDX 虚拟盘）。

---

## 3. 路径 A — Dev Drive（推荐，现成脚本）

脚本：[`infra/scripts/setup-dev-drive-windows.ps1`](../infra/scripts/setup-dev-drive-windows.ps1)

它会（幂等、对现有磁盘非破坏性）：
1. 校验**已提权** + Windows 构建号 ≥ 22621（Dev Drive 支持线）。
2. 在你指定路径创建一个**新的 VHDX 虚拟盘**（不会重新分区 C:）。
3. 挂载、建 GPT 分区，并 `format <X>: /DevDrv` 格式化为 **Dev Drive**，标记为受信任。
4. 打印下一步（把仓库拷到新盘）。

**你需要执行的步骤**（代理无管理员权限，必须由你做）：

```powershell
# 1) 以管理员身份打开 PowerShell，然后：
Set-ExecutionPolicy -Scope Process Bypass
.\infra\scripts\setup-dev-drive-windows.ps1 -VhdxPath 'D:\devdrives\onward.vhdx' -SizeGB 64

# 2) 确认是受信任的 Dev Drive：
fsutil devdrv query <新盘符>:        # 期望: "This directory is a trusted Dev Volume."

# 3) 把仓库迁到新盘（克隆或 robocopy 工作树），在新盘上重装依赖：
git clone <this-repo> <新盘符>:\Onward-Agent-Workbench
cd <新盘符>:\Onward-Agent-Workbench
pnpm install

# 4) 在新盘上重跑回归，确认进程税消失（方案1 验收）：
py test/autotest/run-full-regression.py --build --repeat 3
```

验收标准：在 Dev Drive 上的 `--repeat 3` 应稳定通过，且**单套件耗时显著下降**
（不再被每次 spawn 的同步扫描拖累）。这就是方案1 的"彻底整体"完成。

> 重启后 Dev Drive 默认不自动挂载，用 `Mount-DiskImage -ImagePath 'D:\devdrives\onward.vhdx'` 重新挂上。

---

## 4. 路径 B — Intune/Defender 排除项工单模板

若你更倾向走 IT（或公司不允许 Dev Drive），把下面的模板提交给 IT/安全团队。

> **标题**：请求为本地开发仓库添加 Microsoft Defender 排除项（Intune 策略下发）
>
> **背景**：本机受 Tamper Protection + Intune 托管，本地无法自助添加 Defender
> 排除项。某 Electron/Node 项目的自动化测试在每次进程创建时被同步按需扫描拦截
> 1.3–12.9 秒，导致测试不稳定与开发效率严重下降。
>
> **请求的排除项**（建议按 Intune *Microsoft Defender Antivirus exclusions* 配置文件下发）：
>
> 路径排除（Path）：
> - `<仓库绝对路径>\`（含 `node_modules`、`out`、`release`、`test\autotest\fixtures\**\runtime`）
>
> 进程排除（Process）——仅限开发用途，按需精简：
> - `node.exe`、`pnpm.exe` / `pnpm.cmd`
> - `git.exe`、`git-*.exe`
> - `<仓库>\release\win-unpacked\Under Development *.exe`（及其 Helper 进程）
> - `conhost.exe`、`OpenConsole.exe`、`winpty-agent.exe`（conpty/node-pty）
> - `rg.exe`（@vscode/ripgrep）
>
> **风险与范围**：排除项仅作用于开发仓库目录与上述开发工具链进程；不影响系统
> 其余部分的实时保护。可设回退期/到期复核。
>
> **影响**：不加排除时，CI/本地回归在该主机不可稳定通过；加排除后进程税消除。

---

## 5. 与方案2 的关系

- **方案2（已落地）**：测试不再依赖"读一次即断言"，而是**轮询真实最终状态**
  （ground truth），把正确性门禁与性能测量分离。它让回归在**任何**主机（不论
  安全态势）上都稳定——已在本机达成 STABLE 3/3（每轮 81 PASS / 0 FAIL）。
- **方案1（本文）**：根治机器环境，消除 EDR 同步进程税本身；让回归不仅"稳"，
  而且"快"。需要你的提权或 IT 介入。

二者正交：方案2 是可移植的安全网，方案1 是根因修复。建议在你方便时执行路径 A，
即可让本机同时获得"快 + 稳"。

---

## 文档元信息与更新历史

- 生成分支：`master`
- 反映版本/状态：方案2 已达成 STABLE 3/3（2026-06-24）；方案1 待你提权/提单执行
- 文档版本：v1.0

| 版本 | 日期 | 分支 | 变更摘要 |
|---|---|---|---|
| v1.0 | 2026-06-24 | master | 首次创建：方案1 完整落地方案（Dev Drive 脚本 + Intune 工单模板 + 取证命令） |
