// Multi-Timeframe Confluence Brain: does the entry timeframe agree with the higher trend timeframe?
const { ema, prepareCandles, clamp, timeframeToMs } = require('../lib/indicators');

const DEFAULTS = {
    entryTimeframe: '15m',
    trendTimeframe: '1h',   // '4h' also works
    entryLimit: 120,
    trendLimit: 120,
    entryEma: { fast: 9, slow: 21 },
    trendEma: { fast: 20, slow: 50 },
    bullishAt: 65,
    bearishAt: 35,
    allowMixed: false,      // true: entry BULLISH + trend NEUTRAL also approved
    mode: 'trend'           // 'dip': approve a pullback (entry not BEARISH) inside a BULLISH higher-timeframe trend
    // now: injectable clock for tests
};

const BIASES = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);

function unavailable(reason) {
    return {
        available: false,
        confluenceScore: 0,
        alignment: 'UNKNOWN',
        approved: false,
        direction: null,
        reasoning: `Multi-timeframe unavailable: ${reason}`
    };
}

// Directional bias of one timeframe from EMA structure. score: 0 (bearish) .. 100 (bullish).
function analyzeTimeframe(candles, { fast, slow }, cfg = DEFAULTS) {
    const closes = candles.map((c) => c.close);
    const n = closes.length;
    const f = ema(closes, fast);
    const s = ema(closes, slow);
    const close = closes[n - 1];

    const score = 50
        + (close > s[n - 1] ? 15 : -15)
        + (f[n - 1] > s[n - 1] ? 15 : -15)
        + (f[n - 1] > f[n - 4] ? 10 : -10)
        + (close > f[n - 1] ? 10 : -10);

    const bias = score >= cfg.bullishAt ? 'BULLISH' : score <= cfg.bearishAt ? 'BEARISH' : 'NEUTRAL';
    return {
        bias,
        score: clamp(score, 0, 100),
        close,
        fastEma: Number(f[n - 1].toPrecision(8)),
        slowEma: Number(s[n - 1].toPrecision(8))
    };
}

// tech15m / tech1h: { bias, score } (names kept from the spec; they are the entry / trend timeframes).
function checkConfluence(tech15m, tech1h, opts = {}) {
    for (const t of [tech15m, tech1h]) {
        if (!t || !BIASES.has(t.bias) || !Number.isFinite(t.score)) {
            throw new TypeError('checkConfluence: expected { bias, score } for both timeframes.');
        }
    }
    const e = tech15m.bias;
    const t = tech1h.bias;
    const avg = (tech15m.score + tech1h.score) / 2;

    if (opts.mode === 'dip') {
        // A dip is by definition a weak entry timeframe: what matters is that the higher trend is intact.
        const approvedDip = t === 'BULLISH' && e !== 'BEARISH';
        const alignmentDip = approvedDip ? (e === 'BULLISH' ? 'STRONG_ALIGNMENT' : 'PULLBACK_UPTREND')
            : (t === 'BEARISH' || e === 'BEARISH' ? 'CONFLICT' : 'MIXED');
        const scoreDip = approvedDip ? 0.4 * tech15m.score + 0.6 * tech1h.score
            : Math.min(avg, alignmentDip === 'CONFLICT' ? 30 : 59);
        return {
            confluenceScore: Math.round(clamp(scoreDip, 0, 100)),
            alignment: alignmentDip,
            approved: approvedDip,
            direction: approvedDip ? 'BULLISH' : null,
            reasoning: `Dip mode: entry ${e}, trend ${t} -> ${alignmentDip}. ${approvedDip ? 'Pullback inside an intact uptrend.' : 'Higher trend not bullish: dip not confirmed.'}`
        };
    }

    let alignment;
    let direction = null;
    let score;
    if (e === t && e !== 'NEUTRAL') {
        alignment = 'STRONG_ALIGNMENT';
        direction = e;
        score = avg;
    } else if ((e === 'BULLISH' && t === 'BEARISH') || (e === 'BEARISH' && t === 'BULLISH')) {
        alignment = 'CONFLICT';
        score = Math.min(avg, 30);
    } else {
        alignment = 'MIXED';
        score = Math.min(avg, 59);
    }

    const approved = (alignment === 'STRONG_ALIGNMENT' && direction === 'BULLISH')
        || (!!opts.allowMixed && alignment === 'MIXED' && e === 'BULLISH' && t === 'NEUTRAL');

    let reasoning = `Entry ${e}, trend ${t} -> ${alignment}`;
    if (direction === 'BEARISH') reasoning += ' (bearish agreement, long entries blocked)';
    reasoning += approved ? '.' : '. BUY not confirmed.';

    return { confluenceScore: Math.round(clamp(score, 0, 100)), alignment, approved, direction, reasoning };
}

// Pure evaluation on already-fetched candles (reusable by the server / backtest).
function evaluateMultiTimeframe(entryOhlcv, trendOhlcv, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    if (timeframeToMs(cfg.trendTimeframe) <= timeframeToMs(cfg.entryTimeframe)) {
        throw new Error('trendTimeframe must be higher than entryTimeframe.');
    }

    const entryPrep = prepareCandles(entryOhlcv, {
        timeframe: cfg.entryTimeframe,
        minLength: cfg.entryEma.slow + 10,
        now: cfg.now
    });
    if (entryPrep.error) return unavailable(`${cfg.entryTimeframe} data: ${entryPrep.error}`);

    const trendPrep = prepareCandles(trendOhlcv, {
        timeframe: cfg.trendTimeframe,
        minLength: cfg.trendEma.slow + 10,
        now: cfg.now
    });
    if (trendPrep.error) return unavailable(`${cfg.trendTimeframe} data: ${trendPrep.error}`);

    const entry = analyzeTimeframe(entryPrep.candles, cfg.entryEma, cfg);
    const trend = analyzeTimeframe(trendPrep.candles, cfg.trendEma, cfg);
    const result = checkConfluence(entry, trend, cfg);

    return {
        available: true,
        ...result,
        entry: { timeframe: cfg.entryTimeframe, ...entry },
        trend: { timeframe: cfg.trendTimeframe, ...trend }
    };
}

async function analyzeMultiTimeframe(exchange, symbol, opts = {}) {
    if (typeof exchange?.fetchOHLCV !== 'function') {
        throw new TypeError('analyzeMultiTimeframe: exchange must provide fetchOHLCV.');
    }
    if (typeof symbol !== 'string' || !symbol) throw new TypeError('analyzeMultiTimeframe: symbol required.');
    const cfg = { ...DEFAULTS, ...opts };
    // Validate config before any network call (throws on a bad timeframe pair).
    if (timeframeToMs(cfg.trendTimeframe) <= timeframeToMs(cfg.entryTimeframe)) {
        throw new Error('trendTimeframe must be higher than entryTimeframe.');
    }

    try {
        const [entryOhlcv, trendOhlcv] = await Promise.all([
            exchange.fetchOHLCV(symbol, cfg.entryTimeframe, undefined, cfg.entryLimit),
            exchange.fetchOHLCV(symbol, cfg.trendTimeframe, undefined, cfg.trendLimit)
        ]);
        return evaluateMultiTimeframe(entryOhlcv, trendOhlcv, cfg);
    } catch (err) {
        return unavailable(`fetch failed: ${err.message}`);
    }
}

module.exports = { analyzeMultiTimeframe, checkConfluence, evaluateMultiTimeframe };
