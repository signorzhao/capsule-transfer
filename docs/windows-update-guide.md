# Windows Portable Update Guide

This guide describes how to publish and test Windows portable updates for Capsule LAN.

## Update Model

The desktop app reads these files from the app directory:

- `version.json`: current local version and build number.
- `update-config.json`: update source configuration.

The updater checks `latest_path` from `update-config.json`, reads `latest.json`, compares builds, copies the package to a temp directory, verifies SHA256, starts `capsule-updater.exe`, closes the app, replaces files, then relaunches the app.

An update is available only when:

```text
latest.json build > local version.json build
```

Example:

```json
{
  "version": "0.7.1",
  "build": 701,
  "channel": "stable"
}
```

## Build From GitHub Actions

Push a version tag to trigger the release workflow:

```powershell
git tag v0.7.2
git push origin v0.7.2
```

Use numeric tags only, such as:

```text
v0.7.2
v0.8.0
v1.0.0
```

Do not use suffixes like `v0.7.2-test`, because the workflow calculates `build` from numeric version parts.

After the workflow finishes, download these files from the GitHub Release:

```text
Capsule-LAN-v0.7.2-windows-x64-portable.zip
latest.json
```

The `.zip.sha256` file is optional for manual verification. The app uses the SHA256 stored in `latest.json`.

## File Server Layout

Put the release zip and `latest.json` in the same directory on your file server.

Example local test feed:

```text
C:\capsule-update-feed\
  Capsule-LAN-v0.7.2-windows-x64-portable.zip
  latest.json
```

Example Windows file share feed:

```text
\\SERVER\CapsuleUpdates\
  Capsule-LAN-v0.7.2-windows-x64-portable.zip
  latest.json
```

The package zip must contain a top-level folder named exactly:

```text
Capsule LAN
```

Correct zip structure:

```text
Capsule-LAN-v0.7.2-windows-x64-portable.zip
  Capsule LAN\
    Capsule LAN.exe
    capsule-updater.exe
    flask-backend.exe
    version.json
    update-config.json
    data-pipeline\
    webapp\
```

Incorrect structure:

```text
Capsule-LAN-v0.7.2-windows-x64-portable.zip
  Capsule LAN.exe
  capsule-updater.exe
  ...
```

## latest.json

The GitHub tag workflow creates `latest.json` automatically.

Example:

```json
{
  "channel": "stable",
  "app": "Capsule LAN",
  "version": "0.7.2",
  "build": 702,
  "notes": [
    "Improved Windows update installation experience."
  ],
  "platforms": {
    "windows-x64-portable": {
      "url": "Capsule-LAN-v0.7.2-windows-x64-portable.zip",
      "sha256": "replace-with-package-sha256",
      "size": 20962456
    }
  }
}
```

If you rename the zip, you must also update:

- `platforms.windows-x64-portable.url`
- `platforms.windows-x64-portable.sha256`
- `platforms.windows-x64-portable.size`

For local testing, calculate SHA256 with:

```powershell
Get-FileHash "C:\capsule-update-feed\Capsule-LAN-v0.7.2-windows-x64-portable.zip" -Algorithm SHA256
```

## update-config.json

For local testing:

```json
{
  "latest_path": "C:\\capsule-update-feed\\latest.json",
  "allowed_source_prefixes": [],
  "channel": "stable"
}
```

For a file server:

```json
{
  "latest_path": "\\\\SERVER\\CapsuleUpdates\\latest.json",
  "allowed_source_prefixes": [],
  "channel": "stable"
}
```

The current updater expects filesystem paths, such as a local directory or a Windows shared folder. Do not use an HTTP URL unless the updater has been extended to support HTTP downloads.

## allowed_source_prefixes

When `allowed_source_prefixes` is empty:

```json
"allowed_source_prefixes": []
```

the package must be in the same directory as `latest.json`.

If the zip is stored somewhere else, add an allowed prefix:

```json
{
  "latest_path": "C:\\capsule-update-feed\\latest.json",
  "allowed_source_prefixes": [
    "D:\\capsule-packages\\"
  ],
  "channel": "stable"
}
```

Then `latest.json` can point to:

```json
"url": "D:\\capsule-packages\\Capsule-LAN-v0.7.2-windows-x64-portable.zip"
```

## Protected Files During Update

The updater preserves:

- `data`
- `logs`
- `backups`
- `config.json`
- `update-config.json`
- `.env`

Everything else in the app directory can be replaced by the update package.

## Testing Steps

1. Put the release zip and `latest.json` in the update feed directory.
2. Edit the old app's `update-config.json` to point to the feed.
3. Start the old `Capsule LAN.exe`.
4. Open settings and click `Check update`.
5. Click `Update now`.
6. The app should close, install, and relaunch.
7. Confirm `version.json` has the new version and build.

## Logs

Updater logs are written to:

```text
<app-dir>\logs\update.log
```

Useful log lines:

```text
update started
waiting for process <pid> to exit
process <pid> exited
stopping backend
creating backup
extracting package
replacing application files
relaunching <app-dir>\Capsule LAN.exe
update completed
```

Backups are stored in:

```text
<app-dir>\backups\
```

Only the newest backup is kept automatically.

## Common Problems

If the app says the update package failed:

- Confirm the zip file name exactly matches `latest.json` `url`.
- Confirm the zip SHA256 matches `latest.json` `sha256`.
- Confirm the zip has top-level `Capsule LAN\`.
- Confirm `latest.json build` is greater than local `version.json build`.
- Confirm `capsule-updater.exe` exists in the old app directory.
- Check `<app-dir>\logs\update.log`.
