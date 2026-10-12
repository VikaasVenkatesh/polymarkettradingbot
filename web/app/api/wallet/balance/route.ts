import { currentUserId } from "@/lib/auth";
import { q } from "@/lib/db";
import { walletBalance, type WalletRow } from "@/lib/trading";

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "Not signed in." }, { status: 401 });
  const [wallet] = await q<WalletRow>("SELECT * FROM wallets WHERE user_id = $1", [userId]);
  if (!wallet) return Response.json({ error: "No wallet connected." }, { status: 404 });
  try {
    return Response.json({ balance: await walletBalance(wallet) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
