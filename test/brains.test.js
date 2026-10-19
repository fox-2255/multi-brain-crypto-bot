const assert = require('node:assert/strict');
const R = require('node:path').join(__dirname, '..', 'src');
const { ema, atrSeries, prepareCandles } = require(`${R}/lib/indicators`);
const { analyzeMacroTrend, checkBtcDominanceOrSentiment, evaluateMacro } = require(`${R}/brains/macroBrain`);
const { analyzeMultiTimeframe, checkConfluence, evaluateMultiTimeframe } = require(`${R}/brains/multiTimeframeBrain`);
const { calculateATR, detectBreakout } = require(`${R}/brains/volatilityBrain`);

const MIN = 60000;
const TF = { '15m': 15 * MIN, '1h': 60 * MIN, '4h': 240 * MIN };
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % TF['4h']) + 5000; // aligned + 5s, so last candle below is closed

// rows ending with a CLOSED candle; pathFn(i) -> close
function gen(tf, n, pathFn, { vol = () => 100, range = 0.004 } = {}) {
    const ms = TF[tf];
    const lastTs = NOW - (NOW % ms) - ms; // last closed candle start
    const rows = [];
    for (let i = 0; i < n; i++) {
        const close = pathFn(i);
        const open = i === 0 ? close : pathFn(i - 1);
        const hi = Math.max(open, close) * (1 + range);
        const lo = Math.min(open, close) * (1 - range);
        rows.push([lastTs - (n - 1 - i) * ms, open, hi, lo, close, vol(i)]);
    }
    return rows;
}
const up = (i) => 100 * Math.pow(1.004, i);
const down = (i) => 300 * Math.pow(0.996, i);
const flat = (i) => 100 + Math.sin(i / 4) * 0.5;

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  ', name); };

