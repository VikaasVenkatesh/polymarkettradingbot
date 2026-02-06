# Week 1: Polymarket Paper Trading Bot

## Overview
This is a 7-day paper trading bot that copies successful Polymarket traders using **$100,000 in fake money**. It tracks real markets and real traders, but executes all trades in a local database so you can test your strategy risk-free.

## Features
- **Real Markets, Fake Money** - Uses live Polymarket API for prices
- **Copy Trading** - Automatically mimics top traders' positions
- **Real-time Tracking** - Monitors traders every 5 minutes
- **Full Analytics** - Track P&L, positions, and trade history
- **Safe Testing** - No real money at risk

## Quick Start



### 2. Install Dependencies
```bash
pip install requests
```

### 3. Run the Bot
``` bash python week1_paper_trading.py ```

### 4. Add Trader Addresses
When prompted, add trader wallet addresses. Find them at:
- https://polymarket.com/leaderboard
- Look for top performers with high P&L
- Copy their wallet address (starts with `0x...`)

### 5. Let It Run for a Week!
The bot will continuously monitor and copy trades every 5 minutes.

---

## How to Find Traders to Copy

1. Go to https://polymarket.com/
2. Browse the leaderboard for high-volume, profitable traders
3. Click on their profile to see their wallet address (starts with `0x...`)
4. Copy the address
5. Paste it when the bot prompts you

---

## Monitoring Your Bot

### Watch Live Logs
```bash
# In another terminal, watch real-time activity
tail -f week1_trading.log
```

### Check Portfolio Status
```bash
# See current account balance
sqlite3 week1_paper.db "SELECT * FROM account"

# View recent trades
sqlite3 week1_paper.db "SELECT * FROM trades ORDER BY timestamp DESC LIMIT 10"

# See open positions
sqlite3 week1_paper.db "SELECT market_question, outcome, size, unrealized_pnl FROM positions WHERE status='OPEN'"
```

---

## Running in Background (7 Days Continuous)

### Option 1: Using Screen (Recommended)
```bash
# Start a screen session
screen -S polymarket

# Run the bot
python week1_paper_trading.py

# Detach from screen (keeps it running)
# Press: Ctrl+A, then D

# Later, reattach to check progress
screen -r polymarket

# To stop the bot
# Press: Ctrl+C
```

### Option 2: Using nohup
```bash
# Run in background
nohup python week1_paper_trading.py > output.log 2>&1 &

# Check if it's running
ps aux | grep week1_paper

# Stop the bot
pkill -f week1_paper_trading.py
```

---

## Quick Status Check


Run anytime:
```bash
python quick_check.py
```

---

## Configuration

### Key Settings (in the code)
```python
# Initial capital
initial_balance = 100000  # $100k fake money

# Copy ratio - how much of their position to copy
copy_ratio = 0.02  # 2% (if they buy $1000, you buy $20)

# Scan interval
scan_interval = 300  # 5 minutes between scans
```

### Adjusting Copy Size
To copy more/less of each trade, edit this line in `week1_paper_trading.py`:
```python
self.bot = CopyTradingBot(self.paper_trader, copy_ratio=0.02)  # Change 0.02 to your preference
```

- `0.01` = 1% (very conservative)
- `0.02` = 2% (recommended for testing)
- `0.05` = 5% (aggressive)
- `0.10` = 10% (very aggressive)

---

## What Happens Each Scan

Every 5 minutes, the bot:
1. ✅ Fetches current positions of each tracked trader
2. ✅ Compares with last known positions to detect new trades
3. ✅ Gets live market prices from Polymarket
4. ✅ Executes paper trades (stored in database)
5. ✅ Updates portfolio with current P&L
6. ✅ Logs all activity

---

## Files Created
```
week1_paper.db          # SQLite database with all your trades
week1_trading.log       # Activity log
quick_check.py          # Status checker script
```

---

## After 7 Days

### Analyze Your Results
Run the quick check script to see final performance:
```bash
python quick_check.py
```

## Troubleshooting

### Bot Not Finding New Trades
- ✅ Verify trader addresses are active (check their Polymarket profile)
- ✅ Make sure traders are actually making new trades (some only trade occasionally)
- ✅ Check logs: `tail -f week1_trading.log`

### API Errors
- ✅ Check internet connection
- ✅ Polymarket API might be rate limiting - bot will retry
- ✅ Look in logs for specific error messages

### Database Locked
```bash
# If you get "database is locked" errors:
# Make sure only one instance of the bot is running
pkill -f week1_paper_trading.py
python week1_paper_trading.py
```

### Want to Reset and Start Over
```bash
# Delete database and logs
rm week1_paper.db week1_trading.log

# Run bot again
python week1_paper_trading.py
```

---
## Key Metrics to Watch

### Good Signs ✅
- Steady positive P&L growth
- 60%+ of trades are profitable
- Low drawdown (max loss from peak)
- Consistent returns across different market types

### Warning Signs ⚠️
- Negative P&L after several days
- Large drawdowns (>20% from peak)
- Only profitable in one specific market type
- Very few trades executed (traders not active)

---


If you run into issues:
1. Check `week1_trading.log` for error messages
2. Verify trader addresses are correct and active
3. Make sure Polymarket API is accessible
4. Try with different traders if current ones aren't active

---