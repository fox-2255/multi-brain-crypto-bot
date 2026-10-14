const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const defaultConfig = require('./config/defaultConfig.json');

const { analyzeTechnical } = require('./brains/technicalBrain');
const { evaluateRisk, normalizeRiskParams } = require('./brains/riskBrain');
const { analyzeSentiment } = require('./brains/sentimentBrain');
const { evaluateLiquidity } = require('./brains/liquidityBrain');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PAPER_BALANCE_USDT = Number(process.env.PAPER_BALANCE_USDT) || 1000;
const REQUEST_TIMEOUT_MS = 10000;
const SYMBOL_RE = /^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/;

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
function log(level, ...args) {
    if (LEVELS[level] <= LOG_LEVEL) {
        const fn = level === 'debug' ? 'log' : level;
        console[fn](`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
    }
}

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

const allowedOrigins = (process.env.CORS_ORIGIN || 'https://localhost,http://localhost')
    .split(',').map((s) => s.trim());

const app = express();
app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin))
}));
app.use(express.json({ limit: '10kb' }));

const exchanges = new Map();
function getExchange(name) {
    if (typeof name !== 'string' || !ccxt.exchanges.includes(name)) {
        throw httpError(400, `Unsupported exchange: ${name}`);
    }
    if (!exchanges.has(name)) {
        exchanges.set(name, new ccxt[name]({ enableRateLimit: true, timeout: REQUEST_TIMEOUT_MS }));
    }
    return exchanges.get(name);
}

function buildPlan(entry, rp) {
    const sl = rp.stop_loss_percent / 100;
    const riskAmount = PAPER_BALANCE_USDT * (rp.max_risk_per_trade_percent / 100);
    const sizeUSDT = Math.min(PAPER_BALANCE_USDT, riskAmount / sl);
    return {
        simulated: true,
        entry,
        stopLoss: entry * (1 - sl),
        takeProfit: entry * (1 + rp.take_profit_percent / 100),
        positionSizeUSDT: Number(sizeUSDT.toFixed(2))
    };
}

app.post('/api/run-analysis', async (req, res) => {
    try {
        const body = req.body || {};
        const exchangeName = body.exchangeName ?? defaultConfig.selected_exchange;
        const symbol = String(body.symbol ?? defaultConfig.trading_symbol).trim().toUpperCase();
        const paperTrading = body.paperTrading !== false;

        if (!SYMBOL_RE.test(symbol)) throw httpError(400, 'Invalid symbol (expected e.g. SOL/USDT).');
        if (!paperTrading) throw httpError(403, 'Live trading is not implemented. Paper mode only.');

        const { value: riskParams, error: riskError } = normalizeRiskParams({
            ...defaultConfig.risk_parameters,
            ...(body.riskParams || {})
        });
        if (riskError) throw httpError(400, riskError);

        const exchange = getExchange(exchangeName);
        const [ticker, ohlcv, orderBook, sentiment] = await Promise.all([
            exchange.fetchTicker(symbol),
            exchange.fetchOHLCV(symbol, '15m', undefined, 20),
            exchange.fetchOrderBook(symbol, 5),
            analyzeSentiment()
        ]);

        if (!Number.isFinite(ticker?.last)) throw httpError(502, 'Invalid ticker data from exchange.');

        const tech = analyzeTechnical(ohlcv, ticker);
        const risk = evaluateRisk(tech, riskParams);
        const liquidity = evaluateLiquidity(orderBook);

        const overall = sentiment.available ? Math.round((tech.score + sentiment.score) / 2) : null;
        const blockedBy = [];
        if (overall === null) blockedBy.push('sentiment_unavailable');
        else if (overall < defaultConfig.brain_settings.min_confidence_score) blockedBy.push('low_confidence');
        if (!risk.approved) blockedBy.push('risk');
        if (liquidity.status !== 'GOOD') blockedBy.push('liquidity');

        const finalDecision = blockedBy.length === 0 ? 'BUY' : 'HOLD';
        log('info', `${exchangeName} ${symbol} -> ${finalDecision} (${overall ?? 'n/a'}) blockedBy=[${blockedBy}]`);

        res.json({
            success: true,
            status: 'ACTIVE',
            symbol,
            exchange: exchangeName,
            paperTrading,
            coordinator: {
                finalDecision,
                overallConfidence: overall ?? 0,
                blockedBy,
                plan: finalDecision === 'BUY' ? buildPlan(ticker.last, riskParams) : null
            },
            brains: { technical: tech, risk, sentiment, liquidity }
        });
    } catch (error) {
        const status = error.status || 500;
        if (status >= 500) log('error', error.stack || error.message);
        else log('warn', error.message);
        res.status(status).json({ success: false, error: error.message });
    }
});

// Malformed JSON / oversized body
app.use((err, req, res, next) => {
    res.status(err.status || 400).json({ success: false, error: 'Invalid request body.' });
});

const server = app.listen(PORT, HOST, () => {
    log('info', `[MULTI-BRAIN SERVER] http://${HOST}:${PORT} (paper-only)`);
});

function shutdown(signal) {
    log('info', `${signal} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log('error', 'Unhandled rejection:', reason));
