import { q } from "./db";
import {
  fetchBook,
  fetchGeoblock,
  fetchLeaderboard,
  fetchTraderPositions,
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

export type Settings = {
  user_id: number;
  budget_usd: number;
  top_traders: number;
  top_positions: number;
  live: boolean;
  paused: boolean;
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

export type Target = { trader: Trader; position: TraderPosition; usd: number };

export function liveTradingEnabled(): boolean {
  return process.env.LIVE_TRADING_ENABLED === "true";
}

/** A trader's positions worth copying, largest first. */
export function eligiblePositions(positions: TraderPosition[], limit: number): TraderPosition[] {
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

/**
 * Split the budget evenly across the top traders, then split each trader's
 * share across their largest positions in proportion to position value.
 */
export function buildTargets(
  settings: Pick<Settings, "budget_usd" | "top_traders" | "top_positions">,
  traders: Trader[],
  positionsByTrader: Map<string, TraderPosition[]>,
): Target[] {
  const tracked = traders.slice(0, settings.top_traders);
  if (!tracked.length) return [];
  const perTrader = settings.budget_usd / tracked.length;
  const targets: Target[] = [];
  for (const trader of tracked) {
    const top = eligiblePositions(positionsByTrader.get(trader.address) ?? [], settings.top_positions);
    const total = top.reduce((sum, p) => sum + p.currentValue, 0);
    for (const position of top) {
      targets.push({ trader, position, usd: (perTrader * position.currentValue) / total });
    }
  }
  return targets;
}

export async function getLeaderboard(): Promise<Trader[]> {
  return q<Trader>("SELECT rank, address, name, pnl, volume FROM leaderboard ORDER BY rank");
}

export async function refreshLeaderboard(): Promise<{ traders: number }> {
  const traders = await fetchLeaderboard(MAX_TRADERS);
  if (!traders.length) throw new Error("leaderboard came back empty");
  await q("DELETE FROM leaderboard");
  for (const t of traders) {
    await q(
      "INSERT INTO leaderboard (rank, address, name, pnl, volume, refreshed_at) VALUES ($1,$2,$3,$4,$5, now())",
      [t.rank, t.address, t.name, t.pnl, t.volume],
    );
  }
  const summary = { traders: traders.length };
  await q("UPDATE runs SET finished_at = now(), summary = $1 WHERE kind = 'leaderboard'", [JSON.stringify(summary)]);
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
    [userId, side, p.token_id, p.title, p.outcome, p.trader_name, fill.usd, fill.shares,
     fill.shares > 0 ? fill.usd / fill.shares : 0, mode, fill.ok, fill.detail.slice(0, 500)],
  );
}

type ScanSummary = { users: number; buys: number; sells: number; failed: number; skipped?: string; notes: string[] };

async function scanUser(
  settings: Settings,
  wallet: WalletRow | null,
  traders: Trader[],
  positionsByTrader: Map<string, TraderPosition[]>,
  summary: ScanSummary,
) {
  const mode = settings.live ? "live" : "paper";
  const tracked = traders.slice(0, settings.top_traders);
  const trackedByAddress = new Map(tracked.map((t) => [t.address, t]));
  const perTrader = settings.budget_usd / Math.max(1, tracked.length);

  const open = await q<CopiedPosition>(
    "SELECT * FROM copied_positions WHERE user_id = $1 AND status = 'open' AND mode = $2",
    [settings.user_id, mode],
  );

  // Exits first, so freed budget is visible to the buys below.
  for (const pos of open) {
    const stillTracked = trackedByAddress.has(pos.trader_address);
    const theirs = positionsByTrader.get(pos.trader_address);
    // Unknown (fetch failed this scan) is not the same as exited.
    if (stillTracked && !theirs) continue;
    const held = theirs?.find((p) => p.asset === pos.token_id);
    if (stillTracked && held && !held.redeemable) continue;

    const book = await fetchBook(pos.token_id);
    if (!book || !book.bids.length) {
      await q("UPDATE copied_positions SET status = 'resolved', closed_at = now() WHERE id = $1", [pos.id]);
      summary.notes.push(`${pos.title}: market resolved, redeem on Polymarket`);
      continue;
    }
    const floor = Math.max(0.01, book.bids[0].price * 0.9);
    const fill = await executeSell(mode, wallet, book, pos.token_id, pos.shares, floor);
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

  const stillOpen = open.filter((p) => p.status === "open");
  const deployed = new Map<string, number>();
  for (const p of stillOpen) deployed.set(p.trader_address, (deployed.get(p.trader_address) ?? 0) + p.cost_usd);

  for (const target of buildTargets(settings, traders, positionsByTrader)) {
    const { trader, position } = target;
    if (stillOpen.some((p) => p.trader_address === trader.address && p.token_id === position.asset)) continue;
    const room = perTrader - (deployed.get(trader.address) ?? 0);
    const usd = Math.min(target.usd, room);
    if (usd < MIN_ORDER_USD) continue;

    const book = await fetchBook(position.asset);
    if (!book || !book.asks.length) continue;
    // Don't chase: pay at most a little over the price the trader's position is marked at.
    const maxPrice = Math.min(0.97, position.curPrice * 1.1 + 0.01);
    const fill = await executeBuy(mode, wallet, book, position.asset, usd, maxPrice);
    const label = { token_id: position.asset, title: position.title, outcome: position.outcome, trader_name: trader.name };
    await logOrder(settings.user_id, "BUY", label, mode, fill);
    if (!fill.ok) {
      summary.failed++;
      continue;
    }
    summary.buys++;
    deployed.set(trader.address, (deployed.get(trader.address) ?? 0) + fill.usd);
    await q(
      `INSERT INTO copied_positions
         (user_id, trader_address, trader_name, condition_id, token_id, title, outcome, shares, cost_usd, mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [settings.user_id, trader.address, trader.name, position.conditionId, position.asset,
       position.title, position.outcome, fill.shares, fill.usd, mode],
    );
  }
}

export async function runScan(): Promise<ScanSummary> {
  const summary: ScanSummary = { users: 0, buys: 0, sells: 0, failed: 0, notes: [] };

  // One scan at a time; overlapping scans could buy the same position twice.
  const lock = await q(
    "UPDATE runs SET locked_until = now() + interval '5 minutes' WHERE kind = 'scan' AND locked_until < now() RETURNING kind",
  );
  if (!lock.length) return { ...summary, skipped: "another scan is running" };

  try {
    let traders = await getLeaderboard();
    if (!traders.length) {
      await refreshLeaderboard();
      traders = await getLeaderboard();
    }

    const positionsByTrader = new Map<string, TraderPosition[]>();
    await Promise.all(
      traders.map(async (t) => {
        try {
          const positions = await fetchTraderPositions(t.address);
          positionsByTrader.set(t.address, positions);
          await q(
            `INSERT INTO trader_positions (address, fetched_at, data) VALUES ($1, now(), $2)
             ON CONFLICT (address) DO UPDATE SET fetched_at = now(), data = EXCLUDED.data`,
            [t.address, JSON.stringify(positions.slice(0, 100))],
          );
        } catch (e) {
          summary.notes.push(`${t.name}: positions unavailable (${e instanceof Error ? e.message : e})`);
        }
      }),
    );

    const users = await q<Settings>("SELECT * FROM settings WHERE NOT paused AND budget_usd > 0");
    const anyLive = users.some((u) => u.live);
    const geo = anyLive ? await fetchGeoblock() : null;

    for (const settings of users) {
      let wallet: WalletRow | null = null;
      if (settings.live) {
        if (!liveTradingEnabled()) {
          summary.notes.push(`user ${settings.user_id}: live trading is disabled on this deployment`);
          continue;
        }
        if (geo?.blocked) {
          summary.notes.push(`user ${settings.user_id}: Polymarket blocks orders from this server (${geo.country})`);
          continue;
        }
        [wallet] = await q<WalletRow>("SELECT * FROM wallets WHERE user_id = $1", [settings.user_id]);
        if (!wallet) {
          summary.notes.push(`user ${settings.user_id}: live mode without a wallet`);
          continue;
        }
      }
      try {
        await scanUser(settings, wallet, traders, positionsByTrader, summary);
        summary.users++;
      } catch (e) {
        summary.notes.push(`user ${settings.user_id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return summary;
  } finally {
    await q("UPDATE runs SET locked_until = 'epoch', finished_at = now(), summary = $1 WHERE kind = 'scan'", [
      JSON.stringify(summary),
    ]);
  }
}
