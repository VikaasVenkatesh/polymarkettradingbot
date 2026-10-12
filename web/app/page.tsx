"use client";

import { useCallback, useEffect, useState } from "react";

type Settings = { budget_usd: number; top_traders: number; top_positions: number; live: boolean; paused: boolean };
type Wallet = { address: string; funder_address: string | null; signature_type: number };
type Trader = { rank: number; address: string; name: string; pnl: number; volume: number };
type Target = { trader: string; address: string; title: string; outcome: string; price: number; usd: number; held: boolean };
type Position = { id: number; trader_name: string; title: string; outcome: string; shares: number; cost_usd: number; price: number; value: number };
type Order = { id: number; side: string; title: string; outcome: string; trader_name: string; usd: number; shares: number; price: number; mode: string; ok: boolean; detail: string | null; created_at: string };
type State = {
  user: { email: string } | null;
  settings: Settings;
  wallet: Wallet | null;
  traders: Trader[];
  refreshedAt: string | null;
  lastScanAt: string | null;
  targets: Target[];
  open: Position[];
  realized: number;
  orders: Order[];
  liveEnabled: boolean;
  geo: { blocked: boolean; country: string };
};

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
const cents = (p: number) => `${(p * 100).toFixed(1)}¢`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never");

async function post(url: string, body: unknown, method = "POST") {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function Auth({ onDone }: { onDone: () => void }) {
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/auth", { action: signup ? "signup" : "login", email, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <h1>Polymarket Copy Trader</h1>
      <p className="muted">
        Follows the week&apos;s most profitable Polymarket traders and mirrors their largest positions with a budget you set.
      </p>
      <form className="card" onSubmit={submit}>
        <h2>{signup ? "Create an account" : "Sign in"}</h2>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signup ? "new-password" : "current-password"}
            minLength={signup ? 10 : undefined}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button disabled={busy}>{signup ? "Create account" : "Sign in"}</button>
        </div>
        <p className="small muted" style={{ marginTop: 14 }}>
          {signup ? "Already have an account? " : "New here? "}
          <button type="button" className="linkish" onClick={() => setSignup(!signup)}>
            {signup ? "Sign in" : "Create an account"}
          </button>
        </p>
      </form>
    </main>
  );
}

function SettingsCard({ state, reload }: { state: State; reload: () => void }) {
  const [form, setForm] = useState(state.settings);
  const [attest, setAttest] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const goingLive = form.live && !state.settings.live;
  const liveBlocked = !state.liveEnabled || state.geo.blocked || !state.wallet;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await post("/api/settings", { ...form, attest });
      setMsg({ ok: true, text: "Saved. Changes apply on the next scan." });
      reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const perTrader = form.top_traders > 0 ? form.budget_usd / form.top_traders : 0;

  return (
    <form className="card" onSubmit={save}>
      <h2>Strategy</h2>
      <p className="muted small">Your budget is split evenly across the top traders, then across each trader&apos;s largest positions by value.</p>
      <label className="field">
        Budget to trade with (USD)
        <input type="number" min={0} step="1" value={form.budget_usd} onChange={(e) => setForm({ ...form, budget_usd: Number(e.target.value) })} />
      </label>
      <label className="field">
        Top traders to follow
        <input type="number" min={1} max={20} value={form.top_traders} onChange={(e) => setForm({ ...form, top_traders: Number(e.target.value) })} />
      </label>
      <label className="field">
        Positions to copy per trader
        <input type="number" min={1} max={10} value={form.top_positions} onChange={(e) => setForm({ ...form, top_positions: Number(e.target.value) })} />
      </label>
      <p className="small muted" style={{ marginTop: 8 }}>{usd(perTrader)} per trader</p>

      <label className="check">
        <input type="checkbox" checked={!form.paused} onChange={(e) => setForm({ ...form, paused: !e.target.checked })} />
        <span>Trading on<br /><span className="small muted">When off, nothing is bought or sold and open positions are left alone.</span></span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={form.live}
          disabled={liveBlocked && !state.settings.live}
          onChange={(e) => setForm({ ...form, live: e.target.checked })}
        />
        <span>
          Live trading with real money
          <br />
          <span className="small muted">
            {!state.liveEnabled
              ? "Switched off on this deployment."
              : state.geo.blocked
                ? `Unavailable: Polymarket does not accept orders from this server (${state.geo.country}).`
                : !state.wallet
                  ? "Connect a wallet first."
                  : "Off means paper trading: simulated fills against the live order book."}
          </span>
        </span>
      </label>
      {goingLive && (
        <label className="check">
          <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          <span className="small">
            I am permitted to trade on Polymarket where I live, and I understand real orders will be placed from my wallet and I can lose
            the whole budget.
          </span>
        </label>
      )}
      {msg && <p className={msg.ok ? "ok" : "error"}>{msg.text}</p>}
      <div className="row">
        <button disabled={busy || (goingLive && !attest)}>Save</button>
      </div>
    </form>
  );
}

