# Polymarket Copy Trader (web app)

Multi-user web app that follows the week's most profitable Polymarket traders and
mirrors their largest positions with a budget each user sets.

## How it works

- **Leaderboard**: the top 20 traders by profit for today, the week, the month and all
  time, the same lists shown on polymarket.com/leaderboard. Each user picks which one to
  follow (monthly is Polymarket's default view). A daily Vercel cron job refreshes today's
  list every day and the other three every Monday.
- **Who gets copied**: traders are taken in rank order up to the user's maximum. A trader
  with no eligible positions is skipped and the next one takes their place. Outcomes priced
  below 5¢ or above 95¢, resolved, or past their end date are not eligible.
- **Weighting**: by profit (default) or equal. No trader gets more than 40% of the budget.
  A trader whose slice would be under $5 is dropped and the rest re-weighted, so a small
  budget follows fewer traders. Each slice is split across that trader's largest positions
  by position value, dropping any that would get under $2.
- **Scan** (`/api/cron/scan`): buys planned positions the user doesn't hold yet, and sells
  a position once the trader exits it or leaves the top 20. Buys never pay more than about
  10% over the price the trader's position is marked at. Sizes are set when a position is
  bought and are not rebalanced afterwards.
- **Paper mode** (default): fills are simulated against the live order book.
- **Live mode**: real orders are signed with the user's wallet key, which is stored
  AES-256-GCM encrypted. Requires `LIVE_TRADING_ENABLED=true`, and Polymarket must
  accept orders from the server's region (checked before every live scan).

## Run locally

```bash
createdb pmcopy_dev
cp .env.example .env.local   # then fill in the three secrets
npm install
npm run dev
```

Trigger a scan by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/scan
```

## Scheduling

`vercel.json` runs the daily leaderboard job and one fallback scan per day.
`.github/workflows/scan.yml` calls the scan every five minutes; it needs the
`APP_URL` and `CRON_SECRET` repository secrets.

## Not yet verified

Live order placement (`lib/trading.ts`, `mode === "live"`) has not been exercised
against a funded account. Test it with a small budget before relying on it.
