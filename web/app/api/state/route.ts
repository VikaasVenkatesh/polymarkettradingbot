import { currentUserId } from "@/lib/auth";
import { q } from "@/lib/db";
import { buildTargets, getLeaderboard, liveTradingEnabled, type CopiedPosition, type Settings } from "@/lib/engine";
import { serverGeo } from "@/lib/geo";
import type { TraderPosition } from "@/lib/polymarket";

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return Response.json({ user: null });

  const [user] = await q<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
  if (!user) return Response.json({ user: null });
  const [settings] = await q<Settings>("SELECT * FROM settings WHERE user_id = $1", [userId]);
  const [wallet] = await q("SELECT address, funder_address, signature_type FROM wallets WHERE user_id = $1", [userId]);
  const traders = await getLeaderboard();
  const [refreshed] = await q<{ at: string }>("SELECT max(refreshed_at) AS at FROM leaderboard");
  const [scan] = await q<{ finished_at: string | null }>("SELECT finished_at FROM runs WHERE kind = 'scan'");

  const cached = await q<{ address: string; data: TraderPosition[] }>("SELECT address, data FROM trader_positions");
  const positionsByTrader = new Map(cached.map((c) => [c.address, c.data]));
  const priceByToken = new Map<string, number>();
  for (const c of cached) for (const p of c.data) priceByToken.set(p.asset, p.curPrice);

  const mode = settings.live ? "live" : "paper";
  const rows = await q<CopiedPosition>(
    "SELECT * FROM copied_positions WHERE user_id = $1 AND mode = $2 ORDER BY opened_at DESC LIMIT 300",
    [userId, mode],
  );
  const open = rows
    .filter((p) => p.status === "open")
    .map((p) => {
      const price = priceByToken.get(p.token_id) ?? p.cost_usd / p.shares;
      return { ...p, price, value: p.shares * price };
    });
  const realized = rows
    .filter((p) => p.status === "closed")
    .reduce((sum, p) => sum + p.proceeds_usd - p.cost_usd, 0);
  const orders = await q("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40", [userId]);

  const targets = buildTargets(settings, traders, positionsByTrader).map((t) => ({
    trader: t.trader.name,
    address: t.trader.address,
    title: t.position.title,
    outcome: t.position.outcome,
    price: t.position.curPrice,
    usd: t.usd,
    held: open.some((p) => p.trader_address === t.trader.address && p.token_id === t.position.asset),
  }));

  return Response.json({
    user,
    settings,
    wallet: wallet ?? null,
    traders,
    refreshedAt: refreshed?.at ?? null,
    lastScanAt: scan?.finished_at ?? null,
    targets,
    open,
    realized,
    orders,
    liveEnabled: liveTradingEnabled(),
    geo: await serverGeo(),
  });
}
