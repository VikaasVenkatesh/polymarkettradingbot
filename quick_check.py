# quick_check.py - Run this anytime to see your status

from paper_trading import PolymarketPaperTrading

trader = PolymarketPaperTrading(db_path="week1_paper.db")
summary = trader.get_portfolio_summary()

print(f"\n💰 Portfolio Value: ${summary['portfolio_value']:,.2f}")
print(f"📊 P&L: ${summary['total_pnl']:,.2f} ({summary['total_return_pct']:+.2f}%)")
print(f"📈 Trades: {summary['total_trades']}")
print(f"🎯 Open Positions: {summary['open_positions']}")

# See your best positions
positions = trader.get_open_positions()
if positions:
    print("\n🏆 Top 3 Positions:")
    sorted_pos = sorted(positions, key=lambda x: x['unrealized_pnl'], reverse=True)
    for i, pos in enumerate(sorted_pos[:3], 1):
        print(f"\n{i}. {pos['question'][:50]}")
        print(f"   P&L: ${pos['unrealized_pnl']:+.2f} ({pos['unrealized_pnl_pct']:+.1f}%)")