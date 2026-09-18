# Grow Board

A Windows desktop dashboard for **Dhanalakshmi Textiles**, built on the live POS
database. It is a growth tool, not a report viewer: every page opens with a
plain-language verdict, every chart carries a "so what" line, and the Focus page
ranks what to do next by what will move the business most.

**It is strictly read-only.** Grow Board opens the POS database with a read-only
login and issues only `SELECT` statements. It cannot add, change or delete
anything in your POS. All entry — sales, purchases, supplier payments, expenses —
continues to happen in the POS exactly as now.

---

## What it does

| Page | What it answers |
|---|---|
| **Today** | Am I on track right now? Auto-goal, live pace against your own hourly pattern, tender mix, and the two things to do today. |
| **Focus** | What should I do next? Every issue found in your data, ranked, each with the evidence, a concrete next step and a rupee estimate. |
| **Growth** | Where are sales going? 90-day trend, best and worst weekday, busiest hour, and month-by-month across financial years. |
| **Profit** | What do I actually keep? Gross margin by category, discount leakage, and recorded expenses. |
| **Stock** | What is my cash doing? Ageing bands, the dead stock to clear first, and the fast sellers about to run out. |
| **Suppliers** | Who do I owe, and who earns their shelf space? Payables with ageing, plus a margin and sell-through scorecard per supplier. |
| **Customers** | Who is buying? Currently almost nothing — and the page explains exactly why and what to change. |
| **Data Health** | Can I trust these numbers? Seven checks on the ledger, stock cache, purchases and data capture. |

### Notifications and the daily goal

Grow Board runs in the system tray and pushes four Windows notifications a day:

| Time (default) | Message |
|---|---|
| 09:30 | Today's goal and how it was worked out, plus the day's focus |
| 14:00 | Pace check — how much is banked and whether you are on track |
| 18:00 | Evening push — how much is left, before your strongest hours |
| 21:30 | Closing result against goal, and tomorrow's lead action |
| Monday 10:00 | Weekly review — last week vs the week before |

**The goal is never a guess and never a black box.** It is the median of your last
six same-weekdays, adjusted by the trend of the last four weeks against the four
before (capped at ±25% so one bad fortnight cannot collapse it), plus a stretch
you set. The Today page shows the full working under "How today's goal was
worked out".

---

## Installing it

The built installer is at `dist\GrowBoard-Setup-1.0.0.exe`. Double-click it —
it installs per-user with desktop and Start-menu shortcuts, no administrator
prompt. Windows SmartScreen will warn because the installer is not code-signed;
choose **More info -> Run anyway**.

Two one-time steps afterwards:

1. **Settings -> Connection** — enter the `dev_readonly` password once. It is
   deliberately not in the installer (release files are public), and is stored
   encrypted under `%APPDATA%\Grow Board` on this PC only.
2. **Settings -> Application** — tick *Start automatically with Windows*.

Updates are checked against GitHub Releases and **always ask before installing**,
so nothing can interrupt billing. Full setup and release instructions are in
[RELEASING.md](RELEASING.md).

## Running from source

### First time

```bash
cd D:\Grow-board
npm install
```

### Every day

Double-click **`start-grow-board.bat`**, or:

```bash
npm start
```

Closing the window keeps it running in the tray so notifications still reach
you. Quit fully from the tray icon.

### Build a real installer

```bash
npm run build
```

Produces `dist\GrowBoard-Setup-1.0.0.exe` — a normal Windows installer with
Start-menu and desktop shortcuts. Install it on the counter PC and turn on
"Start automatically with Windows" in Settings.

---

## Checking it works

```bash
npm run check      # connection only
npm run probe      # runs all 20 metrics against the live DB and prints the numbers
npm run selftest   # renders all 9 pages headlessly and reports any error
```

`selftest` is safe to run while the shop is trading — it opens no visible window
and touches nothing.

---

## Configuration

`config.json` sits beside the application and can be edited directly. Anything
changed on the Settings page is saved separately and overrides the file.

