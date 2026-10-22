const LIMITS = { maxRiskPct: 5, maxStopLossPct: 10 };

function toNum(v) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return NaN;
    return Number(v);
}

function normalizeRiskParams(raw = {}) {
    const risk = toNum(raw.max_risk_per_trade_percent);
    const sl = toNum(raw.stop_loss_percent);
    const tp = toNum(raw.take_profit_percent);

    if (![risk, sl, tp].every(Number.isFinite)) {
        return { error: 'Risk parameters must be valid numbers.' };
    }
    if (risk <= 0 || risk > LIMITS.maxRiskPct) {
        return { error: `Max risk per trade must be > 0 and <= ${LIMITS.maxRiskPct}%.` };
    }
    if (sl <= 0 || sl > LIMITS.maxStopLossPct) {
        return { error: `Stop-loss must be > 0 and <= ${LIMITS.maxStopLossPct}%.` };
    }
    if (tp <= sl) {
        return { error: 'Take-profit must be greater than stop-loss.' };
    }
    return {
        value: {
            max_risk_per_trade_percent: risk,
            stop_loss_percent: sl,
            take_profit_percent: tp
        }
    };
}

// Dip entries use a structural stop just under the recent swing low instead of the fixed %, with the
// target at rr x the risk. Returns { stopPrice, rr, slPct } or { error } (stop too tight = noise,
// too far = the dip is not "near the bottom").
function dipLevels(price, swingLow, tc) {
    if (![price, swingLow].every(Number.isFinite) || price <= 0 || swingLow <= 0) return { error: 'No swing low available.' };
    const stopPrice = swingLow * 0.999;
    const slPct = ((price - stopPrice) / price) * 100;
    if (!(slPct >= tc.dip_min_risk_pct && slPct <= tc.dip_max_risk_pct)) {
        return { error: `Swing-low stop is ${slPct.toFixed(2)}% away; allowed ${tc.dip_min_risk_pct}-${tc.dip_max_risk_pct}%.` };
    }
    return { stopPrice, rr: tc.dip_rr, slPct };
}

function evaluateRisk(techSignal, riskParams, ctx = {}) {
    if (!techSignal || techSignal.action !== 'BUY') {
        return { approved: false, reasoning: 'No valid BUY signal from Technical Brain.' };
    }
    const { value, error } = normalizeRiskParams(riskParams);
    if (error) {
        return { approved: false, reasoning: `REJECTED: ${error}` };
    }
    if (techSignal.setup === 'dip' && ctx.tc) {
        const lv = dipLevels(ctx.price, techSignal.signal?.swingLow, ctx.tc);
        if (lv.error) return { approved: false, reasoning: `REJECTED: ${lv.error}` };
        return {
            approved: true,
            reasoning: `APPROVED: dip entry, stop under swing low (${lv.slPct.toFixed(2)}% away), target ${lv.rr}R.`
        };
    }
    return {
        approved: true,
        reasoning: `APPROVED: Risk parameters checked. Stop-loss at ${value.stop_loss_percent}%.`
    };
}

module.exports = { evaluateRisk, normalizeRiskParams, dipLevels, LIMITS };
