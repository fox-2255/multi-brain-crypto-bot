// Simulated (paper) positions. No real orders are ever placed. State persists to a JSON file
// (atomic write) so a restart resumes open positions.
const fs = require('node:fs');
const path = require('node:path');

const MINUTE_MS = 60 * 1000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function validTrade(t) {
    return t && typeof t.symbol === 'string' && typeof t.exchange === 'string'
        && (t.status === 'OPEN' || t.status === 'CLOSED')
        && [t.entry, t.stopLoss, t.takeProfit, t.sizeUSDT, t.openedAt, t.checkedTs].every(isNum);
}

class PaperEngine {
    constructor({ file = null, startingBalance, feePct, slippagePct, now = Date.now, log = () => {} }) {
        this.file = file;
        this.startingBalance = startingBalance;
        this.feePct = feePct;
        this.slippagePct = slippagePct;
        this.now = now;
        this.log = log;
        this.trades = [];
        this.nextId = 1;
    }

    load() {
        if (!this.file) return;
        let raw;
        try {
            raw = fs.readFileSync(this.file, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return;
            throw err;
        }
        try {
            const data = JSON.parse(raw);
            if (!Array.isArray(data.trades) || !data.trades.every(validTrade)) throw new Error('invalid structure');
            this.trades = data.trades;
            this.nextId = Math.max(1, ...this.trades.map((t) => t.id || 0)) + 1;
            this.log('info', `Loaded ${this.trades.length} paper trade(s) from ${this.file}`);
        } catch (err) {
            const backup = `${this.file}.corrupt-${this.now()}`;
            fs.renameSync(this.file, backup);
            this.log('error', `Trade file unreadable (${err.message}); moved to ${backup}. Starting empty.`);
        }
    }

    save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, trades: this.trades }));
            fs.renameSync(tmp, this.file);
        } catch (err) {
            this.log('error', `Could not save paper trades: ${err.message}`);
        }
    }

    get(id) { return this.trades.find((t) => t.id === id); }
    allTrades() { return this.trades.map((t) => ({ ...t })); }
    openTrades(exchange) {
        return this.trades.filter((t) => t.status === 'OPEN' && (!exchange || t.exchange === exchange)).map((t) => ({ ...t }));
    }
    openCount() { return this.trades.filter((t) => t.status === 'OPEN').length; }
    hasOpen(exchange, symbol) {
        return this.trades.some((t) => t.status === 'OPEN' && t.exchange === exchange && t.symbol === symbol);
    }

    realizedPnl() {
        return this.trades.filter((t) => t.status === 'CLOSED').reduce((a, t) => a + t.pnlUSDT, 0);
    }
    equity() { return this.startingBalance + this.realizedPnl(); }

    // True when this symbol closed at a LOSS within the last `minutes` (0 disables). Stops the bot from
    // buying straight back into a setup that just failed.
    inCooldown(exchange, symbol, minutes) {
        if (!(minutes > 0)) return false;
        const since = this.now() - minutes * MINUTE_MS;
        return this.trades.some((t) => t.status === 'CLOSED' && t.result === 'LOSS' && t.exchange === exchange
            && t.symbol === symbol && isNum(t.closedAt) && t.closedAt >= since);
    }

    // True when realized losses over the last 24h reach limitPct of the equity at the start of that
    // window. Rolling window (not calendar day) so there is no timezone edge and no reset loophole.
    dailyLossHalted(limitPct) {
        const since = this.now() - 24 * 60 * MINUTE_MS;
        const pnl = this.trades
            .filter((t) => t.status === 'CLOSED' && isNum(t.closedAt) && t.closedAt >= since)
            .reduce((a, t) => a + t.pnlUSDT, 0);
        const base = this.equity() - pnl;
        return pnl < 0 && base > 0 && -pnl >= base * (limitPct / 100);
    }
    availableUSDT() {
        const used = this.trades.filter((t) => t.status === 'OPEN').reduce((a, t) => a + t.sizeUSDT, 0);
        return Math.max(0, this.equity() - used);
    }

    recent(limit = 200) {
        return this.trades.slice(-limit).reverse().map((t) => ({ ...t }));
    }

    stats() {
        const closed = this.trades.filter((t) => t.status === 'CLOSED');
        const wins = closed.filter((t) => t.result === 'WIN').length;
        return {
            closed: closed.length,
            wins,
            losses: closed.length - wins,
            open: this.openCount(),
            totalPnlUSDT: Number(this.realizedPnl().toFixed(2))
        };
    }

    open({ exchange, symbol, plan, score, signal, setup }) {
        if (this.hasOpen(exchange, symbol)) throw new Error(`Position already open: ${exchange} ${symbol}`);
        const openedAt = this.now();
        const trade = {
            id: this.nextId++,
            exchange,
            symbol,
            status: 'OPEN',
            entry: plan.entry,
            stopLoss: plan.stopLoss,
            takeProfit: plan.takeProfit,
            sizeUSDT: plan.positionSizeUSDT,
            score,
            signal: signal || null,
            setup: setup || 'trend',
            openedAt,
            checkedTs: openedAt // only 1m candles that start after entry count
        };
        this.trades.push(trade);
        this.save();
        return { ...trade };
    }

    // Walks closed 1m candles [ts, o, h, l, c, v] in order. If one candle touches both levels the
    // stop is assumed to hit first (conservative). Gaps through the stop fill at the open.
    // Returns the closed trade or null.
    settle(id, candles) {
        const trade = this.get(id);
        if (!trade || trade.status !== 'OPEN') return null;
        let advanced = false;
        for (const row of candles) {
            if (!Array.isArray(row) || !row.slice(0, 5).every(isNum)) continue; // malformed row: ignore
            const [ts, open, high, low] = row;
            if (ts < trade.checkedTs) continue;

            // Max favorable / adverse excursion (% from entry). Shows whether losers first went up
            // ("uptrend that reversed") or fell straight away. Informational only.
            trade.maxHighPct = Math.max(trade.maxHighPct ?? 0, Number(((high / trade.entry - 1) * 100).toFixed(3)));
            trade.minLowPct = Math.min(trade.minLowPct ?? 0, Number(((low / trade.entry - 1) * 100).toFixed(3)));

            let exit = null;
            let reason = null;
            if (low <= trade.stopLoss) {
                exit = Math.min(open, trade.stopLoss) * (1 - this.slippagePct / 100);
                reason = 'STOP_LOSS';
            } else if (high >= trade.takeProfit) {
                exit = trade.takeProfit;
                reason = 'TAKE_PROFIT';
            }
            if (reason) {
                this.close(trade, exit, reason, ts);
                this.save();
                return { ...trade };
            }
            trade.checkedTs = ts + MINUTE_MS;
            advanced = true;
        }
        if (advanced) this.save();
        return null;
    }

    close(trade, exit, reason, ts) {
        const grossPct = (exit / trade.entry - 1) * 100;
        const netPct = grossPct - 2 * this.feePct;
        trade.status = 'CLOSED';
        trade.exit = exit;
        trade.exitReason = reason;
        trade.pnlPct = Number(netPct.toFixed(4));
        trade.pnlUSDT = Number(((trade.sizeUSDT * netPct) / 100).toFixed(4));
        trade.result = trade.pnlUSDT > 0 ? 'WIN' : 'LOSS';
        trade.closedAt = ts;
    }
}

module.exports = { PaperEngine };
