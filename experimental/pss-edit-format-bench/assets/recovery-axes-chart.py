#!/usr/bin/env python3
"""Recovery-vs-first-shot independence chart for RESEARCH-EDIT-TOOLS.md §9.

Hardcoded measurements, sources:
- Main bench first-shot rates (48 attempts/cell):
  .omo/evidence/20260802-edit-bench-recovery/bench-2models-2runs.txt
- Recovery demo (2 tasks x 1 run, --recovery 3):
  .omo/evidence/20260802-edit-bench-recovery/recovery-live-demo.txt

Run: uv run --with matplotlib python3 assets/recovery-axes-chart.py
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

MODELS = ["deepseek-v4-flash", "minimax-m3"]
FORMATS = ["pss-json", "omp-dsl", "omp-json", "grok-json"]
FIRST_SHOT = {
    "deepseek-v4-flash": [93.8, 89.6, 85.4, 95.8],
    "minimax-m3": [79.2, 97.9, 72.9, 79.2],
}
RECOVERY_RATE = {
    "deepseek-v4-flash": [None, None, None, 0.0],
    "minimax-m3": [None, None, None, None],
}
COLOR = {"deepseek-v4-flash": "#4C72B0", "minimax-m3": "#DD8452"}
MARKER = {
    "pss-json": "o",
    "omp-dsl": "s",
    "omp-json": "^",
    "grok-json": "D",
}
SHORT = {
    "deepseek-v4-flash": "deepseek",
    "minimax-m3": "minimax",
}

fig, (ax_bar, ax_scat) = plt.subplots(
    1, 2, figsize=(17, 7.2), gridspec_kw={"width_ratios": [1.05, 1.0]}
)
fig.patch.set_facecolor("white")

x = range(len(FORMATS))
width = 0.36
for i, model in enumerate(MODELS):
    offset = (i - 0.5) * width
    bars = ax_bar.bar(
        [xi + offset for xi in x],
        FIRST_SHOT[model],
        width,
        color=COLOR[model],
        label=model,
        zorder=3,
    )
    for bar, value in zip(bars, FIRST_SHOT[model]):
        ax_bar.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 1.2,
            f"{value:.1f}%",
            ha="center",
            va="bottom",
            fontsize=10,
            color="#3a4a5a",
        )
top = ax_bar.patches[3]
top.set_edgecolor("#C0392B")
top.set_linewidth(2.2)
top.set_zorder(4)
ax_bar.annotate(
    "first-shot 최고 (95.8%)",
    xy=(top.get_x() + top.get_width() / 2, top.get_height()),
    xytext=(top.get_x() + top.get_width() / 2 + 0.55, 100),
    fontsize=10,
    color="#C0392B",
    ha="left",
    arrowprops=dict(arrowstyle="->", color="#C0392B", lw=1.4),
)
ax_bar.set_xticks(list(x))
ax_bar.set_xticklabels(FORMATS, fontsize=12)
ax_bar.set_ylim(0, 108)
ax_bar.set_ylabel("first-shot pass rate (%)", fontsize=12)
ax_bar.set_title("first-shot 통과율 — 본 벤치 (24 tasks × 2 runs)", fontsize=13, pad=10)
ax_bar.yaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
ax_bar.set_axisbelow(True)
for spine in ("top", "right"):
    ax_bar.spines[spine].set_visible(False)
for spine in ("left", "bottom"):
    ax_bar.spines[spine].set_color("#b8c0c8")
ax_bar.legend(loc="upper left", frameon=False, fontsize=11)

for model in MODELS:
    for fmt, rate in zip(FORMATS, FIRST_SHOT[model]):
        recovery = RECOVERY_RATE[model][FORMATS.index(fmt)]
        measured = recovery is not None
        marker = MARKER[fmt]
        if measured:
            ax_scat.scatter(
                rate,
                recovery,
                marker=marker,
                s=170,
                color=COLOR[model],
                edgecolors="#C0392B",
                linewidths=2.0,
                zorder=5,
                label=f"{SHORT[model]} × {fmt} (복구율 0%)",
            )
        else:
            ax_scat.scatter(
                rate,
                100.0,
                marker=marker,
                s=150,
                facecolors="none",
                edgecolors=COLOR[model],
                linewidths=1.8,
                zorder=4,
            )
ax_scat.axhspan(50, 112, color="#eaf5ec", zorder=0)
ax_scat.axhspan(-12, 50, color="#fdeeec", zorder=0)
ax_scat.text(
    61.0, 105.5, "복구 가능 (데모 실패 없음 = n/a, 빈 마커)",
    fontsize=10.5, color="#2e7d46", ha="left", va="top",
)
ax_scat.text(
    61.0, 5.0, "막다른 포맷 (dead-end)\n실패 시 재시도로도 복구 불가",
    fontsize=10.5, color="#b03a2e", ha="left", va="bottom",
)
ax_scat.axvline(95.8, color="#C0392B", lw=1.2, ls="--", alpha=0.7)
ax_scat.scatter(95.8, 0.0, marker="D", s=260, color="#C0392B",
                edgecolors="black", linewidths=1.4, zorder=6)
ax_scat.annotate(
    "deepseek × grok-json\npy-append-method 실패 → 3회 재시도 전부 미복구\n"
    "(같은 오류 클래스 indentation 반복 = repeated failure)",
    xy=(95.8, 0.0),
    xytext=(66, 30),
    fontsize=10.5,
    color="#7a1f16",
    ha="left",
    arrowprops=dict(arrowstyle="->", color="#C0392B", lw=1.6),
    bbox=dict(boxstyle="round,pad=0.45", facecolor="#fff5f3", edgecolor="#C0392B", lw=1.0),
)
ax_scat.set_xlim(60, 112)
ax_scat.set_ylim(-12, 112)
ax_scat.set_xlabel("first-shot pass rate — 본 벤치 (%)", fontsize=12)
ax_scat.set_ylabel("recovery rate — 실패 시도 중 복구율 (%)", fontsize=12)
ax_scat.set_title("first-shot 성공률과 복구성은 독립적 축", fontsize=13, pad=10)
ax_scat.xaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
ax_scat.yaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
ax_scat.set_axisbelow(True)
for spine in ("top", "right"):
    ax_scat.spines[spine].set_visible(False)
for spine in ("left", "bottom"):
    ax_scat.spines[spine].set_color("#b8c0c8")
from matplotlib.lines import Line2D
legend_handles = [
    Line2D([0], [0], marker="o", color="none", markerfacecolor=COLOR["deepseek-v4-flash"],
           markeredgecolor=COLOR["deepseek-v4-flash"], markersize=9, label="deepseek-v4-flash"),
    Line2D([0], [0], marker="o", color="none", markerfacecolor=COLOR["minimax-m3"],
           markeredgecolor=COLOR["minimax-m3"], markersize=9, label="minimax-m3"),
    Line2D([0], [0], marker="s", color="none", markerfacecolor="none",
           markeredgecolor="#555", markersize=8, label="빈 마커 = 데모에서 실패 없음 (n/a)"),
]
ax_scat.legend(handles=legend_handles, loc="lower right", frameon=False, fontsize=10)

fig.suptitle(
    "first-shot 성공률 vs 복구성 — deepseek×grok-json은 최고 성적처럼 보이지만 실패 시 막다른 포맷",
    fontsize=14, y=0.99,
)
fig.text(
    0.5, 0.012,
    "본 벤치: 384 attempts (2 models × 4 formats × 24 tasks × 2 runs, freerouter, temperature 0).  "
    "복구 데모: 16 attempts (2 tasks × 1 run, --recovery 3).  "
    "데모에서 실패한 유일한 셀 = deepseek×grok-json의 py-append-method(1/16).  "
    "3회 재시도 모두 같은 오류 클래스(indentation)로 미복구 → recovery rate 0%, repeated-failure.  "
    "나머지 7셀은 데모 실패가 없어 recovery rate n/a(빈 마커).",
    ha="center", fontsize=9.5, color="#555",
)

fig.tight_layout(rect=[0, 0.05, 1, 0.97])
out = "assets/edit-formats-recovery-axes.png"
fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")
print(f"wrote {out}")
