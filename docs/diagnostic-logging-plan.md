# Bridge Diagnostic Logging Plan

This branch is for logging only. Do not change capture behavior yet.

## Targets

1. Bridge install path
2. Python WebUI/EXTSTATE client path
3. Lua bridge command consumption path
4. Export result and no-selection timing

## Key fields

- request_id
- bridge version
- REAPER version
- executable path
- resource path
- project path
- selected item count
- command key/result key
- export phase
- raw result snapshots
- elapsed time

## Reason

Some packaged builds work on the developer machine but fail on other machines.
The suspected class of issue is environment or timing dependent. Logs should be
collected before changing behavior.
