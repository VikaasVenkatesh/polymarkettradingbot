# week1_paper_trading.py

import requests
import json
import sqlite3
from datetime import datetime
from typing import List, Dict, Optional
import time
import logging
import signal
import sys

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('week1_trading.log'),
        logging.StreamHandler()
    ]
)

class PolymarketPaperTrading:
    """Paper trading with real Polymarket data"""
    
    def __init__(self, db_path: str = "week1_paper.db", initial_balance: float = 100000):
        self.base_url = "https://clob.polymarket.com"
        self.gamma_url = "https://gamma-api.polymarket.com"
        self.db_path = db_path
        self.initial_balance = initial_balance
        
        self._init_database()
        self._init_account()
        
    def _init_database(self):
        """Create database to track paper trades"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account (
                id INTEGER PRIMARY KEY,
                balance REAL,
                initial_balance REAL,
                created_at TEXT,
                updated_at TEXT
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                market_id TEXT,
                token_id TEXT,
                market_question TEXT,
                outcome TEXT,
                side TEXT,
                size REAL,
                entry_price REAL,
                current_price REAL,
                unrealized_pnl REAL,
                status TEXT DEFAULT 'OPEN',
                opened_at TEXT,
                closed_at TEXT
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                market_id TEXT,
                token_id TEXT,
                market_question TEXT,
                outcome TEXT,
                side TEXT,
                size REAL,
                price REAL,
                cost REAL,
                realized_pnl REAL,
                timestamp TEXT
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tracked_traders (
                address TEXT PRIMARY KEY,
                nickname TEXT,
                added_at TEXT,
                total_copied_trades INTEGER DEFAULT 0
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS trader_positions_snapshot (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trader_address TEXT,
                market_id TEXT,
                outcome TEXT,
                size REAL,
                snapshot_time TEXT,
                UNIQUE(trader_address, market_id, outcome, snapshot_time)
            )
        """)
        
        conn.commit()
        conn.close()
        
    def _init_account(self):
        """Initialize paper trading account"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM account WHERE id = 1")
        if not cursor.fetchone():
            cursor.execute("""
                INSERT INTO account (id, balance, initial_balance, created_at, updated_at)
                VALUES (1, ?, ?, ?, ?)
            """, (self.initial_balance, self.initial_balance, 
                  datetime.now().isoformat(), datetime.now().isoformat()))
            conn.commit()
        
        conn.close()
    
    # ==================== REAL POLYMARKET API CALLS ====================
    
    def get_live_markets(self, limit: int = 50, closed: bool = False) -> List[Dict]:
        """Get real active markets from Polymarket"""
        try:
            params = {
                'limit': limit,
                'closed': closed,
                'active': not closed
            }
            response = requests.get(f"{self.gamma_url}/markets", params=params, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logging.error(f"Error fetching markets: {e}")
            return []
    
    def get_live_market_details(self, condition_id: str) -> Optional[Dict]:
        """Get real market details"""
        try:
            response = requests.get(f"{self.gamma_url}/markets/{condition_id}", timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logging.error(f"Error fetching market {condition_id}: {e}")
            return None
    
    def get_live_trader_positions(self, address: str) -> List[Dict]:
        """Get real trader positions"""
        try:
            response = requests.get(
                f"{self.gamma_url}/positions",
                params={'user': address},
                timeout=10
            )
            response.raise_for_status()
            data = response.json()
            return data if isinstance(data, list) else []
        except Exception as e:
            logging.error(f"Error fetching trader positions for {address}: {e}")
            return []
    
    def get_current_market_price(self, market_id: str, outcome: str = "YES") -> Optional[float]:
        """Get current market price for an outcome"""
        market = self.get_live_market_details(market_id)
        if not market:
            return None
        
        if outcome == "YES":
            return market.get('yes_price', 0.5)
        else:
            return market.get('no_price', 0.5)
    
    # ==================== PAPER TRADING FUNCTIONS ====================
    
    def get_account_balance(self) -> float:
        """Get current paper account balance"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT balance FROM account WHERE id = 1")
        balance = cursor.fetchone()[0]
        conn.close()
        return balance
    
    def execute_paper_trade(self, market_id: str, market_question: str,
                           outcome: str, side: str, size: float,
                           token_id: str = None) -> Dict:
        """Execute a paper trade based on real market prices"""
        
        price = self.get_current_market_price(market_id, outcome)
        
        if price is None:
            return {
                'success': False,
                'error': 'Could not fetch current market price'
            }
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT balance FROM account WHERE id = 1")
        balance = cursor.fetchone()[0]
        
        if side == 'BUY':
            cost = size * price
            
            if cost > balance:
                conn.close()
                return {
                    'success': False,
                    'error': f'Insufficient balance. Need ${cost:.2f}, have ${balance:.2f}'
                }
            
            new_balance = balance - cost
            
            cursor.execute("""
                INSERT INTO positions (market_id, token_id, market_question, outcome, 
                                     side, size, entry_price, current_price, 
                                     unrealized_pnl, opened_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (market_id, token_id, market_question, outcome, side, size, 
                  price, price, 0.0, datetime.now().isoformat()))
            
            cursor.execute("""
                INSERT INTO trades (market_id, token_id, market_question, outcome, 
                                  side, size, price, cost, realized_pnl, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (market_id, token_id, market_question, outcome, side, size, 
                  price, cost, 0.0, datetime.now().isoformat()))
            
            realized_pnl = 0
            
        else:  # SELL
            cursor.execute("""
                SELECT id, size, entry_price FROM positions
                WHERE market_id = ? AND outcome = ? AND status = 'OPEN'
            """, (market_id, outcome))
            
            position = cursor.fetchone()
            
            if not position:
                conn.close()
                return {
                    'success': False,
                    'error': 'No open position to sell'
                }
            
            pos_id, pos_size, entry_price = position
            
            if size > pos_size:
                conn.close()
                return {
                    'success': False,
                    'error': f'Cannot sell {size} shares, only have {pos_size}'
                }
            
            realized_pnl = (price - entry_price) * size
            proceeds = size * price
            new_balance = balance + proceeds
            
            if size == pos_size:
                cursor.execute("""
                    UPDATE positions
                    SET status = 'CLOSED', closed_at = ?
                    WHERE id = ?
                """, (datetime.now().isoformat(), pos_id))
            else:
                cursor.execute("""
                    UPDATE positions
                    SET size = size - ?
                    WHERE id = ?
                """, (size, pos_id))
            
            cursor.execute("""
                INSERT INTO trades (market_id, token_id, market_question, outcome,
                                  side, size, price, cost, realized_pnl, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (market_id, token_id, market_question, outcome, side, size,
                  price, -proceeds, realized_pnl, datetime.now().isoformat()))
            
            cost = proceeds
        
        cursor.execute("""
            UPDATE account
            SET balance = ?, updated_at = ?
            WHERE id = 1
        """, (new_balance, datetime.now().isoformat()))
        
        conn.commit()
        conn.close()
        
        return {
            'success': True,
            'side': side,
            'market': market_question,
            'outcome': outcome,
            'size': size,
            'price': price,
            'cost': cost,
            'new_balance': new_balance,
            'realized_pnl': realized_pnl if side == 'SELL' else 0
        }
    
    def update_positions_with_live_prices(self):
        """Update all open positions with current market prices"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM positions WHERE status = 'OPEN'")
        positions = cursor.fetchall()
        
        for pos in positions:
            pos_id = pos[0]
            market_id = pos[1]
            outcome = pos[4]
            size = pos[6]
            entry_price = pos[7]
            
            current_price = self.get_current_market_price(market_id, outcome)
            
            if current_price:
                unrealized_pnl = (current_price - entry_price) * size
                
                cursor.execute("""
                    UPDATE positions
                    SET current_price = ?, unrealized_pnl = ?
                    WHERE id = ?
                """, (current_price, unrealized_pnl, pos_id))
        
        conn.commit()
        conn.close()
    
    def get_portfolio_summary(self) -> Dict:
        """Get complete portfolio summary with live prices"""
        self.update_positions_with_live_prices()
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM account WHERE id = 1")
        account = cursor.fetchone()
        balance = account[1]
        initial_balance = account[2]
        
        cursor.execute("SELECT * FROM positions WHERE status = 'OPEN'")
        positions = cursor.fetchall()
        
        total_unrealized_pnl = sum(pos[9] for pos in positions)
        total_position_value = sum(pos[6] * pos[8] for pos in positions)
        
        cursor.execute("SELECT SUM(realized_pnl) FROM trades WHERE side = 'SELL'")
        total_realized_pnl = cursor.fetchone()[0] or 0
        
        portfolio_value = balance + total_position_value
        total_pnl = portfolio_value - initial_balance
        total_return_pct = (total_pnl / initial_balance) * 100
        
        cursor.execute("SELECT COUNT(*) FROM trades")
        total_trades = cursor.fetchone()[0]
        
        conn.close()
        
        return {
            'initial_balance': initial_balance,
            'cash_balance': balance,
            'position_value': total_position_value,
            'portfolio_value': portfolio_value,
            'total_pnl': total_pnl,
            'total_return_pct': total_return_pct,
            'unrealized_pnl': total_unrealized_pnl,
            'realized_pnl': total_realized_pnl,
            'open_positions': len(positions),
            'total_trades': total_trades
        }
    
    def get_open_positions(self) -> List[Dict]:
        """Get all open positions with current prices"""
        self.update_positions_with_live_prices()
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM positions WHERE status = 'OPEN'")
        rows = cursor.fetchall()
        conn.close()
        
        positions = []
        for row in rows:
            positions.append({
                'id': row[0],
                'market_id': row[1],
                'question': row[3],
                'outcome': row[4],
                'size': row[6],
                'entry_price': row[7],
                'current_price': row[8],
                'unrealized_pnl': row[9],
                'unrealized_pnl_pct': (row[9] / (row[6] * row[7])) * 100 if row[6] * row[7] > 0 else 0,
                'opened_at': row[11]
            })
        
        return positions
    
    # ==================== TRADER TRACKING ====================
    
    def add_trader_to_track(self, address: str, nickname: str = None):
        """Add a trader to copy"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        try:
            cursor.execute("""
                INSERT INTO tracked_traders (address, nickname, added_at)
                VALUES (?, ?, ?)
            """, (address, nickname or address[:10], datetime.now().isoformat()))
            conn.commit()
            logging.info(f"✅ Now tracking trader: {nickname or address}")
        except sqlite3.IntegrityError:
            logging.warning(f"⚠️  Already tracking {address}")
        
        conn.close()
    
    def get_tracked_traders(self) -> List[Dict]:
        """Get all tracked traders"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM tracked_traders")
        rows = cursor.fetchall()
        conn.close()
        
        return [
            {
                'address': row[0],
                'nickname': row[1],
                'added_at': row[2],
                'total_copied': row[3]
            }
            for row in rows
        ]
    
    def save_trader_snapshot(self, address: str, positions: List[Dict]):
        """Save snapshot of trader's positions"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        snapshot_time = datetime.now().isoformat()
        
        for pos in positions:
            try:
                cursor.execute("""
                    INSERT INTO trader_positions_snapshot 
                    (trader_address, market_id, outcome, size, snapshot_time)
                    VALUES (?, ?, ?, ?, ?)
                """, (address, pos.get('market'), pos.get('outcome'), 
                      pos.get('size'), snapshot_time))
            except sqlite3.IntegrityError:
                pass
        
        conn.commit()
        conn.close()
    
    def detect_new_positions(self, address: str, current_positions: List[Dict]) -> List[Dict]:
        """Compare current positions with last snapshot to find new ones"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT DISTINCT market_id, outcome, size 
            FROM trader_positions_snapshot
            WHERE trader_address = ?
            AND snapshot_time = (
                SELECT MAX(snapshot_time) 
                FROM trader_positions_snapshot 
                WHERE trader_address = ?
            )
        """, (address, address))
        
        last_positions = cursor.fetchall()
        conn.close()
        
        last_pos_set = {(p[0], p[1]) for p in last_positions}
        
        new_positions = []
        for pos in current_positions:
            market_id = pos.get('market')
            outcome = pos.get('outcome')
            
            if (market_id, outcome) not in last_pos_set:
                new_positions.append(pos)
        
        return new_positions


class CopyTradingBot:
    """Automated copytrading bot using paper trading account"""
    
    def __init__(self, paper_trader: PolymarketPaperTrading, copy_ratio: float = 0.02):
        self.trader = paper_trader
        self.copy_ratio = copy_ratio
        
    def monitor_and_copy_trades(self):
        """Check tracked traders and copy new positions"""
        tracked = self.trader.get_tracked_traders()
        
        if not tracked:
            logging.warning("⚠️  No traders being tracked.")
            return []
        
        results = []
        
        for trader_info in tracked:
            address = trader_info['address']
            nickname = trader_info['nickname']
            
            logging.info(f"🔍 Checking {nickname}...")
            
            current_positions = self.trader.get_live_trader_positions(address)
            
            if not current_positions:
                logging.info(f"   No positions found")
                continue
            
            new_positions = self.trader.detect_new_positions(address, current_positions)
            
            if new_positions:
                logging.info(f"   📍 Found {len(new_positions)} new position(s)")
            
            for pos in new_positions:
                market_id = pos.get('market')
                outcome = pos.get('outcome')
                their_size = float(pos.get('size', 0))
                
                market = self.trader.get_live_market_details(market_id)
                
                if not market:
                    continue
                
                question = market.get('question', 'Unknown Market')
                
                our_size = their_size * self.copy_ratio
                
                if our_size < 1:
                    our_size = 1
                
                logging.info(f"\n   🎯 Copying position:")
                logging.info(f"      Market: {question[:60]}")
                logging.info(f"      Outcome: {outcome}")
                logging.info(f"      Their size: ${their_size:.2f}")
                logging.info(f"      Our size: ${our_size:.2f}")
                
                result = self.trader.execute_paper_trade(
                    market_id=market_id,
                    market_question=question,
                    outcome=outcome,
                    side='BUY',
                    size=our_size
                )
                
                if result['success']:
                    logging.info(f"      ✅ Trade executed @ ${result['price']:.3f}")
                    logging.info(f"      💰 New balance: ${result['new_balance']:.2f}")
                    
                    conn = sqlite3.connect(self.trader.db_path)
                    cursor = conn.cursor()
                    cursor.execute("""
                        UPDATE tracked_traders
                        SET total_copied_trades = total_copied_trades + 1
                        WHERE address = ?
                    """, (address,))
                    conn.commit()
                    conn.close()
                else:
                    logging.error(f"      ❌ Failed: {result.get('error')}")
                
                results.append({
                    'trader': nickname,
                    'position': pos,
                    'result': result
                })
            
            self.trader.save_trader_snapshot(address, current_positions)
        
        return results


class Week1Runner:
    """Run Week 1 paper trading"""
    
    def __init__(self):
        self.paper_trader = PolymarketPaperTrading(
            db_path="week1_paper.db",
            initial_balance=100000
        )
        self.bot = CopyTradingBot(self.paper_trader, copy_ratio=0.02)
        self.running = True
        self.scan_interval = 300  # 5 minutes
        
        signal.signal(signal.SIGINT, self.shutdown)
        signal.signal(signal.SIGTERM, self.shutdown)
    
    def shutdown(self, signum, frame):
        """Graceful shutdown"""
        logging.info("\n🛑 Shutting down...")
        self.running = False
        self.print_summary()
        sys.exit(0)
    
    def print_summary(self):
        """Print current portfolio summary"""
        summary = self.paper_trader.get_portfolio_summary()
        
        print("\n" + "="*70)
        print("📊 PORTFOLIO SUMMARY")
        print("="*70)
        
        print(f"\n💰 Account:")
        print(f"   Initial:    ${summary['initial_balance']:,.2f}")
        print(f"   Cash:       ${summary['cash_balance']:,.2f}")
        print(f"   Positions:  ${summary['position_value']:,.2f}")
        print(f"   Total:      ${summary['portfolio_value']:,.2f}")
        
        pnl_emoji = "📗" if summary['total_pnl'] >= 0 else "📕"
        print(f"\n{pnl_emoji} P&L:")
        print(f"   Total:      ${summary['total_pnl']:,.2f} ({summary['total_return_pct']:+.2f}%)")
        print(f"   Unrealized: ${summary['unrealized_pnl']:,.2f}")
        print(f"   Realized:   ${summary['realized_pnl']:,.2f}")
        
        print(f"\n📈 Activity:")
        print(f"   Positions:  {summary['open_positions']} open")
        print(f"   Trades:     {summary['total_trades']} total")
    
    def run_continuous(self):
        """Run continuously with periodic scans"""
        logging.info("="*70)
        logging.info("🚀 WEEK 1 PAPER TRADING - STARTING")
        logging.info("="*70)
        logging.info(f"💵 Initial capital: $100,000")
        logging.info(f"🔄 Scan interval: {self.scan_interval} seconds")
        logging.info("")
        
        scan_count = 0
        
        while self.running:
            scan_count += 1
            logging.info(f"\n{'='*70}")
            logging.info(f"🔍 Scan #{scan_count} - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            logging.info(f"{'='*70}")
            
            try:
                results = self.bot.monitor_and_copy_trades()
                
                if results:
                    logging.info(f"\n✅ Executed {len(results)} new trade(s)")
                else:
                    logging.info(f"\nℹ️  No new positions detected")
                
                if scan_count % 12 == 0:  # Every hour
                    self.print_summary()
                
            except Exception as e:
                logging.error(f"\n❌ Error during scan: {e}")
                import traceback
                traceback.print_exc()
            
            time.sleep(self.scan_interval)


def setup_traders(paper_trader):
    """
    Add traders to track
    
    IMPORTANT: Replace these with REAL trader addresses from Polymarket!
    Find them at: https://polymarket.com/leaderboard
    """
    
    print("\n" + "="*70)
    print("👥 TRADER SETUP")
    print("="*70)
    print("\nYou need to add real Polymarket trader addresses to copy.")
    print("Find top traders at: https://polymarket.com/leaderboard")
    print("\nEnter trader addresses (0x...) or press ENTER to skip:")
    
    while True:
        address = input("\nTrader address (or ENTER to finish): ").strip()
        if not address:
            break
        
        nickname = input("Nickname (optional): ").strip() or None
        paper_trader.add_trader_to_track(address, nickname)
    
    tracked = paper_trader.get_tracked_traders()
    print(f"\n✅ Tracking {len(tracked)} trader(s)")
    
    if len(tracked) == 0:
        print("\n⚠️  WARNING: No traders added! Bot won't do anything.")
        print("Add traders later with: paper_trader.add_trader_to_track(address, nickname)")


if __name__ == "__main__":
    print("="*70)
    print("🎯 WEEK 1: POLYMARKET PAPER TRADING")
    print("="*70)
    print("\n💵 Starting Capital: $100,000 (fake money)")
    print("📊 Strategy: Copy top Polymarket traders")
    print("⏱️  Duration: Run for 7 days")
    
    runner = Week1Runner()
    
    # Setup traders
    setup_traders(runner.paper_trader)
    
    # Show initial portfolio
    runner.print_summary()
    
    print("\n" + "="*70)
    input("\n⏸️  Press ENTER to start continuous monitoring (Ctrl+C to stop)...")
    
    # Run continuous monitoring
    runner.run_continuous()