# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""
Orchestrator watchdog self-check.

Locks the full-regression orchestrator's TIMEOUT enforcement by driving the REAL
run_one() from run-full-regression.py against three injected-hang fixtures. This
exists because the previous design trusted the inner run-with-timeout.mjs +
stdout-EOF entirely: a runner whose tree did not fully die (a surviving/detached
grandchild holding the stdout pipe) blocked the read loop forever and the
configured timeout never took effect. The three cases below pin the two-layer fix
so that regression can never silently come back:

  A  inner-timer kill            -> rc 124  (run-with-timeout.mjs reaps the tree)
  B  grandchild-holds-pipe       -> rc 0 fast (main thread waits on the PROCESS,
                                     not on the pipe reaching EOF; OLD code hung)
  C  orchestrator-watchdog fire  -> rc 124  (independent deadline force-kills the
                                     tree even when the inner layer never exits)

App-independent: no dev app is launched. Hang fixtures live in the OS temp dir and
are removed in `finally`. Exit 0 only if all three cases pass.
"""
import importlib.util
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
rfr_path = REPO / "test" / "autotest" / "run-full-regression.py"
spec = importlib.util.spec_from_file_location("rfr_under_test", str(rfr_path))
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod  # dataclass machinery needs the module registered
spec.loader.exec_module(mod)

bash = mod.find_bash()
node = mod.find_node()
tmp = Path(tempfile.mkdtemp(prefix="onward-watchdog-selftest."))
APP = "OnwardWatchdogSelfTestFakeApp"  # never launched; harmless if kill_app fires
results = []


def write_sh(name, body):
    p = tmp / name
    p.write_text("#!/usr/bin/env bash\n" + body + "\n", encoding="utf-8")
    return p


def run(script, timeout, grace=None):
    # The hang script's path is its own override key; mutating the imported copy
    # of the module only affects THIS process, never the enclosing orchestrator.
    mod.PER_SCRIPT_TIMEOUT_OVERRIDES_SEC[str(script)] = timeout
    saved = mod.ORCHESTRATOR_WATCHDOG_GRACE_SEC
    if grace is not None:
        mod.ORCHESTRATOR_WATCHDOG_GRACE_SEC = grace
    sfh = (tmp / (script.stem + ".summary.log")).open("w", encoding="utf-8")
    try:
        return mod.run_one(
            script=str(script), bash=bash, node=node, app_bin=Path("FakeApp"),
            app_name=APP, user_data_dir=str(tmp),
            log_path=tmp / (script.stem + ".log"), summary_fh=sfh, extra_args=[],
        )
    finally:
        sfh.close()
        mod.ORCHESTRATOR_WATCHDOG_GRACE_SEC = saved


try:
    # A: foreground hang; the inner run-with-timeout.mjs timer must kill it -> 124.
    a = write_sh("hangA.sh", "sleep 60")
    rcA, elA = run(a, timeout=3)
    results.append(("A inner-timer kill", rcA == 124 and elA < 25,
                    f"rc={rcA} elapsed={elA:.1f}s (expect 124, <25s)"))

    # B: grandchild holds the stdout pipe; bash exits 0 fast. The OLD code blocked
    # ~30s on `for line in proc.stdout` (pipe never EOFs); the NEW code waits on the
    # PROCESS and returns ~instantly. This is the exact regression class to lock.
    b = write_sh("hangB.sh", "sleep 30 &\ndisown 2>/dev/null || true\nexit 0")
    rcB, elB = run(b, timeout=3)
    results.append(("B grandchild-holds-pipe no-hang", rcB == 0 and elB < 18,
                    f"rc={rcB} elapsed={elB:.1f}s (expect 0, <18s; OLD code ~30s)"))

    # C: force the orchestrator watchdog (deadline < inner timer): grace=-50,
    # inner=60s -> deadline=10s. The watchdog must force-kill the tree -> 124,
    # well before the inner 60s timer is ever reached.
    c = write_sh("hangC.sh", "sleep 300")
    rcC, elC = run(c, timeout=60, grace=-50)
    results.append(("C orchestrator-watchdog force-kill", rcC == 124 and 5 <= elC < 30,
                    f"rc={rcC} elapsed={elC:.1f}s (expect 124, ~10s, inner=60s never reached)"))
finally:
    shutil.rmtree(str(tmp), ignore_errors=True)

print("\n=== ORCHESTRATOR WATCHDOG SELF-CHECK ===")
allok = len(results) == 3
for name, ok, detail in results:
    allok = allok and ok
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
print("OVERALL:", "PASS" if allok else "FAIL")
sys.exit(0 if allok else 1)
