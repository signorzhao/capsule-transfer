# Isolated Render Worker Plan

## Background

Current branch `focus-safe-reaper-bridge` is functionally stable, but preview rendering still occurs inside the user's active REAPER instance.

Current render flow:

- Create temporary project tab
- Open generated capsule RPP
- Execute render action
- Close temporary tab
- Restore original project

This causes macOS window/frame side effects:

- REAPER exits fullscreen/maximized mode
- Window may restore to small frame
- Focus and AppKit state may change
- Project tabs and UI state are touched

The issue is architectural rather than a small UI bug.

---

## Goal

Implement a completely isolated background render worker.

Requirements:

- Never touch the user's active REAPER session
- Never open project tabs in the current REAPER instance
- Never modify the user's real REAPER configuration
- Never steal focus from Capsule Transfer UI
- Never change REAPER fullscreen/window state
- Preserve current stable export flow as fallback

---

## New Architecture

### Current REAPER instance responsibilities

Allowed:

- Collect selected items
- Copy media files
- Generate capsule RPP
- Generate metadata

Forbidden:

- Main_openProject()
- Render actions
- Project tab switching
- Closing project tabs
- SelectProjectInstance()

---

## Render Worker

Use a separate REAPER process:

REAPER -cfgfile isolated.ini -renderproject capsule.rpp

Important:

- Dedicated isolated cfgfile
- Separate worker environment
- No session restore
- No recent projects
- No project tabs

---

## Isolated Config Strategy

DO NOT modify the user's real REAPER config.

Instead create a dedicated worker config directory:

~/Library/Application Support/CapsuleTransfer/render-worker/

Possible files:

- reaper.ini
- reaper-render.ini
- plugin cache files

Suggested ini values:

loadlastproj=0
projecttabs=0
newprojtmpl=

Potential optional settings:

- dummy audio device
- audiocloseinactive=1

---

## Branch Strategy

Stable branch:

- focus-safe-reaper-bridge

Experimental branch:

- isolated-render-worker

The stable branch must remain usable.

---

## Development Strategy

Phase 1:

Keep legacy render path.

Pseudo structure:

if USE_RENDER_WORKER then
    worker render
else
    legacy render
end

This guarantees fallback safety.

---

## Future Settings

Possible future config:

{
  "render_mode": "legacy" | "worker"
}

Default should remain:

legacy

Until worker render is fully stable.

---

## Open Problems To Solve

1. macOS fullscreen/window side effects
2. Background render completion detection
3. Render worker lifecycle management
4. Plugin scan/VST path handling
5. Crash recovery
6. Render timeout handling
7. NSWorkspace launch behavior
8. Audio device handling
9. ffmpeg fallback path
10. Worker process cleanup

---

## Important Principle

Do not continue patching:

- window restore hacks
- focus hacks
- fake activation
- tab restore logic

The long-term solution is isolated render architecture.
