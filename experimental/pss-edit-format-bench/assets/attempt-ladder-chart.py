#!/usr/bin/env python3
"""Attempt-ladder chart for RESEARCH-EDIT-TOOLS.md §9.

Hardcoded measurements, sources (all minimax x pss-json, 24 tasks x 3 runs,
--recovery 3):
- Oracle-fed m3 (removed 2026-08-03): minimax-pss-recovery-3runs.txt
- Tool-protocol m3 (no read_file): minimax-pss-recovery-toolproto-3runs.txt
- Tool-protocol m2.7 (no read_file): minimax-m27-pss-recovery-toolcall-3runs.txt
- read_file m3: minimax-m3-pss-recovery-readfile-3runs.txt
- read_file m2.7: minimax-m27-pss-recovery-readfile-3runs.txt
  (all under .omo/evidence/20260802-edit-bench-recovery/)

Run: uv run --with matplotlib python3 assets/attempt-ladder-chart.py
"""

from __future__ import annotations

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

for fname in (
    "/usr/share/fonts/truetype/nanum/NanumSquareRoundB.ttf",
    "/usr/share/fonts/truetype/nanum/NanumSquareRoundR.ttf",
):
    font_manager.fontManager.addfont(fname)
plt.rcParams["font.family"] = ["NanumSquareRound", "Noto Sans CJK KR", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

STEPS = [1, 2, 3]
ORACLE = [94.3, 95.7, 95.7]
M3 = [97.0, 97.0, 97.0]
M27 = [65.3, 65.3, 65.3]
M3_READFILE = [81.4, 92.9, 95.7]
M27_READFILE = [65.3, 69.4, 73.6]

fig, ax = plt.subplots(figsize=(12, 7.2))
fig.patch.set_facecolor("white")

ax.plot(STEPS, ORACLE, marker="o", markersize=8, linewidth=2.0, color="#9aa7b5",
        linestyle=":", zorder=2, label="m3 오라클 피드백 (제거됨)")
for xi, yi in zip(STEPS, ORACLE):
    ax.annotate(
        f"{yi:.1f}%", xy=(xi, yi), xytext=(xi - 0.38, yi + 2.0),
        ha="center", fontsize=9.5, color="#7d8896",
    )

ax.plot(STEPS, M3, marker="o", markersize=9, linewidth=2.2, color="#b0665e",
        linestyle="--", zorder=3, label="m3 도구 프로토콜 (read_file 없음)")
ax.annotate(
    f"{M3[0]:.1f}%", xy=(1, M3[0]), xytext=(1.12, M3[0] - 3.6),
    ha="center", fontsize=10, color="#8a4a42",
)

ax.plot(STEPS, M27, marker="s", markersize=9, linewidth=2.2, color="#6b8cab",
        linestyle="--", zorder=3, label="m2.7 도구 프로토콜 (read_file 없음)")
ax.annotate(
    f"{M27[0]:.1f}%", xy=(1, M27[0]), xytext=(1.12, M27[0] + 2.2),
    ha="center", fontsize=10, color="#3d5f7d",
)

ax.plot(STEPS, M3_READFILE, marker="o", markersize=11, linewidth=2.8, color="#C0392B",
        zorder=5, label="m3 read_file + 누적 상태")
for xi, yi, label in zip(STEPS, M3_READFILE, ["81.4%", "92.9%", "95.7%"]):
    ax.annotate(
        label, xy=(xi, yi), xytext=(xi + 0.24, yi + 1.6),
        ha="center", fontsize=11.5, color="#7a1f16", fontweight="bold",
    )

ax.plot(STEPS, M27_READFILE, marker="s", markersize=11, linewidth=2.8, color="#2c5f8a",
        zorder=5, label="m2.7 read_file + 누적 상태")
for xi, yi, label in zip(STEPS, M27_READFILE, ["65.3%", "69.4%", "73.6%"]):
    ax.annotate(
        label, xy=(xi, yi), xytext=(xi + 0.24, yi - 3.6),
        ha="center", fontsize=11.5, color="#1e4464", fontweight="bold",
    )

ax.annotate(
    "read_file 검증 채널 + 누적 상태 적용으로\n복구 곡선이 살아났다\n"
    "(m3 recovery 76.9% / m2.7 recovery 24.0%)",
    xy=(1.6, 92.9), xytext=(1.05, 55.0), fontsize=10.5, color="#7a1f16", ha="left",
    arrowprops=dict(arrowstyle="->", color="#C0392B", lw=1.3),
    bbox=dict(boxstyle="round,pad=0.45", facecolor="#fff5f3", edgecolor="#C0392B", lw=1.0),
)

ax.set_xticks(STEPS)
ax.set_xticklabels([f"{step}회차" for step in STEPS], fontsize=12)
ax.set_ylim(52, 102)
ax.set_ylabel("누적 통과율 (%)", fontsize=12)
ax.set_xlabel("재시도 시도", fontsize=12)
ax.set_title(
    "minimax m3·m2.7 × pss-json — read_file 검증 채널이 복구 곡선을 살린다 (24 tasks × 3 runs)",
    fontsize=13, pad=12,
)
ax.yaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
ax.set_axisbelow(True)
for spine in ("top", "right"):
    ax.spines[spine].set_visible(False)
for spine in ("left", "bottom"):
    ax.spines[spine].set_color("#b8c0c8")
ax.legend(loc="lower right", frameon=False, fontsize=11)

fig.text(
    0.5, 0.02,
    "출처: 라이브 벤치, --recovery 3 (freerouter, temperature 0, thinking off). "
    "read_file m3: 70 scored, 81.4% → 92.9% → 95.7% (복구 10/13 = 76.9%). "
    "read_file m2.7: 72 scored, 65.3% → 69.4% → 73.6% (복구 6/25 = 24.0%). "
    "도구 프로토콜(검증 채널 없음): m3 97.0%→97.0% (0.0%), m2.7 65.3%→65.3% (0.0%). "
    "오라클 m3: 94.3% → 95.7% (25%). 누적 통과율 = n회차 이내 해결 비율.",
    ha="center", fontsize=9.5, color="#555",
)

fig.tight_layout(rect=[0, 0.06, 1, 1])
out = "assets/edit-formats-attempt-ladder.png"
fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")
print(f"wrote {out}")