function WalletCard({ state, reload }: { state: State; reload: () => void }) {
  const [key, setKey] = useState("");
  const [type, setType] = useState(2);
  const [funder, setFunder] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
      reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (state.wallet) {
    return (
      <div className="card">
        <h2>Wallet</h2>
        <p className="small muted" style={{ wordBreak: "break-all" }}>
          Signer {state.wallet.address}
          {state.wallet.funder_address && <><br />Funds held at {state.wallet.funder_address}</>}
        </p>
        {msg && <p className={msg.ok ? "ok" : "error"}>{msg.text}</p>}
        <div className="row">
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const res = await fetch("/api/wallet/balance");
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                return `Available to trade: ${usd(data.balance)}`;
              })
            }
          >
            Check balance
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (confirm("Remove this wallet? Live trading will be switched off. Positions already bought stay in your wallet.")) {
                run(async () => {
                  await post("/api/wallet", {}, "DELETE");
                  return "Wallet removed.";
                });
              }
            }}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  if (!state.liveEnabled) {
    return (
      <div className="card">
        <h2>Wallet</h2>
        <p className="muted small">Live trading is switched off on this deployment, so there is no wallet to connect. Paper trading needs none.</p>
      </div>
    );
  }

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await post("/api/wallet", { private_key: key, signature_type: type, funder_address: funder });
          setKey("");
          return "Wallet connected.";
        });
      }}
    >
      <h2>Wallet</h2>
      <p className="muted small">
        Only needed for live trading. Use a dedicated wallet that holds only what you are willing to trade: the key is stored encrypted on
        the server so orders can be signed while you are away.
      </p>
      <label className="field">
        Wallet type
        <select value={type} onChange={(e) => setType(Number(e.target.value))}>
          <option value={2}>Polymarket account, browser wallet login</option>
          <option value={1}>Polymarket account, email login</option>
          <option value={0}>Standalone wallet (funds held by the key itself)</option>
        </select>
      </label>
      <label className="field">
        Private key
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder="0x…" required />
      </label>
      {type !== 0 && (
        <label className="field">
          Polymarket deposit address
          <input type="text" value={funder} onChange={(e) => setFunder(e.target.value)} placeholder="0x…" required />
        </label>
      )}
      {msg && <p className={msg.ok ? "ok" : "error"}>{msg.text}</p>}
      <div className="row">
        <button disabled={busy}>Connect wallet</button>
      </div>
    </form>
  );
}