```json
{
  "sql":  { "server": "DESKTOP-H2T0P2H", "adminDb": "DLTAdmindb",
            "user": "dev_readonly", "password": "" },
  "business": { "openHour": 8, "closeHour": 22 },
  "goal": { "growthTargetPct": 5, "lookbackWeeks": 6, "minGoal": 5000 },
  "notifications": { "morningGoal": "09:30", "middayCheck": "14:00",
                     "eveningPush": "18:00", "closingResult": "21:30" },
  "app": { "autoStart": true, "startMinimised": false, "refreshSeconds": 60 },
  "update": { "enabled": false, "owner": "", "repo": "", "checkEveryHours": 6 }
}
```

The app resolves the current financial-year database automatically from
`DLTAdmindb.dbo.dbmaster`, so it keeps working on 1 April without any change.

> **Where the password lives.** `password` in `config.json` is deliberately
> empty and must stay that way. Release builds are published publicly on GitHub
> for auto-update, so anything in the repository or the installer is public.
> The password is entered once on the Settings page and kept encrypted under
> `%APPDATA%\Grow Board` on that machine only. Command-line tools read it from
> the same place, so `npm run probe` works without it ever being in a file you
> might commit.

---

## What the numbers are built on

Grow Board follows the rules established in `D:\DATA\POS-Schema`, which maps this
POS database in detail. The ones that matter most:

- **Money comes from `saleshead`, the accounting ledger** — never from
  `SalesEntry`, which contains 27 duplicated bills and disagrees with the ledger
  on exchange bills. This is why Grow Board's totals can differ slightly from the
  POS's own sales report; Grow Board's are the ones that balance.
- **Stock is never date-filtered** — `ItemTag` carries history from 2021 forward.
- **Purchases join to stock on `BatchNo`** — not tag number, not document number.
- **Cost comes from the sale movement itself**, so margin is the true cost of the
  lot that was actually sold.
- **Cancelled rows are excluded everywhere** with `ISNULL(Cancel,'') <> 'Y'`.

Two checks run continuously and appear on the Data Health page: the ledger must
balance every day, and the stock cache must match the stock ledger. Both pass
today. If either ever fails, stop trusting the figures until it is fixed.

---

## Known limits — read these before relying on a page

| Limit | Effect |
|---|---|
| **Expenses are barely recorded** | Only a couple of trading days in the last month have any expense entry. Every profit figure is therefore **gross** profit. Net profit cannot be calculated until expenses are entered daily in the POS. |
| **Customers are not captured** | About 3% of bills identify the buyer. No repeat-rate, no offers, no cohorts until this changes. |
| **Supplier and size coverage** | Resolved through the stock tag: supplier on ~88% of sold lines, size on ~71%. Good for trends, not exact totals. |
| **125 items show negative stock** | Sold without a purchase or opening entry. Stock value and margin are understated for those items. |
| **Payables run from 2021** | The supplier balance includes anything never marked paid. Confirm against statements before treating it as debt. |
| **No salesperson data** | The POS records `0` for every sale, so per-staff performance is impossible. |

The app states each of these on the page it affects rather than quietly showing a
wrong number.

---

## Layout

```
src/
  main.js        Electron main - window, tray, notification schedule, IPC
  preload.js     the narrow bridge the UI is allowed to use
  db.js          read-only SQL pool, financial-year resolution, query cache
  metrics.js     every query, one function per question
  goals.js       the automatic daily goal and pace calculation
  coach.js       the rules that turn numbers into ranked actions
  store.js       local app settings only - no business data
  ui/            index.html, style.css, charts.js (hand-rolled SVG), app.js
tools/           connection check, metric probe, timing
config.json      connection and preferences
```

There are no chart or UI dependencies — only the `mssql` driver and Electron.

---

## Safety

- The database layer refuses any statement that is not a read; a write keyword
  raises an error before it reaches SQL Server.
- The renderer has no Node access and no database access. It can only call the
  named functions in `preload.js`, all of which are reads.
- No business data is written to disk. Local storage holds preferences and
  notification history only.