(async () => {
    await t('ema/atr math', () => {
        const e = ema([5, 5, 5, 5, 5], 3);
        assert.ok(Number.isNaN(e[1]) && e[2] === 5 && e[4] === 5);
        const candles = Array.from({ length: 20 }, (_, i) => ({ ts: i, open: 10, high: 11, low: 9, close: 10, volume: 1 }));
        assert.equal(atrSeries(candles, 14).at(-1), 2);
        assert.equal(calculateATR(candles.map((c) => [c.ts + 1, c.open, c.high, c.low, c.close, c.volume]), 14), 2);
        assert.equal(calculateATR([[1, 1, 2, 1, 1, 1]], 14), null);
        assert.equal(calculateATR('junk'), null);
    });

    await t('prepareCandles: drops forming candle, rejects stale/malformed', () => {
        const rows = gen('15m', 60, up);
        const forming = [...rows, [rows.at(-1)[0] + TF['15m'], 1, 2, 1, 1.5, 1]];
        const a = prepareCandles(forming, { timeframe: '15m', now: NOW });
        assert.equal(a.candles.length, 60);
        assert.match(prepareCandles(rows, { timeframe: '15m', now: NOW + 10 * TF['15m'] }).error, /Stale/);
        const bad = rows.map((r) => r.slice()); bad[10][4] = NaN;
        assert.match(prepareCandles(bad, { timeframe: '15m', now: NOW }).error, /Non-numeric/);
        const nullVol = rows.map((r) => r.slice()); nullVol[3][5] = null;
        assert.ok(prepareCandles(nullVol, { timeframe: '15m', now: NOW }).error);
        assert.match(prepareCandles(rows.slice(-5), { timeframe: '15m', minLength: 30, now: NOW }).error, /at least/);
    });

    await t('macro: uptrend BULLISH approved', () => {
        const r = evaluateMacro({ ohlcv4h: gen('4h', 260, up), ohlcv1h: gen('1h', 8, up), ticker: { percentage: 1.2 } }, { now: NOW });
        assert.equal(r.status, 'BULLISH'); assert.equal(r.approved, true); assert.ok(r.macroScore >= 65);
    });
    await t('macro: downtrend BEARISH blocked', () => {
        const r = evaluateMacro({ ohlcv4h: gen('4h', 260, down), ohlcv1h: gen('1h', 8, down), ticker: { percentage: -1 } }, { now: NOW });
        assert.equal(r.status, 'BEARISH'); assert.equal(r.approved, false);
    });
    await t('macro: flash crash blocks even in uptrend', () => {
        const r = evaluateMacro({ ohlcv4h: gen('4h', 260, up), ohlcv1h: gen('1h', 8, up), ticker: { percentage: -9.5 } }, { now: NOW });
        assert.equal(r.approved, false); assert.equal(r.crash.severity, 'CRASH'); assert.ok(r.macroScore <= 20);
    });
    await t('macro: 1h candle crash detected from candles', () => {
        const h = gen('1h', 8, (i) => (i < 7 ? 100 : 94)); // -6% last candle
        const c = checkBtcDominanceOrSentiment({ percentage: -1 }, h, { now: NOW });
        assert.equal(c.crash, true);
    });
    await t('macro: ticker without percentage + no candles -> unavailable (fail closed)', () => {
        const r = evaluateMacro({ ohlcv4h: gen('4h', 260, up), ohlcv1h: null, ticker: {} }, { now: NOW });
        assert.equal(r.available, false); assert.equal(r.approved, false);
    });
    await t('macro: stale/short/malformed -> unavailable', () => {
        assert.equal(evaluateMacro({ ohlcv4h: gen('4h', 260, up), ticker: { percentage: 1 } }, { now: NOW + 5 * TF['4h'] }).available, false);
        assert.equal(evaluateMacro({ ohlcv4h: gen('4h', 100, up), ticker: { percentage: 1 } }, { now: NOW }).available, false);
        assert.equal(evaluateMacro({ ohlcv4h: undefined, ticker: { percentage: 1 } }, { now: NOW }).approved, false);
    });
    await t('macro: analyzeMacroTrend dedupes + caches + fails closed', async () => {
        let calls = 0;
        const ex = { id: 'mock1', fetchTicker: async () => { calls++; return { percentage: 0.5 }; },
            fetchOHLCV: async (s, tf) => { calls++; await new Promise((r) => setTimeout(r, 20)); return tf === '4h' ? gen('4h', 260, up) : gen('1h', 8, up); } };
        const [a, b, c] = await Promise.all([1, 2, 3].map(() => analyzeMacroTrend(ex, { now: NOW })));
        assert.equal(calls, 3); assert.equal(a, b); assert.equal(b, c); assert.equal(a.approved, true);
        await analyzeMacroTrend(ex, { now: NOW }); assert.equal(calls, 3); // cached
        const bad = { id: 'mock2', fetchTicker: async () => { throw new Error('boom'); }, fetchOHLCV: async () => [] };
        const f = await analyzeMacroTrend(bad, { now: NOW });
        assert.equal(f.available, false); assert.equal(f.approved, false);
        const sync = { id: 'mock3', fetchTicker: () => { throw new Error('sync boom'); }, fetchOHLCV: () => { throw new Error('sync boom'); } };
        assert.equal((await analyzeMacroTrend(sync, { now: NOW })).available, false);
        assert.equal((await analyzeMacroTrend(sync, { now: NOW })).available, false); // no poisoned inflight
        await assert.rejects(() => analyzeMacroTrend({}), TypeError);
    });

    await t('mtf: both up -> STRONG_ALIGNMENT approved', () => {
        const r = evaluateMultiTimeframe(gen('15m', 120, up), gen('1h', 120, up), { now: NOW });
        assert.equal(r.alignment, 'STRONG_ALIGNMENT'); assert.equal(r.approved, true); assert.ok(r.confluenceScore >= 65);
    });
    await t('mtf: entry up / trend down -> CONFLICT blocked', () => {
        const r = evaluateMultiTimeframe(gen('15m', 120, up), gen('1h', 120, down), { now: NOW });
        assert.equal(r.alignment, 'CONFLICT'); assert.equal(r.approved, false); assert.ok(r.confluenceScore <= 30);
    });
    await t('mtf: both down -> aligned but bearish, not approved', () => {
        const r = evaluateMultiTimeframe(gen('15m', 120, down), gen('1h', 120, down), { now: NOW });
        assert.equal(r.alignment, 'STRONG_ALIGNMENT'); assert.equal(r.direction, 'BEARISH'); assert.equal(r.approved, false);
    });
    await t('mtf: checkConfluence MIXED + allowMixed', () => {
        const strict = checkConfluence({ bias: 'BULLISH', score: 80 }, { bias: 'NEUTRAL', score: 50 });
        assert.equal(strict.alignment, 'MIXED'); assert.equal(strict.approved, false); assert.ok(strict.confluenceScore <= 59);
        assert.equal(checkConfluence({ bias: 'BULLISH', score: 80 }, { bias: 'NEUTRAL', score: 50 }, { allowMixed: true }).approved, true);
        assert.equal(checkConfluence({ bias: 'NEUTRAL', score: 50 }, { bias: 'BULLISH', score: 80 }, { allowMixed: true }).approved, false);
        assert.throws(() => checkConfluence({ bias: 'UP', score: 1 }, { bias: 'BULLISH', score: 1 }), TypeError);
    });
    await t('mtf: bad data / bad config / fetch failure', async () => {
        assert.equal(evaluateMultiTimeframe(gen('15m', 120, up), gen('1h', 20, up), { now: NOW }).available, false);
        assert.throws(() => evaluateMultiTimeframe([], [], { entryTimeframe: '1h', trendTimeframe: '15m' }), /higher/);
        const ex = { fetchOHLCV: async () => { throw new Error('net'); } };
        const r = await analyzeMultiTimeframe(ex, 'SOL/USDT'); assert.equal(r.available, false); assert.equal(r.approved, false);
        await assert.rejects(() => analyzeMultiTimeframe(ex, ''), TypeError);
        let seen = [];
        const ok = { fetchOHLCV: async (s, tf, since, lim) => { seen.push([s, tf, lim]); return tf === '15m' ? gen('15m', 120, up) : gen('1h', 120, up); } };
        const r2 = await analyzeMultiTimeframe(ok, 'SOL/USDT', { now: NOW });
        assert.equal(r2.approved, true); assert.equal(seen.length, 2);
    });

    // volatility: tight consolidation then a breakout bar
    // volatile first (wide swings), then a tight range: ATR compresses before the breakout bar
    const consolidation = (i) => (i < 45 ? 100 + (i % 2 ? 2 : -2) : 100 + (i % 2 ? 0.1 : -0.1));
    const mk = (lastClose, lastVol, n = 80) => {
        const rows = gen('15m', n, (i) => (i === n - 1 ? lastClose : consolidation(i)), { range: 0.001, vol: (i) => (i === n - 1 ? lastVol : 100) });
        return rows;
    };
    const book = { bids: [[100, 50], [99.9, 50], [99.8, 50]], asks: [[100.1, 20], [100.2, 20], [100.3, 20]] };

    await t('vol: volume-confirmed breakout', () => {
        const r = detectBreakout(mk(101, 400), book, { now: NOW });
        assert.equal(r.breakoutDetected, true); assert.equal(r.direction, 'UP'); assert.ok(r.volatilityScore >= 70, String(r.volatilityScore));
        assert.equal(r.metrics.compressed, true);
    });
    await t('vol: price breakout without volume is not a breakout (score <= 49)', () => {
        const r = detectBreakout(mk(101, 100), book, { now: NOW });
        assert.equal(r.breakoutDetected, false); assert.ok(r.volatilityScore <= 49);
    });
    await t('vol: breakdown -> 0', () => {
        const r = detectBreakout(mk(98, 500), book, { now: NOW });
        assert.equal(r.volatilityScore, 0); assert.equal(r.direction, 'DOWN'); assert.equal(r.breakoutDetected, false);
    });
    await t('vol: extended breakout flagged and scored lower', () => {
        const normal = detectBreakout(mk(100.6, 400), book, { now: NOW });
        const ext = detectBreakout(mk(130, 400), book, { now: NOW });
        assert.equal(ext.metrics.extended, true); assert.ok(ext.volatilityScore < normal.volatilityScore + 1 || ext.volatilityScore < 90);
        console.log('     normal', normal.volatilityScore, 'ext', ext.volatilityScore, '|', ext.details);
    });
    await t('vol: no/bad order book is ignored, not fatal', () => {
        const a = detectBreakout(mk(101, 400), null, { now: NOW });
        const b = detectBreakout(mk(101, 400), { bids: [['x', 1]], asks: [] }, { now: NOW });
        assert.equal(a.breakoutDetected, true); assert.equal(b.breakoutDetected, true);
        assert.equal(a.metrics.bookImbalance, null);
    });
    await t('vol: too few / stale / malformed / zero-volume baseline -> unavailable', () => {
        assert.equal(detectBreakout(mk(101, 400, 30), book, { now: NOW }).available, false);
        assert.equal(detectBreakout(mk(101, 400), book, { now: NOW + 9 * TF['15m'] }).available, false);
        assert.equal(detectBreakout(null, book, { now: NOW }).available, false);
        const zero = gen('15m', 80, consolidation, { vol: () => 0 });
        assert.equal(detectBreakout(zero, book, { now: NOW }).available, false);
    });

    console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
