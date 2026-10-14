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

function evaluateRisk(techSignal, riskParams) {
    if (!techSignal || techSignal.action !== 'BUY') {
        return { approved: false, reasoning: 'No valid BUY signal from Technical Brain.' };
    }
    const { value, error } = normalizeRiskParams(riskParams);
    if (error) {
        return { approved: false, reasoning: `REJECTED: ${error}` };
    }
    return {
        approved: true,
        reasoning: `APPROVED: Risk parameters checked. Stop-loss at ${value.stop_loss_percent}%.`
    };
}

module.exports = { evaluateRisk, normalizeRiskParams, LIMITS };
