# Polymarket Copy Trader (web app)

Multi-user web app that follows the week's most profitable Polymarket traders and
mirrors their largest positions with a budget each user sets.

## How it works

- **Leaderboard**: every Monday a Vercel cron job stores the top 20 traders by weekly profit.
- **Allocation**: a user's budget is split evenly across their top N traders, then across
  each trader's K largest positions in proportion to position value. Outcomes priced
  below 5¢ or above 95¢ are skipped.
- **Scan** (`/api/cron/scan`): buys planned positions the user doesn't hold yet, and sells
  a position once the trader exits it or drops off the leaderboard. Buys never pay more
  than about 10% over the price the trader's position is marked at.
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

`vercel.json` runs the weekly leaderboard refresh and one fallback scan per day.
`.github/workflows/scan.yml` calls the scan every five minutes; it needs the
`APP_URL` and `CRON_SECRET` repository secrets.

## Not yet verified

Live order placement (`lib/trading.ts`, `mode === "live"`) has not been exercised
against a funded account. Test it with a small budget before relying on it.
