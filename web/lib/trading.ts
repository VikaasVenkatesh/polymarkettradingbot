import { AssetType, Chain, ClobClient, OrderType, Side, type ApiKeyCreds, type TickSize } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { decrypt, encrypt } from "./crypto";
import { q } from "./db";
import type { Book } from "./polymarket";

const CLOB_HOST = "https://clob.polymarket.com";

export type WalletRow = {
  user_id: number;
  address: string;
  funder_address: string | null;
  signature_type: number;
  enc_private_key: string;
  enc_api_creds: string | null;
};

export type Fill = { ok: boolean; shares: number; usd: number; detail: string };

const failed = (detail: string): Fill => ({ ok: false, shares: 0, usd: 0, detail });

function decimals(tick: string): number {
  return (tick.split(".")[1] ?? "").length;
}

export function roundToTick(price: number, tick: string, dir: "down" | "up"): number {
  const t = Number(tick);
  const steps = dir === "down" ? Math.floor(price / t + 1e-9) : Math.ceil(price / t - 1e-9);
  return Number(Math.min(1 - t, Math.max(t, steps * t)).toFixed(decimals(tick)));
}

/** Spend up to `usd` against the asks without paying more than `maxPrice`. */
export function simulateBuy(book: Book, usd: number, maxPrice: number): Fill {
  let left = usd;
  let shares = 0;
  for (const level of book.asks) {
    if (level.price > maxPrice || left <= 1e-9) break;
    const take = Math.min(level.size, left / level.price);
    shares += take;
    left -= take * level.price;
  }
  if (shares <= 0) return failed(`no asks at or below ${maxPrice}`);
  return { ok: true, shares, usd: usd - left, detail: "simulated against live order book" };
}

/** Sell up to `shares` into the bids without accepting less than `minPrice`. */
export function simulateSell(book: Book, shares: number, minPrice: number): Fill {
  let left = shares;
  let usd = 0;
  for (const level of book.bids) {
    if (level.price < minPrice || left <= 1e-9) break;
    const take = Math.min(level.size, left);
    usd += take * level.price;
    left -= take;
  }
  if (usd <= 0) return failed(`no bids at or above ${minPrice}`);
  return { ok: true, shares: shares - left, usd, detail: "simulated against live order book" };
}

export async function liveClient(wallet: WalletRow): Promise<ClobClient> {
  const account = privateKeyToAccount(decrypt(wallet.enc_private_key) as `0x${string}`);
  const signer = createWalletClient({ account, chain: polygon, transport: http() });
  const base = {
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer,
    signatureType: wallet.signature_type,
    funderAddress: wallet.funder_address ?? undefined,
    throwOnError: true,
  };

  let creds: ApiKeyCreds;
  if (wallet.enc_api_creds) {
    creds = JSON.parse(decrypt(wallet.enc_api_creds));
  } else {
    creds = await new ClobClient(base).createOrDeriveApiKey();
    wallet.enc_api_creds = encrypt(JSON.stringify(creds));
    await q("UPDATE wallets SET enc_api_creds = $1 WHERE user_id = $2", [wallet.enc_api_creds, wallet.user_id]);
  }
  return new ClobClient({ ...base, creds });
}

/** USDC available to trade in the connected wallet. */
export async function walletBalance(wallet: WalletRow): Promise<number> {
  const client = await liveClient(wallet);
  const res = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return Number(res.balance) / 1e6;
}

async function postMarketOrder(
  client: ClobClient,
  book: Book,
  tokenId: string,
  side: Side,
  amount: number,
  limitPrice: number,
): Promise<Fill> {
  const res = await client.createAndPostMarketOrder(
    { tokenID: tokenId, side, amount, price: limitPrice, orderType: OrderType.FAK },
    { tickSize: book.tickSize as TickSize, negRisk: book.negRisk },
    OrderType.FAK,
  );
  if (!res.success) return failed(res.errorMsg || `order rejected (${res.status})`);

  let given = Number(res.makingAmount) || 0;
  let received = Number(res.takingAmount) || 0;

  // Some markets match with a short delay; look the order up once before giving up.
  if (given <= 0 && res.orderID) {
    await new Promise((r) => setTimeout(r, 4000));
    const order = await client.getOrder(res.orderID);
    const matched = Number(order?.size_matched) || 0;
    const price = Number(order?.price) || limitPrice;
    given = side === Side.BUY ? matched * price : matched;
    received = side === Side.BUY ? matched : matched * price;
  }
  if (given <= 0) return failed(`order ${res.orderID} not filled (${res.status})`);

  return side === Side.BUY
    ? { ok: true, shares: received, usd: given, detail: `order ${res.orderID}` }
    : { ok: true, shares: given, usd: received, detail: `order ${res.orderID}` };
}

export async function executeBuy(
  mode: "paper" | "live",
  wallet: WalletRow | null,
  book: Book,
  tokenId: string,
  usd: number,
  maxPrice: number,
): Promise<Fill> {
  const limit = roundToTick(maxPrice, book.tickSize, "down");
  if (mode === "paper") return simulateBuy(book, usd, limit);
  if (!wallet) return failed("no wallet connected");
  try {
    return await postMarketOrder(await liveClient(wallet), book, tokenId, Side.BUY, usd, limit);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

export async function executeSell(
  mode: "paper" | "live",
  wallet: WalletRow | null,
  book: Book,
  tokenId: string,
  shares: number,
  minPrice: number,
): Promise<Fill> {
  const limit = roundToTick(minPrice, book.tickSize, "up");
  if (mode === "paper") return simulateSell(book, shares, limit);
  if (!wallet) return failed("no wallet connected");
  try {
    // Shares are 6-decimal on chain; never try to sell dust beyond what we hold.
    const amount = Math.floor(shares * 100) / 100;
    return await postMarketOrder(await liveClient(wallet), book, tokenId, Side.SELL, amount, limit);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}
