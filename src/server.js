const path = require('node:path');
const express = require('express');
const cors = require('cors');

const { loadConfig } = require('./config/loadConfig');
const { createLogger } = require('./lib/logger');
const { httpError } = require('./lib/http');
const { PaperEngine } = require('./lib/paperEngine');
const { createScanner } = require('./scanner');
const { analyzeSentiment } = require('./brains/sentimentBrain');

const REQUEST_TIMEOUT_MS = 10000;

function createApp({ scanner, engine, log, allowedOrigins }) {
    const app = express();
    app.disable('x-powered-by');
    app.use(cors({
        origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin))
    }));
    app.use(express.json({ limit: '20kb' }));

    app.get('/', (req, res) => res.json({ success: true, status: 'ONLINE', mode: 'paper-only' }));

    app.post('/api/scan', async (req, res) => {
        try {
            res.json(await scanner.scan(req.body));
        } catch (err) {
            const status = err.status || 500;
            if (status >= 500) log('error', err.stack || err.message);
            else log('warn', err.message);
            res.status(status).json({ success: false, error: status >= 500 ? `Scan failed: ${err.message}` : err.message });
        }
    });

    app.get('/api/trades', (req, res) => {
        res.json({ success: true, trades: engine.recent(200), stats: engine.stats() });
    });

    // Malformed JSON / oversized body
    app.use((err, req, res, next) => {
        res.status(err.status || 400).json({ success: false, error: 'Invalid request body.' });
    });
    return app;
}

// Sequential timer (never overlaps itself). Errors are logged and the loop keeps going.
function startSettleLoop({ scanner, engine, intervalSec, log }) {
    if (!intervalSec) { log('info', 'Background settle loop disabled.'); return () => {}; }
    let timer = null;
    let stopped = false;
    const tick = async () => {
        try {
            if (engine.openCount() > 0) {
                const closed = await scanner.settleAll();
                for (const t of closed) log('info', `[PAPER] Closed ${t.symbol} ${t.exitReason} pnl ${t.pnlUSDT} USDT`);
            }
        } catch (err) {
            log('warn', `settle loop: ${err.message}`);
        }
        if (!stopped) { timer = setTimeout(tick, intervalSec * 1000); timer.unref(); }
    };
    timer = setTimeout(tick, 5000);
    timer.unref();
    log('info', `Background settle loop every ${intervalSec}s.`);
    return () => { stopped = true; clearTimeout(timer); };
}

function main() {
    const config = loadConfig();
    const log = createLogger(process.env.LOG_LEVEL);
    const ccxt = require('ccxt');

    const exchanges = new Map();
    function getExchange(name) {
        if (typeof name !== 'string' || !ccxt.exchanges.includes(name)) throw httpError(400, `Unsupported exchange: ${String(name).slice(0, 30)}`);
        if (!exchanges.has(name)) exchanges.set(name, new ccxt[name]({ enableRateLimit: true, timeout: REQUEST_TIMEOUT_MS }));
        return exchanges.get(name);
    }

    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const engine = new PaperEngine({
        file: path.join(dataDir, 'trades.json'),
        startingBalance: config.paper.starting_balance_usdt,
        feePct: config.paper.fee_percent,
        slippagePct: config.paper.slippage_percent,
        log
    });
    engine.load();

    const scanner = createScanner({ config, getExchange, analyzeSentiment, engine, log });
    const allowedOrigins = (process.env.CORS_ORIGIN || 'https://localhost,http://localhost').split(',').map((s) => s.trim());
    const app = createApp({ scanner, engine, log, allowedOrigins });

    const server = app.listen(config.port, config.host, () => {
        log('info', `[MULTI-BRAIN SERVER] http://${config.host}:${config.port} (paper-only)`);
    });

    const stopSettle = startSettleLoop({ scanner, engine, intervalSec: config.scanner.settle_interval_sec, log });

    function shutdown(signal) {
        log('info', `${signal} received, shutting down...`);
        stopSettle();
        engine.save();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => log('error', 'Unhandled rejection:', reason));
}

if (require.main === module) main();

module.exports = { createApp, startSettleLoop };
