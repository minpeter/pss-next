---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add update notices and the `pss update` command

The TUI now checks for updates without blocking startup: a cached registry
result in `~/.pss/update-check.json` (24h TTL, written atomically) is read
before the first render, one dim scrollback line announces a newer version
when present, and a stale cache refreshes in the background after the first
render so the startup path performs no network I/O. The version and channel
(`latest` or `next`) are baked at build time, checks skip dev/source runs,
and `PSS_DISABLE_UPDATE_CHECK=1` opts out.

`pss update` re-checks the npm registry's dist-tags and installs the
exact pinned version through the detected package manager. Channels follow
the installed version: stable installs track `latest`, and any prerelease
tracks its own dist-tag (`next`, `beta`, `canary`, or any published tag),
with explicit `--channel <tag>` moves allowed toward stable or across
prerelease channels and refused from stable to prerelease. Package managers
(pnpm/npm/bun/yarn today) are described in a single descriptor registry —
detection patterns, probes, and install arguments — so new managers are one
data entry. dlx/npx/bunx one-off runs and unknown layouts are refused with
manual instructions. `pss update --check` prints the current version,
channel, install method, and the exact command without changing anything.

With `PSS_AUTO_UPDATE=1`, an in-channel, same-major update on a
confidently detected global install is installed automatically after the TUI
exits — never during a session and never as a channel switch.

The TUI web-tools availability warning now renders through the same dim
scrollback seam instead of a pre-start `console.warn`.
