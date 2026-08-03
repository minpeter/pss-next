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
FIRST_SHOT = [87.8, 95.4, 82.9, 90.6]
THREE_TURN = [96.2, 99.6, 84.2, 97.9]
RECOVERY = [69.0, 90.9, 7.3, 77.3]
SCORED = ["238/240", "240/240", "240/240", "233/240"]
FIRST_COUNTS = ["209/238", "229/240", "199/240", "211/233"]
THREE_TURN_COUNTS = ["229/238", "239/240", "202/240", "228/233"]
RECOVERY_COUNTS = ["20/29", "10/11", "3/41", "17/22"]

fig, (ax_pass, ax_recovery) = plt.subplots(
    1,
    2,
    figsize=(14, 7.4),
    gridspec_kw={"width_ratios": [1.35, 1.0]},
)
fig.patch.set_facecolor("white")

positions = list(range(len(FORMATS)))
width = 0.36
first_bars = ax_pass.bar(
    [position - width / 2 for position in positions],
    FIRST_SHOT,
    width,
    color="#8aa6c1",
    label="1턴 성공률",
    zorder=3,
)
final_bars = ax_pass.bar(
    [position + width / 2 for position in positions],
    THREE_TURN,
    width,
    color="#C0392B",
    label="3턴 최종 성공률",
    zorder=3,
)
for bars, values, counts in (
    (first_bars, FIRST_SHOT, FIRST_COUNTS),
    (final_bars, THREE_TURN, THREE_TURN_COUNTS),
):
    for bar, value, count in zip(bars, values, counts):
        ax_pass.text(
            bar.get_x() + bar.get_width() / 2,
            value + 1.0,
            f"{value:.1f}%\n({count})",
            ha="center",
            va="bottom",
            fontsize=9.5,
            color="#34495e" if bars is first_bars else "#7a1f16",
            fontweight="bold" if bars is final_bars else "normal",
        )

ax_pass.set_xticks(positions)
ax_pass.set_xticklabels(FORMATS, fontsize=11)
ax_pass.set_ylim(0, 112)
ax_pass.set_ylabel("통과율 (%)", fontsize=12)
ax_pass.set_title("1턴 성공률과 3턴 최종 성공률", fontsize=13, pad=12)
ax_pass.yaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
ax_pass.set_axisbelow(True)
for spine in ("top", "right"):
    ax_pass.spines[spine].set_visible(False)
for spine in ("left", "bottom"):
    ax_pass.spines[spine].set_color("#b8c0c8")
ax_pass.legend(loc="lower left", frameon=False, fontsize=10.5)

recovery_bars = ax_recovery.barh(
    positions,
    RECOVERY,
    color=["#4f81a8", "#2e8b57", "#c66b5d", "#7b5aa6"],
    zorder=3,
)
for bar, value, count in zip(recovery_bars, RECOVERY, RECOVERY_COUNTS):
    ax_recovery.text(
        value + 1.5,
        bar.get_y() + bar.get_height() / 2,
        f"{value:.1f}% ({count})",
        va="center",
        fontsize=10.5,
        color="#3a3a3a",
        fontweight="bold",
    )
ax_recovery.set_yticks(positions)
ax_recovery.set_yticklabels(FORMATS, fontsize=11)
ax_recovery.invert_yaxis()
ax_recovery.set_xlim(0, 108)
ax_recovery.set_xlabel("복구율 (%)", fontsize=12)
ax_recovery.set_title("1턴 실패 후 3턴 내 복구율", fontsize=13, pad=12)
ax_recovery.xaxis.grid(True, color="#d8dde3", lw=0.8, zorder=0)
ax_recovery.set_axisbelow(True)
for spine in ("top", "right"):
    ax_recovery.spines[spine].set_visible(False)
for spine in ("left", "bottom"):
    ax_recovery.spines[spine].set_color("#b8c0c8")

fig.suptitle(
    "minimax m3 × 4 edit formats — read_file + 누적 상태, runs=10",
    fontsize=15,
    y=0.98,
)
fig.text(
    0.5,
    0.015,
    "각 포맷의 scored 모집단은 request 실패를 제외한 값입니다. "
    "복구율 = 1턴 실패 중 2~3턴 내 최종 성공. "
    "최대 3 recovery turns, temperature 0, thinking off.",
    ha="center",
    fontsize=9.5,
    color="#555",
)

fig.tight_layout(rect=[0, 0.06, 1, 0.95])
out = "assets/m3-recovery-runs10.png"
fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")
print(f"wrote {out}")
