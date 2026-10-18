// Volatility & Breakout Brain: ATR compression -> volume-confirmed breakout above resistance.
const { parseRows, prepareCandles, atrSeries, clamp, mean, isNum } = require('../lib/indicators');

const DEFAULTS = {
    timeframe: '15m',
    atrPeriod: 14,
    lookback: 20,            // candles used to define resistance / support / baseline volume
    volumeSpikeRatio: 2,     // signal-candle volume >= 2x lookback average
    maxExtensionAtr: 3,      // close more than 3 ATR above resistance = chasing
    compressionRatio: 0.9,   // ATR before breakout < 90% of its recent average = consolidation
    compressionWindow: 50,
    bookLevels: 5,
    bookImbalanceFull: 1.5   // bid/ask notional ratio that earns the full order-book points
    // now: injectable clock for tests
};

const sig6 = (x) => (isNum(x) ? Number(x.toPrecision(6)) : null);

// Latest ATR (Wilder) from raw ccxt rows, or null if insufficient / malformed.
// Uses the rows as given (including a forming last candle); detectBreakout trims it first.
function calculateATR(ohlcv, period = 14) {
    const parsed = parseRows(ohlcv);
    if (parsed.error || !Number.isInteger(period) || period < 1) return null;
    const last = atrSeries(parsed.candles, period).at(-1);
    return Number.isFinite(last) ? last : null;
}

// bid/ask notional ratio over the top levels, or null if the book is unusable.
function bookImbalance(orderBook, levels) {
    const side = (rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        let sum = 0;
        for (const row of rows.slice(0, levels)) {
            const [price, amount] = row || [];
            if (!isNum(price) || !isNum(amount) || price <= 0 || amount < 0) return null;
            sum += price * amount;
        }
        return sum;
    };
    const bid = side(orderBook?.bids);
    const ask = side(orderBook?.asks);
    return bid === null || ask === null || ask <= 0 ? null : bid / ask;
}

function unavailable(reason) {
    return {
        available: false,
        volatilityScore: 0,
        breakoutDetected: false,
        direction: null,
        details: `Volatility unavailable: ${reason}`
    };
}

// Evaluates the LAST CLOSED candle (a forming candle has partial volume and fake wicks).
function detectBreakout(ohlcv, orderBook = null, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const prep = prepareCandles(ohlcv, {
        timeframe: cfg.timeframe,
        minLength: cfg.atrPeriod + cfg.lookback + 10,
        now: cfg.now
    });
    if (prep.error) return unavailable(prep.error);

    const c = prep.candles;
    const n = c.length;
    const signal = c[n - 1];
    const window = c.slice(n - 1 - cfg.lookback, n - 1);

    const resistance = Math.max(...window.map((x) => x.high));
    const support = Math.min(...window.map((x) => x.low));
    const avgVolume = mean(window.map((x) => x.volume));
    if (!(avgVolume > 0)) return unavailable('baseline volume is zero.');

    const atr = atrSeries(c, cfg.atrPeriod);
    const atrPrev = atr[n - 2]; // ATR before the signal candle, so the breakout bar doesn't inflate it
    if (!(atrPrev > 0)) return unavailable('ATR not computable.');

    const volumeRatio = signal.volume / avgVolume;
    const priceBreakout = signal.close > resistance;
    const breakdown = signal.close < support;
    const volumeSpike = volumeRatio >= cfg.volumeSpikeRatio;
    const extensionAtr = priceBreakout ? (signal.close - resistance) / atrPrev : 0;
    const extended = extensionAtr > cfg.maxExtensionAtr;

    const history = atr.slice(Math.max(0, n - 1 - cfg.compressionWindow), n - 1).filter(Number.isFinite);
    const compressed = history.length >= 10 && atrPrev < cfg.compressionRatio * mean(history);
    const imbalance = bookImbalance(orderBook, cfg.bookLevels);

    const metrics = {
        atr: sig6(atrPrev),
        atrPercent: sig6((atrPrev / signal.close) * 100),
        resistance: sig6(resistance),
        support: sig6(support),
        volumeRatio: sig6(volumeRatio),
        extensionAtr: sig6(extensionAtr),
        compressed,
        extended,
        bookImbalance: sig6(imbalance),
        signalCandleTs: signal.ts
    };

    if (breakdown) {
        return {
            available: true,
            volatilityScore: 0,
            breakoutDetected: false,
            direction: 'DOWN',
            details: `Breakdown: close ${signal.close} below ${cfg.lookback}-candle support ${sig6(support)}. No long setup.`,
            metrics
        };
    }

    let score = 0;
    if (priceBreakout) score += 40;
    if (extended) score -= 15;
    score += clamp((volumeRatio - 1) / (cfg.volumeSpikeRatio - 1), 0, 1) * 30;
    if (compressed) score += 15;
    if (imbalance !== null) score += clamp((imbalance - 1) / (cfg.bookImbalanceFull - 1), 0, 1) * 15;

    const breakoutDetected = priceBreakout && volumeSpike;
    if (!breakoutDetected) score = Math.min(score, 49);
    score = Math.round(clamp(score, 0, 100));

    const notes = [];
    notes.push(priceBreakout
        ? `Close ${signal.close} broke ${cfg.lookback}-candle resistance ${sig6(resistance)}`
        : `No close above resistance ${sig6(resistance)}`);
    notes.push(`volume ${sig6(volumeRatio)}x avg${volumeSpike ? ' (spike)' : ''}`);
    if (compressed) notes.push('ATR was compressed before the move');
    if (imbalance !== null) notes.push(`book bid/ask ${sig6(imbalance)}`);
    else notes.push('order book unavailable (ignored)');
    if (extended) notes.push(`WARNING: ${sig6(extensionAtr)} ATR above resistance, likely extended / chasing`);

    return {
        available: true,
        volatilityScore: score,
        breakoutDetected,
        direction: priceBreakout ? 'UP' : null,
        details: `${notes.join('; ')}.`,
        metrics
    };
}

module.exports = { calculateATR, detectBreakout };
