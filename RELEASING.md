# Installing and updating Grow Board

Two separate things:

1. **Installing** — putting the app on the shop PC with a Start-menu entry and
   Windows startup. Works today, no accounts needed.
2. **Auto-update** — the app checking GitHub for new versions. Already wired to
   `vikashpatel04/Grow-board`. It starts working the moment the first release
   is published; until then the app checks, finds nothing, and stays quiet.

---

## 1. Install it

The installer is built and ready:

```
D:\Grow-board\dist\GrowBoard-Setup-1.0.0.exe   (83 MB)
```

Double-click it. It installs per-user (no administrator prompt), creates a
desktop and Start-menu shortcut, and lets you choose the folder.

> **Windows will show a blue "Windows protected your PC" warning.** That is
> SmartScreen reacting to an installer that is not code-signed, not a virus
> warning. Click **More info → Run anyway**. Removing the warning permanently
> needs a code-signing certificate (roughly ₹15,000–30,000 a year from a
> certificate authority); it is optional and changes nothing about how the app
> works.

### After installing — two one-time steps

1. **Enter the database password.** Open Grow Board → **Settings** →
   *Connection* → type the password for `dev_readonly` → **Save password and
   reconnect**.

   The password is deliberately not inside the installer. Release files are
   published publicly on GitHub for auto-update, so anything bundled in them is
   public too. It is stored encrypted under
   `%APPDATA%\Grow Board` on this PC only.

2. **Turn on Windows startup.** Settings → *Application* → tick
   **Start automatically with Windows**, and optionally **Start hidden in the
   system tray** so it comes up quietly in the background.

That is it. Closing the window keeps it in the tray so notifications still
arrive. Quit fully from the tray icon.

---

## 2. Auto-update is now switched on

The app is wired to **https://github.com/vikashpatel04/Grow-board** (public).
Nothing more to configure:

```json
"update": { "enabled": true, "owner": "vikashpatel04", "repo": "Grow-board",
            "autoDownload": true, "checkEveryHours": 6 }
```

Because the repository is public, the shop PC needs no token or login to
receive updates. Verified against the live repository: the app connects, finds
no release yet, and stays silent rather than showing an error.

### Why GitHub Desktop alone was not enough

GitHub Desktop installs Git Credential Manager, which is why `git push` works
with no prompt. But publishing a *release* does not go through git -
electron-builder uploads through the GitHub REST API and needs a token in
`GH_TOKEN`, which Credential Manager does not expose. GitHub CLI closes that
gap, once, for every project.

### Publishing is set up machine-wide

GitHub CLI is installed and `C:\Users\Admin\bin\with-gh-token` is on your PATH,
so **this works in every project on this PC, not just Grow Board**.

One-time, once per machine:

```bash
gh auth login          # opens the browser; choose HTTPS and authorise
gh auth setup-git      # routes git push/pull through gh for every repo
```

After that, in any project:

```bash
npm run release        # builds and publishes to GitHub Releases
```

`with-gh-token` reads the token fresh from Windows Credential Manager, hands it
to the build for that one command, and discards it. Nothing secret is written
to a file, the registry or your shell, so a token can never end up in a commit.
See `C:\Users\Admin\bin\README.md`.

#### If you would rather not use the CLI

Everything is already built, so you can publish by hand instead:

1. `npm run build`
2. Go to <https://github.com/vikashpatel04/Grow-board/releases/new>
3. Tag: `v1.0.0` (must match `package.json`, with a leading `v`)
4. Title and description: plain words - the shop reads this in the update prompt
5. Drag in **all three** files from `D:\Grow-board\dist\`:
   - `GrowBoard-Setup-1.0.0.exe`
   - `GrowBoard-Setup-1.0.0.exe.blockmap`
   - `latest.yml`
6. Publish release

`latest.yml` is the file the app polls. Leave it out and updates never appear.

## 3. Shipping a new version

```bash
# 1. bump the version - auto-update compares this number
npm version patch          # 1.0.0 -> 1.0.1   (or: minor / major)

# 2. build and publish in one step
npm run release
```

`npm version patch` also creates a git commit and a `v1.0.1` tag; push them
with `git push --follow-tags`.

`npm run release` builds the installer and uploads three files to a new GitHub
release: the `.exe`, `latest.yml` (the feed the app reads) and `.blockmap`
(which lets the app download only the changed parts of the next update).

**All three must be in the release.** `npm run release` does that
automatically; if you ever upload by hand, do not omit `latest.yml`.

### What the shop sees

- Grow Board checks GitHub 8 seconds after starting, then every 6 hours.
- A newer version downloads quietly in the background — a thin bar appears at
  the top of the window showing progress. Nothing is interrupted.
- When it is ready the app **asks**, showing the version and the release notes:

  > **Grow Board 1.0.1 is ready to install.**
  > You are on 1.0.0.
  > What's new: • faster stock page • supplier ageing chart
  >
  > `[ Install and restart ]` `[ Later ]`

- Choosing *Later* leaves it downloaded; it asks again next start, and there is
  an **Install and restart** button on Settings → Updates whenever you want it.
- Nothing installs without you clicking. An update can never interrupt billing.

Release notes come from the GitHub release body, so write it in plain language —
that text is what the shop reads.

---

## 4. Checking it works

```bash
npm run check         # database connection
npm run probe         # all 20 metrics against the live data
npm run selftest      # renders all 9 pages, reports any error
npm run test:readonly # proves the app cannot write to the POS
```

All four are safe to run while the shop is trading.

To test the update path end to end: publish `1.0.1` from this machine, then
open the installed `1.0.0` on the shop PC — within a few seconds the bar
appears, and the prompt follows once the download finishes.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "No database password saved on this machine" | Enter it once in Settings → Connection. |
| Sidebar says **Not connected** | SQL Server is not running, or TCP/IP is disabled in SQL Server Configuration Manager. `npm run check` prints the exact error. |
| Updates never appear | `update.enabled` is false, or `owner`/`repo` are empty. Settings → Updates says so plainly. |
| Update check fails silently | Normal when the PC is offline. The app ignores network errors rather than nagging. |
| SmartScreen blocks the installer | Expected for an unsigned installer. More info → Run anyway. |
| Build fails on `winCodeSign` symlinks | A known electron-builder issue on Windows without Developer Mode. The cache at `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` has already been populated on this machine, which is why builds now succeed. If it ever returns, extract any `winCodeSign*.7z` in that folder into a directory of that name and ignore the two macOS symlink errors. |
