// Shared indicator math + OHLCV validation for the brains.
// Candle rows follow ccxt: [timestamp, open, high, low, close, volume].

const UNIT_MS = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function timeframeToMs(timeframe) {
    const m = /^(\d+)([mhdw])$/.exec(String(timeframe));
    if (!m || Number(m[1]) < 1) throw new Error(`Invalid timeframe: ${timeframe}`);
    return Number(m[1]) * UNIT_MS[m[2]];
}

// Strict parse: ONE bad row rejects the whole series (never trade on malformed input).
function parseRows(ohlcv) {
    if (!Array.isArray(ohlcv) || ohlcv.length === 0) return { error: 'No candle data.' };
    const candles = [];
    let prevTs = -Infinity;
    for (const row of ohlcv) {
        if (!Array.isArray(row) || row.length < 6) return { error: 'Malformed candle row.' };
        const [ts, open, high, low, close, volume] = row;
        if (![ts, open, high, low, close, volume].every(isNum)) return { error: 'Non-numeric candle value.' };
        if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low || volume < 0) {
            return { error: 'Invalid candle values.' };
        }
        if (ts <= prevTs) return { error: 'Candles not in ascending time order.' };
        prevTs = ts;
        candles.push({ ts, open, high, low, close, volume });
    }
    return { candles };
}

// parseRows + drop the still-forming candle + staleness + minimum length.
// `now` is injectable for tests.
function prepareCandles(ohlcv, { timeframe, minLength = 1, now = Date.now(), maxLagCandles = 2 } = {}) {
    const tfMs = timeframeToMs(timeframe);
    const parsed = parseRows(ohlcv);
    if (parsed.error) return parsed;

    let candles = parsed.candles;
    if (candles[candles.length - 1].ts + tfMs > now) candles = candles.slice(0, -1);
    if (candles.length === 0) return { error: 'No closed candles.' };

    const lagMs = now - (candles[candles.length - 1].ts + tfMs);
    if (lagMs > maxLagCandles * tfMs) {
        return { error: `Stale candle data (${Math.round(lagMs / 60000)} min behind).` };
    }
    if (candles.length < minLength) {
        return { error: `Need at least ${minLength} closed candles, got ${candles.length}.` };
    }
    return { candles };
}

// EMA seeded with the SMA of the first `period` values. Entries before the seed are NaN.
function ema(values, period) {
    const out = new Array(values.length).fill(NaN);
    if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
    const k = 2 / (period + 1);
    let prev = mean(values.slice(0, period));
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}

// Wilder ATR. Entries before index period-1 are NaN.
function atrSeries(candles, period = 14) {
    const out = new Array(candles.length).fill(NaN);
    if (!Number.isInteger(period) || period < 1 || candles.length < period) return out;
    const tr = candles.map((c, i) => {
        if (i === 0) return c.high - c.low;
        const pc = candles[i - 1].close;
        return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    });
    let prev = mean(tr.slice(0, period));
    out[period - 1] = prev;
    for (let i = period; i < tr.length; i++) {
        prev = (prev * (period - 1) + tr[i]) / period;
        out[i] = prev;
    }
    return out;
}

module.exports = { isNum, clamp, mean, timeframeToMs, parseRows, prepareCandles, ema, atrSeries };
