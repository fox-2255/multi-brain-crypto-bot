// Technical Brain: EMA trend structure + RSI momentum filter on the entry timeframe (15m).
const { prepareCandles, ema, rsi, atrSeries, clamp, mean, isNum, timeframeToMs } = require('../lib/indicators');

const DEFAULTS = {
    timeframe: '15m',
    emaFast: 9,
    emaSlow: 21,
    emaTrend: 50,
    rsiPeriod: 14,
    rsiMin: 50,          // below this = no momentum
    rsiMax: 72,          // above this = overbought / chasing
    atrPeriod: 14,
    maxExtAtr: 2.5,      // max distance above EMA(slow), in ATR
    volLookback: 20,
    volWindow: 3,        // candles averaged for the volume gate (one candle is too noisy)
    minVolRatio: 0,      // 0 = gate off; else avg volume of last volWindow candles / prior baseline must reach this
    buyScore: 60
    // now: injectable clock for tests
};

const round = (x, dp) => (isNum(x) ? Number(x.toFixed(dp)) : null);

function hold(reason, score = 0, signal = null) {
    return { action: 'HOLD', score, reasoning: `HOLD: ${reason}`, signal };
}

// ohlcv: ccxt rows (newest may still be forming; it is dropped). ticker: optional, only used for 24h change.
function analyzeTechnical(ohlcv, ticker = null, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const prep = prepareCandles(ohlcv, {
        timeframe: cfg.timeframe,
        minLength: cfg.emaTrend + 10,
        now: cfg.now
    });
    if (prep.error) return hold(prep.error);

    const c = prep.candles;
    const n = c.length;
    const closes = c.map((x) => x.close);
    const close = closes[n - 1];

    const fast = ema(closes, cfg.emaFast)[n - 1];
    const slow = ema(closes, cfg.emaSlow)[n - 1];
    const trend = ema(closes, cfg.emaTrend)[n - 1];
    const rsiNow = rsi(closes, cfg.rsiPeriod);
    const atr = atrSeries(c, cfg.atrPeriod)[n - 1];
    if (![fast, slow, trend, rsiNow, atr].every(Number.isFinite) || atr <= 0) {
        return hold('indicators not computable.');
    }

    const perHour = Math.max(1, Math.round(3600000 / timeframeToMs(cfg.timeframe)));
    const roc1h = (close / c[n - 1 - perHour].close - 1) * 100;

    const baseVol = mean(c.slice(n - 1 - cfg.volLookback, n - 1).map((x) => x.volume));
    const volRatio = baseVol > 0 ? c[n - 1].volume / baseVol : 0;
    const extAtr = (close - slow) / atr;
    const win = cfg.volWindow;
    const recentVol = mean(c.slice(n - win, n).map((x) => x.volume));
    const winBase = mean(c.slice(n - win - cfg.volLookback, n - win).map((x) => x.volume));
    const volRatioAvg = winBase > 0 ? recentVol / winBase : 0;

    let score = 0;
    if (fast > slow) score += 15;
    if (slow > trend) score += 15;
    if (close > slow) score += 10;
    if (rsiNow >= 50 && rsiNow <= 65) score += 25;
    else if ((rsiNow > 65 && rsiNow <= 72) || (rsiNow >= 45 && rsiNow < 50)) score += 15;
    score += clamp(roc1h / 1, 0, 1) * 10;
    score += clamp((volRatio - 0.8) / 0.7, 0, 1) * 15;
    if (extAtr <= 1.5) score += 10;
    else if (extAtr <= cfg.maxExtAtr) score += 5;
    else score -= 10;
    score = Math.round(clamp(score, 0, 100));

    const signal = {
        roc1hPct: round(roc1h, 2),
        rsi: round(rsiNow, 1),
        volRatio: round(volRatio, 2),
        volRatioAvg: round(volRatioAvg, 2),
        extAtr: round(extAtr, 2),
        chg24hPct: isNum(ticker?.percentage) ? round(ticker.percentage, 2) : null
    };

    const fails = [];
    if (!(fast > slow)) fails.push(`EMA${cfg.emaFast} below EMA${cfg.emaSlow}`);
    if (!(close > slow)) fails.push(`price below EMA${cfg.emaSlow}`);
    if (rsiNow < cfg.rsiMin) fails.push(`RSI ${signal.rsi} weak`);
    if (rsiNow > cfg.rsiMax) fails.push(`RSI ${signal.rsi} overbought`);
    if (!(roc1h > 0)) fails.push('no 1h momentum');
    if (extAtr > cfg.maxExtAtr) fails.push(`${signal.extAtr} ATR above EMA${cfg.emaSlow}, extended`);
    if (cfg.minVolRatio > 0 && !(volRatioAvg >= cfg.minVolRatio)) fails.push(`volume weak (x${signal.volRatioAvg} avg of last ${win} candles, need x${cfg.minVolRatio})`);
    if (score < cfg.buyScore) fails.push(`score ${score} below ${cfg.buyScore}`);

    if (fails.length) return hold(fails.join('; '), score, signal);

    const stack = `EMA${cfg.emaFast}>EMA${cfg.emaSlow}${slow > trend ? `>EMA${cfg.emaTrend}` : ''}`;
    return {
        action: 'BUY',
        score,
        reasoning: `Uptrend: ${stack}, RSI ${signal.rsi}, ROC1h ${signal.roc1hPct >= 0 ? '+' : ''}${signal.roc1hPct}%, vol x${signal.volRatio}, ${signal.extAtr} ATR above EMA${cfg.emaSlow}.`,
        signal
    };
}

module.exports = { analyzeTechnical };
