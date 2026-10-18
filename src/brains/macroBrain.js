// Macro / Market Trend Brain: BTC as the "weather forecaster" for altcoin entries.
const { ema, prepareCandles, clamp, isNum } = require('../lib/indicators');

const DEFAULTS = {
    symbol: 'BTC/USDT',
    trendTimeframe: '4h',
    trendLimit: 260,        // 200 EMA + warmup
    crashTimeframe: '1h',
    crashLimit: 8,
    fastEma: 50,
    slowEma: 200,
    slopeLookback: 6,       // candles (1 day on 4h)
    bullishAt: 65,
    bearishAt: 35,
    crash24hPct: -8,        // flash-crash thresholds (percent change)
    crash4hPct: -6,
    crash1hPct: -4,
    cacheMs: 60 * 1000,
    failCacheMs: 15 * 1000
    // now: injectable clock for tests
};

const cache = new Map();    // key -> { value, until }
const inflight = new Map(); // key -> Promise (dedupes concurrent requests)

function unavailable(reason) {
    return {
        available: false,
        macroScore: 0,
        status: 'UNKNOWN',
        approved: false,
        crash: null,
        reasoning: `Macro unavailable: ${reason}`
    };
}

// Flash-crash check on BTC. (BTC dominance is not exposed by exchange APIs via ccxt;
// it would need an external source such as CoinGecko /global.)
function checkBtcDominanceOrSentiment(ticker, ohlcv1h = null, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const metrics = { change24hPct: null, change1hPct: null, change4hPct: null };

    if (isNum(ticker?.percentage)) metrics.change24hPct = ticker.percentage;

    if (ohlcv1h) {
        const prep = prepareCandles(ohlcv1h, { timeframe: cfg.crashTimeframe, minLength: 4, now: cfg.now });
        if (!prep.error) {
            const c = prep.candles;
            const n = c.length;
            metrics.change1hPct = (c[n - 1].close / c[n - 1].open - 1) * 100;
            metrics.change4hPct = (c[n - 1].close / c[n - 4].open - 1) * 100;
        }
    }

    const checks = [
        ['change24hPct', '24h', cfg.crash24hPct],
        ['change4hPct', '4h', cfg.crash4hPct],
        ['change1hPct', '1h', cfg.crash1hPct]
    ].filter(([key]) => metrics[key] !== null);

    if (checks.length === 0) {
        return { available: false, crash: false, severity: 'UNKNOWN', reasons: [], metrics };
    }

    const hits = [];
    const warns = [];
    for (const [key, label, limit] of checks) {
        const v = metrics[key];
        if (v <= limit) hits.push(`BTC ${label} change ${v.toFixed(1)}% (limit ${limit}%)`);
        else if (v <= limit / 2) warns.push(`BTC ${label} change ${v.toFixed(1)}%`);
    }
    const severity = hits.length ? 'CRASH' : warns.length ? 'WARNING' : 'NONE';
    return { available: true, crash: hits.length > 0, severity, reasons: [...hits, ...warns], metrics };
}

// Pure evaluation on already-fetched data (also usable from a backtest).
function evaluateMacro({ ohlcv4h, ohlcv1h = null, ticker = null } = {}, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };

    const prep = prepareCandles(ohlcv4h, {
        timeframe: cfg.trendTimeframe,
        minLength: cfg.slowEma + 10,
        now: cfg.now
    });
    if (prep.error) return unavailable(`BTC ${cfg.trendTimeframe} data: ${prep.error}`);

    const crash = checkBtcDominanceOrSentiment(ticker, ohlcv1h, cfg);
    if (!crash.available) return unavailable('no usable BTC ticker/1h data for crash check.');

    const closes = prep.candles.map((c) => c.close);
    const n = closes.length;
    const fast = ema(closes, cfg.fastEma);
    const slow = ema(closes, cfg.slowEma);
    const close = closes[n - 1];
    const slopeUp = fast[n - 1] > fast[n - 1 - cfg.slopeLookback];

    let score = 50
        + (close > slow[n - 1] ? 20 : -20)
        + (fast[n - 1] > slow[n - 1] ? 15 : -15)
        + (close > fast[n - 1] ? 10 : -10)
        + (slopeUp ? 5 : -5);

    if (crash.severity === 'CRASH') score = Math.min(score, 20);
    else if (crash.severity === 'WARNING') score -= 15;
    score = Math.round(clamp(score, 0, 100));

    let status = score >= cfg.bullishAt ? 'BULLISH' : score <= cfg.bearishAt ? 'BEARISH' : 'NEUTRAL';
    if (crash.crash) status = 'BEARISH';
    const approved = status !== 'BEARISH' && !crash.crash;

    const parts = [
        `BTC ${cfg.trendTimeframe}: close ${close} vs EMA${cfg.fastEma} ${fast[n - 1].toFixed(2)} / EMA${cfg.slowEma} ${slow[n - 1].toFixed(2)} -> ${status} (${score}).`
    ];
    if (crash.reasons.length) parts.push(`${crash.severity}: ${crash.reasons.join('; ')}.`);
    if (!approved) parts.push('Altcoin BUY signals blocked.');

    return {
        available: true,
        macroScore: score,
        status,
        approved,
        crash: { detected: crash.crash, severity: crash.severity, reasons: crash.reasons, metrics: crash.metrics },
        reasoning: parts.join(' '),
        metrics: {
            btcClose: close,
            ema50: Number(fast[n - 1].toPrecision(8)),
            ema200: Number(slow[n - 1].toPrecision(8)),
            emaSlopeUp: slopeUp
        }
    };
}

// Fetches BTC data and evaluates. Cached (same result for every altcoin request),
// concurrent calls are deduped, failures fail closed (approved: false).
async function analyzeMacroTrend(exchange, opts = {}) {
    if (typeof exchange?.fetchOHLCV !== 'function' || typeof exchange?.fetchTicker !== 'function') {
        throw new TypeError('analyzeMacroTrend: exchange must provide fetchOHLCV and fetchTicker.');
    }
    const cfg = { ...DEFAULTS, ...opts };
    const key = `${exchange.id}|${cfg.symbol}|${cfg.trendTimeframe}`;

    const hit = cache.get(key);
    if (hit && Date.now() < hit.until) return hit.value;
    if (inflight.has(key)) return inflight.get(key);

    const run = (async () => {
        try {
            const [ohlcv4h, ohlcv1h, ticker] = await Promise.all([
                exchange.fetchOHLCV(cfg.symbol, cfg.trendTimeframe, undefined, cfg.trendLimit),
                exchange.fetchOHLCV(cfg.symbol, cfg.crashTimeframe, undefined, cfg.crashLimit),
                exchange.fetchTicker(cfg.symbol)
            ]);
            const value = evaluateMacro({ ohlcv4h, ohlcv1h, ticker }, cfg);
            cache.set(key, { value, until: Date.now() + (value.available ? cfg.cacheMs : cfg.failCacheMs) });
            return value;
        } catch (err) {
            const value = unavailable(`fetch failed: ${err.message}`);
            cache.set(key, { value, until: Date.now() + cfg.failCacheMs });
            return value;
        }
    })();

    inflight.set(key, run);
    run.finally(() => inflight.delete(key));
    return run;
}

module.exports = { analyzeMacroTrend, checkBtcDominanceOrSentiment, evaluateMacro };
