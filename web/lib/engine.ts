import { q } from "./db";
import {
  fetchBook,
  fetchGeoblock,
  fetchLeaderboard,
  fetchTraderPositions,
  PERIODS,
  type Period,
  type Trader,
  type TraderPosition,
} from "./polymarket";
import { executeBuy, executeSell, type WalletRow } from "./trading";

export const MAX_TRADERS = 20;
export const MAX_POSITIONS = 10;
const MIN_ORDER_USD = 1;
// Skip near-certain outcomes: little upside left and they are about to resolve.
const MIN_PRICE = 0.05;
const MAX_PRICE = 0.95;
// Slices smaller than these aren't worth an order, so they are folded into the rest.
const MIN_TRADER_USD = 5;
const MIN_POSITION_USD = 2;
// No single trader gets more than this share of the budget (when there are enough traders).
const MAX_TRADER_WEIGHT = 0.4;

export type Settings = {
  user_id: number;
  budget_usd: number;
  top_traders: number;
  top_positions: number;
  live: boolean;
  paused: boolean;
  weighting: "profit" | "equal";
  period: Period;
};

export type CopiedPosition = {
  id: number;
  user_id: number;
  trader_address: string;
  trader_name: string;
  condition_id: string;
  token_id: string;
  title: string;
  outcome: string;
  shares: number;
  cost_usd: number;
  proceeds_usd: number;
  mode: "paper" | "live";
  status: string;
  opened_at: string;
  closed_at: string | null;
};

export type PlanTrader = {
  trader: Trader;
  weight: number;
  usd: number;
  positions: { position: TraderPosition; usd: number }[];
};
export type Plan = {
  followed: PlanTrader[];
  skipped: { trader: Trader; reason: string }[];
};

export function liveTradingEnabled(): boolean {
  return process.env.LIVE_TRADING_ENABLED === "true";
}

/** A trader's positions worth copying, largest first. */
export function eligiblePositions(
  positions: TraderPosition[],
  limit: number,
): TraderPosition[] {
  const today = new Date().toISOString().slice(0, 10);
  return positions
    .filter(
      (p) =>
        !p.redeemable &&
        p.currentValue > 0 &&
        p.curPrice >= MIN_PRICE &&
        p.curPrice <= MAX_PRICE &&
        (!p.endDate || p.endDate.slice(0, 10) >= today),
    )
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, limit);
}

/** Normalise to shares of 1, moving anything above the cap onto the uncapped entries. */
export function cappedWeights(raw: number[], cap: number): number[] {
  const weights = raw.map((r) => r / raw.reduce((a, b) => a + b, 0));
  const capped = new Set<number>();
  for (;;) {
    const over = weights.findIndex((w, i) => !capped.has(i) && w > cap + 1e-12);
    if (over < 0) return weights;
    capped.add(over);
    const free = weights.reduce(
      (sum, w, i) => (capped.has(i) ? sum : sum + w),
      0,
    );
    const spare = 1 - capped.size * cap;
    weights.forEach(
      (w, i) => (weights[i] = capped.has(i) ? cap : (w / free) * spare),
    );
  }
}

/**
 * Decide who to copy and with how much.
 *
 * Walk the leaderboard in rank order, skipping traders with nothing worth
 * copying so the next trader takes their place, until `top_traders` are found.
 * Weight them by profit (or equally), cap any one trader's share, and drop the
 * smallest until every remaining trader's slice is big enough to trade. Each
 * slice is then split across that trader's largest positions by position value.
 */
