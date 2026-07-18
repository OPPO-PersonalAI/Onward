/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Onward metrics report renderer.
 *
 * Reads every snapshot under `traces/metrics/snapshots/`, computes the
 * seven indicator groups (metrics-model.mjs) from the NEWEST snapshot,
 * derives the snapshot-over-snapshot headline trend from the whole series,
 * and writes one self-contained dark-theme HTML report under
 * `traces/metrics/reports/`. Offline by design: no key, no network — any
 * machine with the snapshots (or just the report file) can read the data.
 *
 * Usage:
 *   node scripts/metrics/build-metrics-report.mjs [--out <path>]
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { computeMetricsModel, computeSnapshotHeadline } from './metrics-model.mjs'

function metricsDir() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return join(repoRoot, 'traces', 'metrics')
}

// ---------- formatting helpers ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`)
const num = (v) => (v === null || v === undefined ? '—' : String(v))
const mins = (ms) => (ms > 0 ? `${Math.round(ms / 60000)} min` : '0')

/** Compact delta arrow vs a previous numeric value (▲ up / ▼ down / =). */
export function deltaArrow(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return ''
  if (current > previous) return ` <span class="up">▲</span>`
  if (current < previous) return ` <span class="down">▼</span>`
  return ' <span class="flat">=</span>'
}

// ---------- report assembly (pure: model + trend in, HTML out) ----------

