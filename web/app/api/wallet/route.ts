import { privateKeyToAccount } from "viem/accounts";
import { isAddress } from "viem";
import { currentUserId } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { q } from "@/lib/db";
import { liveTradingEnabled } from "@/lib/engine";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return bad("Not signed in.", 401);
  // Don't collect keys that this deployment can't use.
  if (!liveTradingEnabled()) return bad("Live trading is switched off on this deployment.");
  const body = await req.json().catch(() => ({}));

  let key = String(body.private_key ?? "").trim();
  if (key && !key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return bad("That is not a valid private key (64 hex characters).");
  const signatureType = Number(body.signature_type);
  if (![0, 1, 2].includes(signatureType)) return bad("Choose a wallet type.");
  const funder = String(body.funder_address ?? "").trim();
  if (signatureType !== 0 && !isAddress(funder)) return bad("Enter the Polymarket deposit address that holds your funds.");

  const address = privateKeyToAccount(key as `0x${string}`).address;
  await q(
    `INSERT INTO wallets (user_id, address, funder_address, signature_type, enc_private_key)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET address = EXCLUDED.address, funder_address = EXCLUDED.funder_address,
       signature_type = EXCLUDED.signature_type, enc_private_key = EXCLUDED.enc_private_key, enc_api_creds = NULL`,
    [userId, address, signatureType === 0 ? null : funder, signatureType, encrypt(key)],
  );
  return Response.json({ ok: true, address });
}

export async function DELETE() {
  const userId = await currentUserId();
  if (!userId) return bad("Not signed in.", 401);
  // Without a key we can't trade, so drop back to paper mode as well.
  await q("UPDATE settings SET live = false WHERE user_id = $1", [userId]);
  await q("DELETE FROM wallets WHERE user_id = $1", [userId]);
  return Response.json({ ok: true });
}
