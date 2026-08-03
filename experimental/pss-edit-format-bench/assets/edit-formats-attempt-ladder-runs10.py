#!/usr/bin/env python3
# /// script
# dependencies = ["matplotlib"]
# ///
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
FORMATS = ["pss-json", "omp-dsl", "omp-json", "grok-json"]
COLORS = {
    "pss-json": "#4f81a8",
    "omp-dsl": "#2e8b57",
    "omp-json": "#c66b5d",
    "grok-json": "#7b5aa6",
}
M3 = {
    "pss-json": [87.8, 95.0, 96.2],
    "omp-dsl": [95.4, 99.2, 99.6],
    "omp-json": [82.9, 83.8, 84.2],
    "grok-json": [90.6, 96.1, 97.9],
}
M27 = {
    "pss-json": [65.8, 70.0, 72.9],
    "omp-dsl": [77.9, 84.6, 90.0],
    "omp-json": [96.3, 96.3, 96.7],
    "grok-json": [80.8, 87.9, 94.2],
}
SCORED = {
    "m3": {"pss-json": "238", "omp-dsl": "240", "omp-json": "240", "grok-json": "233"},
    "m2.7": {"pss-json": "240", "omp-dsl": "240", "omp-json": "240", "grok-json": "240"},
}
LABEL_OFFSETS = {
    "m3": {
        "pss-json": [1.4, 1.4, 1.4],
        "omp-dsl": [-2.1, 2.0, 2.0],
        "omp-json": [-2.4, -2.4, -2.4],
        "grok-json": [1.2, 1.2, 1.2],
    },
    "m2.7": {
        "pss-json": [1.4, 1.4, 1.4],
        "omp-dsl": [-2.1, -2.1, -2.1],
        "omp-json": [-2.4, -2.4, -2.4],
        "grok-json": [1.2, 1.2, 1.2],
    },
}
LABEL_X_OFFSETS = {
    "m3": {
        "pss-json": [0.0, -0.1, -0.1],
        "omp-dsl": [0.0, 0.0, 0.0],
        "omp-json": [0.0, 0.0, 0.0],
        "grok-json": [0.0, 0.1, 0.1],
    },
    "m2.7": {
        "pss-json": [0.0, 0.0, 0.0],
        "omp-dsl": [0.0, 0.0, 0.0],
        "omp-json": [0.0, 0.0, 0.0],
        "grok-json": [0.0, 0.0, 0.0],
    },
}

fig, axes = plt.subplots(1, 2, figsize=(15, 7.8), sharey=True)
fig.patch.set_facecolor("white")

for ax, model, data in zip(axes, ("m3", "m2.7"), (M3, M27)):
    for format_name in FORMATS:
        values = data[format_name]
        ax.plot(
            STEPS,
            values,
            marker="o",
            markersize=8.5,
            linewidth=2.5,
            color=COLORS[format_name],
            label=format_name,
            zorder=3,
        )
        for step, value in zip(STEPS, values):
            ax.annotate(
                f"{value:.1f}%",
                xy=(step, value),
                xytext=(
                    step + LABEL_X_OFFSETS[model][format_name][step - 1],
                    value + LABEL_OFFSETS[model][format_name][step - 1],
                ),
                ha=(
                    "right"
                    if LABEL_X_OFFSETS[model][format_name][step - 1] < 0
                    else "left"
                    if LABEL_X_OFFSETS[model][format_name][step - 1] > 0
                    else "center"
                ),
                fontsize=9.5,
                color=COLORS[format_name],
                fontweight="bold" if step == 3 else "normal",
            )
    ax.set_xticks(STEPS)
    ax.set_xticklabels([f"{step}회차" for step in STEPS], fontsize=11)
    ax.set_ylim(60, 103)
    ax.set_xlabel("재시도 시도", fontsize=11)
    ax.set_title(
        f"minimax {model} × 4 formats\n"
        f"(scored: {', '.join(f'{name} {SCORED[model][name]}' for name in FORMATS)})",
        fontsize=12,
        pad=12,
    )
    ax.yaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color("#b8c0c8")
    ax.legend(loc="lower right", frameon=False, fontsize=9.5)

axes[0].set_ylabel("누적 통과율 (%)", fontsize=11)
fig.suptitle(
    "runs=10 — 3턴 recovery ladder: 재시도할수록 누적 통과율이 얼마나 오르는가",
    fontsize=15,
    y=0.98,
)
fig.text(
    0.5,
    0.015,
    "read_file 검증 채널 + 누적 상태 · --recovery 3 · temperature 0 · thinking off · "
    "각 점은 해당 턴 이내 최종 해결 비율",
    ha="center",
    fontsize=9.5,
    color="#555",
)
fig.tight_layout(rect=[0, 0.06, 1, 0.94])

out = "assets/edit-formats-attempt-ladder-runs10.png"
fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")
print(f"wrote {out}")