export function buildPlan(
  settings: Pick<
    Settings,
    "budget_usd" | "top_traders" | "top_positions" | "weighting"
  >,
  traders: Trader[],
  positionsByTrader: Map<string, TraderPosition[]>,
): Plan {
  const plan: Plan = { followed: [], skipped: [] };
  if (settings.budget_usd < MIN_TRADER_USD) return plan;

  const candidates: { trader: Trader; top: TraderPosition[] }[] = [];
  for (const trader of traders) {
    if (candidates.length >= settings.top_traders) break;
    const top = eligiblePositions(
      positionsByTrader.get(trader.address) ?? [],
      settings.top_positions,
    );
    if (!top.length)
      plan.skipped.push({ trader, reason: "No open positions worth copying" });
    else if (settings.weighting === "profit" && trader.pnl <= 0)
      plan.skipped.push({ trader, reason: "No profit this period" });
    else candidates.push({ trader, top });
  }
  if (!candidates.length) return plan;

  let weights: number[];
  for (;;) {
    const raw = candidates.map((c) =>
      settings.weighting === "profit" ? c.trader.pnl : 1,
    );
    weights = cappedWeights(
      raw,
      Math.max(MAX_TRADER_WEIGHT, 1 / candidates.length),
    );
    const smallest = weights.lastIndexOf(Math.min(...weights));
    if (
      candidates.length === 1 ||
      weights[smallest] * settings.budget_usd >= MIN_TRADER_USD
    )
      break;
    plan.skipped.push({
      trader: candidates[smallest].trader,
      reason: "Share of budget too small to trade",
    });
    candidates.splice(smallest, 1);
  }

  candidates.forEach(({ trader, top }, i) => {
    const usd = settings.budget_usd * weights[i];
    let picks = top;
    for (;;) {
      const total = picks.reduce((sum, p) => sum + p.currentValue, 0);
      const smallest = (usd * picks[picks.length - 1].currentValue) / total;
      if (picks.length === 1 || smallest >= MIN_POSITION_USD) {
        plan.followed.push({
          trader,
          weight: weights[i],
          usd,
          positions: picks.map((position) => ({
            position,
            usd: (usd * position.currentValue) / total,
          })),
        });
        return;
      }
      picks = picks.slice(0, -1);
    }
  });
  return plan;
}

export async function getLeaderboard(period: Period): Promise<Trader[]> {
  return q<Trader>(
    "SELECT rank, address, name, pnl, volume FROM leaderboards WHERE period = $1 ORDER BY rank",
    [period],
  );
}

export async function refreshLeaderboard(
  periods: readonly Period[] = PERIODS,
): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};
  for (const period of periods) {
    const traders = await fetchLeaderboard(period, MAX_TRADERS);
    if (!traders.length)
      throw new Error(`${period} leaderboard came back empty`);
    await q("DELETE FROM leaderboards WHERE period = $1", [period]);
    for (const t of traders) {
      await q(
        "INSERT INTO leaderboards (period, rank, address, name, pnl, volume, refreshed_at) VALUES ($1,$2,$3,$4,$5,$6, now())",
        [period, t.rank, t.address, t.name, t.pnl, t.volume],
      );
    }
    summary[period] = traders.length;
  }
  await q(
    "UPDATE runs SET finished_at = now(), summary = $1 WHERE kind = 'leaderboard'",
    [JSON.stringify(summary)],
  );
  return summary;
}