export function renderReportHtml({ model, trend, snapshotCount, generatedAt }) {
  const prev = trend.length >= 2 ? trend[trend.length - 2] : null
  const head = trend[trend.length - 1] ?? null
  const trendRows = trend
    .map(
      (t, i) => `<tr><td>${esc((t.pulledAt ?? '').slice(0, 16).replace('T', ' '))}</td><td>${esc(t.asOf ?? '')}</td><td>${num(t.dau)}${deltaArrow(t.dau, trend[i - 1]?.dau)}</td><td>${num(t.wau)}${deltaArrow(t.wau, trend[i - 1]?.wau)}</td><td>${num(t.mau)}</td><td>${pct(t.wauMau)}</td><td>${pct(t.crashFreeSessions7d)}</td><td>${num(t.northStar)}${deltaArrow(t.northStar, trend[i - 1]?.northStar)}</td></tr>`
    )
    .join('\n')
  const adoptionRows = model.adoption
    .map((a) => `<tr><td><code>${esc(a.feature)}</code></td><td>${num(a.cumulative)}</td><td>${pct(a.rate)}</td><td>${num(a.last7d)}</td></tr>`)
    .join('\n')
  const weeklyRows = model.weeklyTrend
    .slice(-12)
    .map((w) => `<tr><td>${esc(w.week)}</td><td>${num(w.actives)}</td><td>${num(w.sessions)}</td><td>${pct(w.crashFreeRate)}</td><td><strong>${num(w.agentUsers)}</strong></td><td>${num(w.prompts)}</td></tr>`)
    .join('\n')
  const versionRows = model.versions.rows
    .map((v) => `<tr><td><code>${esc(v.version ?? 'unknown')}</code></td><td>${num(v.users)}</td></tr>`)
    .join('\n')
  const platformRows = model.platforms
    .map((p) => `<tr><td><code>${esc(p.platform ?? 'unknown')}</code></td><td>${num(p.users)}</td></tr>`)
    .join('\n')
  const recoveredRows = Object.entries(model.stability.recovered7d)
    .map(([kind, count]) => `<tr><td><code>${esc(kind)}</code></td><td>${num(count)}</td></tr>`)
    .join('\n')
  const updateRows = Object.entries(model.updateHealth.totals30d)
    .map(([event, count]) => `<tr><td><code>${esc(event)}</code></td><td>${num(count)}</td></tr>`)
    .join('\n')

  // Auto findings: mechanical observations, not analysis
  const findings = []
  if (prev && head) {
    if (head.northStar < prev.northStar) findings.push('North Star（每周活跃 Agent 用户）较上一快照下降。')
    if (head.crashFreeSessions7d !== null && prev.crashFreeSessions7d !== null && head.crashFreeSessions7d < prev.crashFreeSessions7d)
      findings.push('无崩溃会话率（7 天窗口）较上一快照下降。')
    if (head.wau < prev.wau) findings.push('WAU 较上一快照下降。')
  }
  if (model.sessions.crashFreeRate7d !== null && model.sessions.crashFreeRate7d < 0.995)
    findings.push('无崩溃会话率低于 99.5% 行业基准线。')
  if (findings.length === 0) findings.push('本期无自动预警。')

  return `<!DOCTYPE html>
<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Onward 数据指标报告 — ${esc(model.asOf ?? '')}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--text:#d7dce3;--dim:#8b93a1;--accent:#4f9cf9;--green:#34d399;--amber:#fbbf24;--red:#f87171;--border:#2a2f3a}
*{box-sizing:border-box}html{scroll-behavior:auto}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14.5px;line-height:1.7}
nav#toc{position:fixed;top:0;left:0;width:240px;height:100vh;overflow-y:auto;background:var(--panel);border-right:1px solid var(--border);padding:22px 12px;font-size:13px}
nav#toc h2{font-size:13px;color:var(--dim);margin:0 0 10px 8px}
nav#toc a{display:block;color:var(--dim);text-decoration:none;padding:5px 10px;border-radius:6px}
nav#toc a:hover{background:rgba(79,156,249,.15);color:var(--text)}
nav#toc a.active{background:rgba(79,156,249,.22);color:var(--accent);font-weight:600}
main{margin-left:240px;max-width:960px;padding:36px 44px 70px}
@media(max-width:900px){nav#toc{display:none}main{margin-left:0;padding:20px}}
h1{font-size:24px;border-bottom:2px solid var(--accent);padding-bottom:10px}
h2{font-size:19px;margin-top:40px;padding-left:12px;border-left:4px solid var(--accent)}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left}
th{background:var(--panel2)}
tr:nth-child(even) td{background:rgba(255,255,255,.02)}
code{background:#12141a;border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:12.5px;color:#9fd0ff}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.kpi .v{font-size:26px;font-weight:700;color:var(--accent)}
.kpi.ns .v{color:var(--green)}
.kpi .l{font-size:12px;color:var(--dim)}
.up{color:var(--green)}.down{color:var(--red)}.flat{color:var(--dim)}
.callout{border-left:4px solid var(--amber);background:rgba(251,191,36,.08);border-radius:0 8px 8px 0;padding:10px 16px;margin:14px 0}
.meta{margin-top:50px;border-top:1px dashed var(--border);padding-top:16px;font-size:12px;color:var(--dim)}
</style>
</head>
<body>
<nav id="toc"><h2>目录</h2>
<a href="#s-ns">North Star 与要点</a>
<a href="#s-scale">1. 规模</a>
<a href="#s-retention">2. 粘性与留存</a>
<a href="#s-sessions">3. 时长与强度</a>
<a href="#s-adoption">4. 功能采用</a>
<a href="#s-usage">4b. 功能使用深度</a>
<a href="#s-stability">5. 稳定性</a>
<a href="#s-update">6. 更新健康</a>
<a href="#s-trend">7. 历史趋势</a>
</nav>
<main>
<h1>Onward 数据指标报告</h1>
<p>数据截至 <strong>${esc(model.asOf ?? '未知')}</strong>（UTC）· 生成于 ${esc(generatedAt)} · 快照序列共 ${snapshotCount} 期</p>

<h2 id="s-ns">North Star 与要点</h2>
<div class="kpis">
<div class="kpi ns"><div class="v">${num(model.northStar.currentWeek?.count ?? 0)}</div><div class="l">North Star：本周活跃 Agent 用户</div></div>
<div class="kpi"><div class="v">${num(model.scale.dau)}</div><div class="l">DAU（截止日）</div></div>
<div class="kpi"><div class="v">${num(model.scale.wau)}</div><div class="l">WAU</div></div>
<div class="kpi"><div class="v">${pct(model.sessions.crashFreeRate7d)}</div><div class="l">无崩溃会话率（${num(model.windowDays)} 天）</div></div>
</div>
<div class="callout"><strong>数据要点：</strong><ul>${findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>

<h2 id="s-scale">1. 规模</h2>
<table>
<tr><th>DAU</th><th>WAU</th><th>MAU</th><th>累计安装</th><th>DAU/MAU</th><th>WAU/MAU</th></tr>
<tr><td>${num(model.scale.dau)}</td><td>${num(model.scale.wau)}</td><td>${num(model.scale.mau)}</td><td>${num(model.scale.totalInstalls)}</td><td>${pct(model.scale.dauMau)}</td><td>${pct(model.scale.wauMau)}</td></tr>
</table>
<table>
<tr><th colspan="2">版本分布（${esc(model.versions.day ?? '—')}）</th><th colspan="2">平台分布（全周期）</th></tr>
<tr><td colspan="2"><table>${versionRows || '<tr><td>无数据</td></tr>'}</table></td><td colspan="2"><table>${platformRows || '<tr><td>无数据</td></tr>'}</table></td></tr>
</table>

<h2 id="s-retention">2. 粘性与留存</h2>
<table>
<tr><th>指标</th><th>值</th><th>口径</th></tr>
<tr><td>D1 留存</td><td>${pct(model.retention.d1.rate)}</td><td>${num(model.retention.d1.retained)}/${num(model.retention.d1.eligible)} 安装在首日 +1 天有活跃</td></tr>
<tr><td>D7 留存</td><td>${pct(model.retention.d7.rate)}</td><td>${num(model.retention.d7.retained)}/${num(model.retention.d7.eligible)}</td></tr>
<tr><td>D30 留存</td><td>${pct(model.retention.d30.rate)}</td><td>${num(model.retention.d30.retained)}/${num(model.retention.d30.eligible)}</td></tr>
</table>

<h2 id="s-sessions">3. 时长与强度（${num(model.windowDays)} 天窗口）</h2>
<table>
<tr><th>会话数(end)</th><th>会话数(start)</th><th>时长 p50</th><th>时长 p95</th><th>人均日活跃时长</th><th>Prompt 总数</th><th>Agent 启动</th></tr>
<tr><td>${num(model.sessions.total7d)}</td><td>${num(model.sessions.starts7d)}</td><td>${mins(model.sessions.p50Ms7d)}</td><td>${mins(model.sessions.p95Ms7d)}</td><td>${mins(model.engagement.avgActiveMsPerInstallDay)}</td><td>${num(model.engagement.prompts7d)}</td><td>${num(model.engagement.agentLaunches7d)}</td></tr>
</table>
<p style="color:var(--dim);font-size:12.5px">注：session/end 与 crashFree 属性自 2026-07-18 指标重构起才有数据；旧日期区间此表为空是口径切换，不是数据丢失。</p>

<h2 id="s-adoption">4. 功能采用（feature/first-use）</h2>
<table>
<tr><th>功能</th><th>累计首用安装数</th><th>采用率（/累计安装）</th><th>近 ${num(model.windowDays)} 天新增</th></tr>
${adoptionRows || '<tr><td colspan="4">尚无首用数据（P1 埋点随 2026-07-18 版本发布后开始积累）</td></tr>'}
</table>

<h2 id="s-usage">4b. 功能使用深度（feature/use 计数器，${num(model.windowDays)} 天窗口）</h2>
<table>
<tr><th>功能</th><th>总次数</th><th>使用安装数</th></tr>
${model.featureUsage.rows.map((r) => `<tr><td><code>${esc(r.feature)}</code></td><td>${num(r.total)}</td><td>${num(r.installs)}</td></tr>`).join('\n') || '<tr><td colspan="3">尚无功能使用数据（P2 埋点随版本发布后开始积累）</td></tr>'}
</table>
<p>人均触达功能广度（有汇总数据的安装）：<strong>${model.featureUsage.breadthAvg === null ? '—' : model.featureUsage.breadthAvg.toFixed(1)}</strong> 个/安装·日</p>

<h2 id="s-stability">5. 稳定性</h2>
<table>
<tr><th>无崩溃会话率（${num(model.windowDays)} 天）</th><th>无崩溃用户率（${num(model.windowDays)} 天）</th><th>受崩溃影响用户</th></tr>
<tr><td>${pct(model.sessions.crashFreeRate7d)}</td><td>${pct(model.stability.crashFreeUsersRate7d)}</td><td>${num(model.stability.crashedUsers7d)}</td></tr>
</table>
<table>
<tr><th>灰色降级（${num(model.windowDays)} 天）</th><th>次数</th></tr>
${recoveredRows || '<tr><td colspan="2">无降级事件</td></tr>'}
</table>

<h2 id="s-update">6. 更新健康（30 天窗口）</h2>
<table>
<tr><th>事件</th><th>次数</th></tr>
${updateRows || '<tr><td colspan="2">无更新事件</td></tr>'}
</table>
<p>下载 → 安装完成转化率：<strong>${pct(model.updateHealth.installRate30d)}</strong></p>

<h2 id="s-trend">7. 历史趋势</h2>
<h3 style="color:var(--accent);font-size:15px">7.1 按周（最近 12 个 ISO 周，来自最新快照）</h3>
<table>
<tr><th>周</th><th>周活跃安装</th><th>会话数</th><th>无崩溃会话率</th><th>Agent 用户（NS）</th><th>Prompt 总数</th></tr>
${weeklyRows || '<tr><td colspan="6">无数据</td></tr>'}
</table>
<h3 style="color:var(--accent);font-size:15px">7.2 快照对快照（逐期只增；口径统一按当前定义重算）</h3>
<table>
<tr><th>拉取时间</th><th>数据截至</th><th>DAU</th><th>WAU</th><th>MAU</th><th>WAU/MAU</th><th>无崩溃会话率</th><th>North Star</th></tr>
${trendRows || '<tr><td colspan="8">无快照</td></tr>'}
</table>

<div class="meta">生成：scripts/metrics/build-metrics-report.mjs · 指标口径：docs/html/telemetry-metrics-system-redesign.html · 数据源：traces/metrics/snapshots/（本地，不入库）· 本报告为自包含文件，可直接分发</div>
</main>
<script>
(function(){var links=[].slice.call(document.querySelectorAll('nav#toc a'));var secs=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1))});function on(){var p=window.scrollY+90,ai=0;for(var i=0;i<secs.length;i++){if(secs[i]&&secs[i].offsetTop<=p)ai=i}links.forEach(function(a,i){a.classList.toggle('active',i===ai)})}window.addEventListener('scroll',on,{passive:true});on()})();
</script>
</body>
</html>`
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--out': args.out = argv[++i]; break
      case '--snapshots': args.snapshots = argv[++i]; break
      case '--range': {
        const m = /^(\d+)d$/.exec(argv[++i] ?? '')
        if (!m) throw new Error('--range expects Nd (e.g. 7d, 30d, 90d)')
        args.windowDays = Number(m[1])
        break
      }
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const snapDir = args.snapshots || join(metricsDir(), 'snapshots')
  let files = []
  try {
    files = readdirSync(snapDir).filter((f) => f.endsWith('.json')).sort()
  } catch {}
  if (files.length === 0) {
    console.error(`[metrics-report] no snapshots under ${snapDir} — run the pull first:`)
    console.error('  node scripts/metrics/pull-posthog-snapshot.mjs')
    process.exitCode = 1
    return
  }
  const snapshots = files.map((f) => JSON.parse(readFileSync(join(snapDir, f), 'utf-8')))
  const latest = snapshots[snapshots.length - 1]
  const model = computeMetricsModel(latest, { windowDays: args.windowDays })
  const trend = snapshots.map((s) => computeSnapshotHeadline(s))
  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const html = renderReportHtml({ model, trend, snapshotCount: snapshots.length, generatedAt })

  const outDir = join(metricsDir(), 'reports')
  mkdirSync(outDir, { recursive: true })
  const outPath = args.out || join(outDir, `metrics-report-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.html`)
  writeFileSync(outPath, html, 'utf-8')
  console.log(`[metrics-report] report written: ${outPath}`)
  console.log(`[metrics-report] based on ${files.length} snapshot(s); latest pulled at ${latest.pulledAt}`)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[metrics-report] FAILED: ${err.message}`)
    process.exitCode = 1
  })
}
