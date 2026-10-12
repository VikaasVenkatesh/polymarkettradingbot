import { currentUserId } from "@/lib/auth";
import { q } from "@/lib/db";
import { liveTradingEnabled, MAX_POSITIONS, MAX_TRADERS, type Settings } from "@/lib/engine";
import { serverGeo, visitorRestricted } from "@/lib/geo";

const bad = (error: string, status = 400) => Response.json({ error }, { status });
const int = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return bad("Not signed in.", 401);
  const body = await req.json().catch(() => ({}));

  const [current] = await q<Settings>("SELECT * FROM settings WHERE user_id = $1", [userId]);
  const budget = Number(body.budget_usd);
  if (!Number.isFinite(budget) || budget < 0 || budget > 1_000_000) return bad("Budget must be between 0 and 1,000,000.");
  const live = Boolean(body.live);

  if (live && !current.live) {
    if (!liveTradingEnabled()) return bad("Live trading is switched off on this deployment.");
    if (!body.attest) return bad("Confirm that you are permitted to trade on Polymarket where you live.");
    const country = visitorRestricted(req);
    if (country) return bad(`Live trading is not available from ${country}.`, 403);
    if ((await serverGeo()).blocked) return bad("Polymarket does not accept orders from this server's region.");
    const wallet = await q("SELECT 1 FROM wallets WHERE user_id = $1", [userId]);
    if (!wallet.length) return bad("Connect a wallet before switching to live trading.");
    // Paper positions are bookkeeping only; start live with a clean slate.
    await q(
      "UPDATE copied_positions SET status = 'reset', closed_at = now() WHERE user_id = $1 AND mode = 'paper' AND status = 'open'",
      [userId],
    );
  }

  await q(
    "UPDATE settings SET budget_usd = $1, top_traders = $2, top_positions = $3, live = $4, paused = $5 WHERE user_id = $6",
    [budget, int(body.top_traders, 1, MAX_TRADERS), int(body.top_positions, 1, MAX_POSITIONS), live, Boolean(body.paused), userId],
  );
  return Response.json({ ok: true });
}