async function logOrder(
  userId: number,
  side: "BUY" | "SELL",
  p: { token_id: string; title: string; outcome: string; trader_name: string },
  mode: string,
  fill: { ok: boolean; shares: number; usd: number; detail: string },
) {
  await q(
    `INSERT INTO orders (user_id, side, token_id, title, outcome, trader_name, usd, shares, price, mode, ok, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      userId,
      side,
      p.token_id,
      p.title,
      p.outcome,
      p.trader_name,
      fill.usd,
      fill.shares,
      fill.shares > 0 ? fill.usd / fill.shares : 0,
      mode,
      fill.ok,
      fill.detail.slice(0, 500),
    ],
  );
}

type ScanSummary = {
  users: number;
  buys: number;
  sells: number;
  failed: number;
  skipped?: string;
  notes: string[];
};

async function scanUser(
  settings: Settings,
  wallet: WalletRow | null,
  traders: Trader[],
  positionsByTrader: Map<string, TraderPosition[]>,
  summary: ScanSummary,
) {
  if (!traders.length) return;
  const mode = settings.live ? "live" : "paper";
  const onLeaderboard = new Set(traders.map((t) => t.address));

  const open = await q<CopiedPosition>(
    "SELECT * FROM copied_positions WHERE user_id = $1 AND status = 'open' AND mode = $2",
    [settings.user_id, mode],
  );

  // Exits first, so freed budget is visible to the buys below.
  for (const pos of open) {
    const stillTracked = onLeaderboard.has(pos.trader_address);
    const theirs = positionsByTrader.get(pos.trader_address);
    // Unknown (fetch failed this scan) is not the same as exited.
    if (stillTracked && !theirs) continue;
    const held = theirs?.find((p) => p.asset === pos.token_id);
    if (stillTracked && held && !held.redeemable) continue;

    const book = await fetchBook(pos.token_id);
    if (!book || !book.bids.length) {
      await q(
        "UPDATE copied_positions SET status = 'resolved', closed_at = now() WHERE id = $1",
        [pos.id],
      );
      summary.notes.push(`${pos.title}: market resolved, redeem on Polymarket`);
      continue;
    }
    const floor = Math.max(0.01, book.bids[0].price * 0.9);
    const fill = await executeSell(
      mode,
      wallet,
      book,
      pos.token_id,
      pos.shares,
      floor,
    );
    await logOrder(settings.user_id, "SELL", pos, mode, fill);
    if (!fill.ok) {
      summary.failed++;
      continue;
    }
    summary.sells++;
    const remaining = pos.shares - fill.shares;
    if (remaining < 0.01) {
      await q(
        "UPDATE copied_positions SET status = 'closed', closed_at = now(), proceeds_usd = proceeds_usd + $1 WHERE id = $2",
        [fill.usd, pos.id],
      );
      pos.status = "closed";
    } else {
      // Partial fill: keep the remainder open with a proportionally reduced cost basis.
      const costLeft = pos.cost_usd * (remaining / pos.shares);
      await q(
        "UPDATE copied_positions SET shares = $1, cost_usd = $2, proceeds_usd = proceeds_usd + $3 WHERE id = $4",
        [remaining, costLeft, fill.usd, pos.id],
      );
      pos.shares = remaining;
      pos.cost_usd = costLeft;
    }
  }

  // With a trader's positions unknown we can't tell who should be in the plan;
  // buying now could put money on a stand-in that is dropped again next scan.
  if (!traders.every((t) => positionsByTrader.has(t.address))) {
    summary.notes.push(
      `user ${settings.user_id}: buys skipped, some traders' positions were unavailable`,
    );
    return;
  }

  const stillOpen = open.filter((p) => p.status === "open");
  const deployed = new Map<string, number>();
  for (const p of stillOpen)
    deployed.set(
      p.trader_address,
      (deployed.get(p.trader_address) ?? 0) + p.cost_usd,
    );
  let unspent =
    settings.budget_usd - stillOpen.reduce((sum, p) => sum + p.cost_usd, 0);

  const plan = buildPlan(settings, traders, positionsByTrader);
  const targets = plan.followed.flatMap((f) =>
    f.positions.map((p) => ({ ...p, trader: f.trader, slice: f.usd })),
  );
  for (const target of targets) {
    const { trader, position } = target;
    if (
      stillOpen.some(
        (p) =>
          p.trader_address === trader.address && p.token_id === position.asset,
      )
    )
      continue;
    const room = Math.min(
      unspent,
      target.slice - (deployed.get(trader.address) ?? 0),
    );
    const usd = Math.min(target.usd, room);
    if (usd < MIN_ORDER_USD) continue;

    const book = await fetchBook(position.asset);
    if (!book || !book.asks.length) continue;
    // Don't chase: pay at most a little over the price the trader's position is marked at.
    const maxPrice = Math.min(0.97, position.curPrice * 1.1 + 0.01);
    const fill = await executeBuy(
      mode,
      wallet,
      book,
      position.asset,
      usd,
      maxPrice,
    );
    const label = {
      token_id: position.asset,
      title: position.title,
      outcome: position.outcome,
      trader_name: trader.name,
    };
    await logOrder(settings.user_id, "BUY", label, mode, fill);
    if (!fill.ok) {
      summary.failed++;
      continue;
    }
    summary.buys++;
    unspent -= fill.usd;
    deployed.set(
      trader.address,
      (deployed.get(trader.address) ?? 0) + fill.usd,
    );
    await q(
      `INSERT INTO copied_positions
         (user_id, trader_address, trader_name, condition_id, token_id, title, outcome, shares, cost_usd, mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        settings.user_id,
        trader.address,
        trader.name,
        position.conditionId,
        position.asset,
        position.title,
        position.outcome,
        fill.shares,
        fill.usd,
        mode,
      ],
    );
  }
}

export async function runScan(): Promise<ScanSummary> {
  const summary: ScanSummary = {
    users: 0,
    buys: 0,
    sells: 0,
    failed: 0,
    notes: [],
  };

  // One scan at a time; overlapping scans could buy the same position twice.
  const lock = await q(
    "UPDATE runs SET locked_until = now() + interval '5 minutes' WHERE kind = 'scan' AND locked_until < now() RETURNING kind",
  );
  if (!lock.length) return { ...summary, skipped: "another scan is running" };

  try {
    // Only the lists someone has chosen are loaded, to keep each scan small.
    const chosen = await q<{ period: Period }>("SELECT DISTINCT period FROM settings");
    const boards = new Map<Period, Trader[]>();
    for (const { period } of chosen) {
      let board = await getLeaderboard(period);
      if (!board.length) {
        await refreshLeaderboard([period]);
        board = await getLeaderboard(period);
      }
      boards.set(period, board);
    }
    const everyone = new Map(
      [...boards.values()].flat().map((t) => [t.address, t]),
    );

    const positionsByTrader = new Map<string, TraderPosition[]>();
    // A few at a time; fetching every trader at once trips Polymarket's rate limit.
    const queue = [...everyone.values()];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          try {
            const positions = await fetchTraderPositions(t.address);
            positionsByTrader.set(t.address, positions);
            await q(
              `INSERT INTO trader_positions (address, fetched_at, data) VALUES ($1, now(), $2)
             ON CONFLICT (address) DO UPDATE SET fetched_at = now(), data = EXCLUDED.data`,
              [t.address, JSON.stringify(positions.slice(0, 100))],
            );
          } catch (e) {
            summary.notes.push(
              `${t.name}: positions unavailable (${e instanceof Error ? e.message : e})`,
            );
          }
        }
      }),
    );

    const users = await q<Settings>(
      "SELECT * FROM settings WHERE NOT paused AND budget_usd > 0",
    );
    const anyLive = users.some((u) => u.live);
    const geo = anyLive ? await fetchGeoblock() : null;

    for (const settings of users) {
      let wallet: WalletRow | null = null;
      if (settings.live) {
        if (!liveTradingEnabled()) {
          summary.notes.push(
            `user ${settings.user_id}: live trading is disabled on this deployment`,
          );
          continue;
        }
        if (geo?.blocked) {
          summary.notes.push(
            `user ${settings.user_id}: Polymarket blocks orders from this server (${geo.country})`,
          );
          continue;
        }
        [wallet] = await q<WalletRow>(
          "SELECT * FROM wallets WHERE user_id = $1",
          [settings.user_id],
        );
        if (!wallet) {
          summary.notes.push(
            `user ${settings.user_id}: live mode without a wallet`,
          );
          continue;
        }
      }
      try {
        await scanUser(
          settings,
          wallet,
          boards.get(settings.period) ?? [],
          positionsByTrader,
          summary,
        );
        summary.users++;
      } catch (e) {
        summary.notes.push(
          `user ${settings.user_id}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return summary;
  } finally {
    await q(
      "UPDATE runs SET locked_until = 'epoch', finished_at = now(), summary = $1 WHERE kind = 'scan'",
      [JSON.stringify(summary)],
    );
  }
}
