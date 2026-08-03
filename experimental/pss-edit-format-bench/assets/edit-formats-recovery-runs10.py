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

FORMATS = ["pss-json", "omp-dsl", "omp-json", "grok-json"]
MODELS = ("m3", "m2.7")
FIRST_SHOT = {
    "m3": [87.8, 95.4, 82.9, 90.6],
    "m2.7": [65.8, 77.9, 96.3, 80.8],
}
THREE_TURN = {
    "m3": [96.2, 99.6, 84.2, 97.9],
    "m2.7": [72.9, 90.0, 96.7, 94.2],
}
RECOVERY = {
    "m3": [69.0, 90.9, 7.3, 77.3],
    "m2.7": [20.7, 54.7, 11.1, 69.6],
}
FIRST_COUNTS = {
    "m3": ["209/238", "229/240", "199/240", "211/233"],
    "m2.7": ["158/240", "187/240", "231/240", "194/240"],
}
THREE_TURN_COUNTS = {
    "m3": ["229/238", "239/240", "202/240", "228/233"],
    "m2.7": ["175/240", "216/240", "232/240", "226/240"],
}
RECOVERY_COUNTS = {
    "m3": ["20/29", "10/11", "3/41", "17/22"],
    "m2.7": ["17/82", "29/53", "1/9", "32/46"],
}

fig, axes = plt.subplots(
    2,
    2,
    figsize=(15, 11),
    gridspec_kw={"width_ratios": [1.35, 1.0]},
)
fig.patch.set_facecolor("white")

positions = list(range(len(FORMATS)))
width = 0.35
format_colors = ["#4f81a8", "#2e8b57", "#c66b5d", "#7b5aa6"]
pass_colors = {
    "m3": ("#8aa6c1", "#C0392B"),
    "m2.7": ("#b5b5b5", "#2c5f8a"),
}

for row, model in enumerate(MODELS):
    ax_pass = axes[row, 0]
    ax_recovery = axes[row, 1]
    first_color, final_color = pass_colors[model]
    first_bars = ax_pass.bar(
        [position - width / 2 for position in positions],
        FIRST_SHOT[model],
        width,
        color=first_color,
        label="1턴 성공률",
        zorder=3,
    )
    final_bars = ax_pass.bar(
        [position + width / 2 for position in positions],
        THREE_TURN[model],
        width,
        color=final_color,
        label="3턴 최종 성공률",
        zorder=3,
    )
    for bars, values, counts in (
        (first_bars, FIRST_SHOT[model], FIRST_COUNTS[model]),
        (final_bars, THREE_TURN[model], THREE_TURN_COUNTS[model]),
    ):
        for bar, value, count in zip(bars, values, counts):
            ax_pass.text(
                bar.get_x() + bar.get_width() / 2,
                value + 1.0,
                f"{value:.1f}%\n({count})",
                ha="center",
                va="bottom",
                fontsize=9.0,
                color="#34495e" if bars is first_bars else "#7a1f16",
                fontweight="bold" if bars is final_bars else "normal",
            )
    ax_pass.set_xticks(positions)
    ax_pass.set_xticklabels(FORMATS, fontsize=10.5)
    ax_pass.set_ylim(0, 112)
    ax_pass.set_ylabel("통과율 (%)", fontsize=11)
    ax_pass.set_title(f"minimax {model} — 1턴 vs 3턴", fontsize=12.5, pad=10)
    ax_pass.yaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
    ax_pass.set_axisbelow(True)
    for spine in ("top", "right"):
        ax_pass.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax_pass.spines[spine].set_color("#b8c0c8")
    ax_pass.legend(loc="lower left", frameon=False, fontsize=9.5)

    recovery_bars = ax_recovery.barh(
        positions,
        RECOVERY[model],
        color=format_colors,
        zorder=3,
    )
    for bar, value, count in zip(
        recovery_bars,
        RECOVERY[model],
        RECOVERY_COUNTS[model],
    ):
        ax_recovery.text(
            value + 1.5,
            bar.get_y() + bar.get_height() / 2,
            f"{value:.1f}% ({count})",
            va="center",
            fontsize=9.8,
            color="#3a3a3a",
            fontweight="bold",
        )
    ax_recovery.set_yticks(positions)
    ax_recovery.set_yticklabels(FORMATS, fontsize=10.5)
    ax_recovery.invert_yaxis()
    ax_recovery.set_xlim(0, 108)
    ax_recovery.set_xlabel("복구율 (%)", fontsize=11)
    ax_recovery.set_title(
        f"minimax {model} — 1턴 실패 후 3턴 내 복구",
        fontsize=12.5,
        pad=10,
    )
    ax_recovery.xaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
    ax_recovery.set_axisbelow(True)
    for spine in ("top", "right"):
        ax_recovery.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax_recovery.spines[spine].set_color("#b8c0c8")

fig.suptitle(
    "4개 edit format의 1턴 성공률과 3턴 복구성 — read_file + 누적 상태, runs=10",
    fontsize=15,
    y=0.985,
)
fig.text(
    0.5,
    0.012,
    "복구율 = 1턴 실패 중 2~3턴 내 최종 성공. 괄호는 scored 성공/전체 또는 "
    "복구 성공/1턴 실패 수. request 실패는 scored에서 제외. temperature 0, thinking off.",
    ha="center",
    fontsize=9.5,
    color="#555",
)
fig.tight_layout(rect=[0, 0.045, 1, 0.96])

out = "assets/edit-formats-recovery-runs10.png"
fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")
print(f"wrote {out}")