function Dashboard({ state, reload }: { state: State; reload: () => void }) {
  const { settings, open, targets, traders, orders } = state;
  const deployed = open.reduce((s, p) => s + p.cost_usd, 0);
  const value = open.reduce((s, p) => s + p.value, 0);
  const unrealized = value - deployed;

  return (
    <main className="shell">
      <div className="topbar">
        <h1>Polymarket Copy Trader</h1>
        <span className={`pill ${settings.live ? "live" : "paper"}`}>{settings.live ? "LIVE" : "PAPER"}</span>
        <span className={`pill ${settings.paused ? "" : "on"}`}>{settings.paused ? "PAUSED" : "RUNNING"}</span>
        <span className="small muted">{state.user?.email}</span>
        <button className="ghost" onClick={() => post("/api/auth", { action: "logout" }).then(reload)}>
          Sign out
        </button>
      </div>

      {state.geo.blocked && (
        <div className="banner">
          Polymarket does not accept orders from this server&apos;s region ({state.geo.country}), so live trading is unavailable. Paper
          trading works normally.
        </div>
      )}

      <div className="tiles">
        <div className="tile"><div className="label">Budget</div><div className="value">{usd(settings.budget_usd)}</div></div>
        <div className="tile"><div className="label">Deployed</div><div className="value">{usd(deployed)}</div></div>
        <div className="tile"><div className="label">Position value</div><div className="value">{usd(value)}</div></div>
        <div className="tile"><div className="label">Unrealized P&amp;L</div><div className={`value ${unrealized >= 0 ? "good" : "bad"}`}>{signed(unrealized)}</div></div>
        <div className="tile"><div className="label">Realized P&amp;L</div><div className={`value ${state.realized >= 0 ? "good" : "bad"}`}>{signed(state.realized)}</div></div>
      </div>

      <div className="grid">
        <div className="stack">
          <SettingsCard state={state} reload={reload} />
          <WalletCard state={state} reload={reload} />
        </div>

        <div className="stack">
          <section className="card">
            <h2>Allocation plan</h2>
            <p className="muted small">What your budget buys right now. Last scan {when(state.lastScanAt)}.</p>
            {targets.length ? (
              <div className="scroll">
                <table>
                  <thead><tr><th>Trader</th><th>Market</th><th>Outcome</th><th className="num">Price</th><th className="num">Allocation</th><th>Status</th></tr></thead>
                  <tbody>
                    {targets.map((t, i) => (
                      <tr key={i}>
                        <td>{t.trader}</td><td className="wrap">{t.title}</td><td>{t.outcome}</td>
                        <td className="num">{cents(t.price)}</td><td className="num">{usd(t.usd)}</td>
                        <td className={t.held ? "good" : "muted"}>{t.held ? "Held" : "Pending"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">{settings.budget_usd > 0 ? "Waiting for the first scan." : "Set a budget to see your plan."}</p>
            )}
          </section>

          <section className="card">
            <h2>Open positions</h2>
            {open.length ? (
              <div className="scroll">
                <table>
                  <thead><tr><th>Market</th><th>Outcome</th><th>Copied from</th><th className="num">Shares</th><th className="num">Cost</th><th className="num">Value</th><th className="num">P&amp;L</th></tr></thead>
                  <tbody>
                    {open.map((p) => (
                      <tr key={p.id}>
                        <td className="wrap">{p.title}</td><td>{p.outcome}</td><td>{p.trader_name}</td>
                        <td className="num">{p.shares.toFixed(2)}</td><td className="num">{usd(p.cost_usd)}</td><td className="num">{usd(p.value)}</td>
                        <td className={`num ${p.value - p.cost_usd >= 0 ? "good" : "bad"}`}>{signed(p.value - p.cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">No open positions.</p>
            )}
          </section>

          <section className="card">
            <h2>This week&apos;s leaderboard</h2>
            <p className="muted small">Refreshed weekly from Polymarket. Last refresh {when(state.refreshedAt)}.</p>
            {traders.length ? (
              <div className="scroll">
                <table>
                  <thead><tr><th>#</th><th>Trader</th><th className="num">Weekly profit</th><th className="num">Volume</th><th>Following</th></tr></thead>
                  <tbody>
                    {traders.map((t) => (
                      <tr key={t.rank} className={t.rank > settings.top_traders ? "dim" : ""}>
                        <td>{t.rank}</td>
                        <td><a href={`https://polymarket.com/profile/${t.address}`} target="_blank" rel="noreferrer">{t.name}</a></td>
                        <td className="num good">{usd(t.pnl)}</td><td className="num">{usd(t.volume)}</td>
                        <td>{t.rank <= settings.top_traders ? "Yes" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">The leaderboard loads on the first scan.</p>
            )}
          </section>

          <section className="card">
            <h2>Recent orders</h2>
            {orders.length ? (
              <div className="scroll">
                <table>
                  <thead><tr><th>Time</th><th>Side</th><th>Market</th><th className="num">Shares</th><th className="num">Price</th><th className="num">Total</th><th>Result</th></tr></thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td className="small" style={{ whiteSpace: "nowrap" }}>{when(o.created_at)}</td>
                        <td>{o.side} <span className="small muted">{o.mode}</span></td>
                        <td className="wrap">{o.title} <span className="muted">· {o.outcome}</span></td>
                        <td className="num">{o.shares.toFixed(2)}</td><td className="num">{o.ok ? cents(o.price) : "—"}</td><td className="num">{usd(o.usd)}</td>
                        <td className={o.ok ? "good" : "bad"}>{o.ok ? "Filled" : o.detail || "Failed"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">No orders yet.</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

export default function Page() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(`Could not load (${res.status})`);
      setState(await res.json());
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  if (error && !state) return <main className="auth"><p className="error">{error}</p></main>;
  if (!state) return <main className="auth"><p className="muted">Loading…</p></main>;
  if (!state.user) return <Auth onDone={load} />;
  return <Dashboard state={state} reload={load} />;
}
