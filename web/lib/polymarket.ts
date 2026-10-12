const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

export type Trader = { rank: number; address: string; name: string; pnl: number; volume: number };

export type TraderPosition = {
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  redeemable: boolean;
  endDate?: string;
};

export type Book = {
  bids: { price: number; size: number }[]; // best first
  asks: { price: number; size: number }[]; // best first
  tickSize: string;
  negRisk: boolean;
  minOrderSize: number;
};

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

/** This week's most profitable traders. */
export async function fetchLeaderboard(limit: number): Promise<Trader[]> {
  const rows = (await getJson(
    `${DATA_API}/v1/leaderboard?timePeriod=WEEK&orderBy=PNL&limit=${limit}`,
  )) as Record<string, unknown>[];
  return rows.map((r, i) => ({
    rank: i + 1,
    address: String(r.proxyWallet).toLowerCase(),
    name: String(r.userName || r.proxyWallet).slice(0, 40),
    pnl: Number(r.pnl) || 0,
    volume: Number(r.vol) || 0,
  }));
}

/** All of a trader's open positions, largest first. Throws if the request fails. */
export async function fetchTraderPositions(address: string): Promise<TraderPosition[]> {
  const rows = (await getJson(
    `${DATA_API}/positions?user=${address}&limit=500&sortBy=CURRENT&sortDirection=DESC`,
  )) as Record<string, unknown>[];
  if (!Array.isArray(rows)) throw new Error("unexpected positions payload");
  return rows.map((r) => ({
    asset: String(r.asset),
    conditionId: String(r.conditionId),
    title: String(r.title ?? "Unknown market"),
    outcome: String(r.outcome ?? ""),
    size: Number(r.size) || 0,
    avgPrice: Number(r.avgPrice) || 0,
    curPrice: Number(r.curPrice) || 0,
    currentValue: Number(r.currentValue) || 0,
    redeemable: Boolean(r.redeemable),
    endDate: r.endDate ? String(r.endDate) : undefined,
  }));
}

/** Order book for a token, or null when the market no longer has one (resolved). */
export async function fetchBook(tokenId: string): Promise<Book | null> {
  const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} from /book`);
  const b = (await res.json()) as Record<string, unknown>;
  const side = (rows: unknown, dir: 1 | -1) =>
    ((rows as { price: string; size: string }[]) ?? [])
      .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
      .sort((x, y) => dir * (x.price - y.price));
  return {
    bids: side(b.bids, -1),
    asks: side(b.asks, 1),
    tickSize: String(b.tick_size ?? "0.01"),
    negRisk: Boolean(b.neg_risk),
    minOrderSize: Number(b.min_order_size) || 0,
  };
}

export type Geo = { blocked: boolean; country: string };

/** Whether Polymarket accepts orders from wherever this server is running. */
export async function fetchGeoblock(): Promise<Geo> {
  try {
    const g = (await getJson("https://polymarket.com/api/geoblock")) as Record<string, unknown>;
    return { blocked: Boolean(g.blocked), country: String(g.country ?? "?") };
  } catch {
    // Fail closed: if we can't confirm the region is allowed, don't trade.
    return { blocked: true, country: "unknown" };
  }
}
