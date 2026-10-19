// Chief Coordinator: combines the brains into one decision. Pure functions, no I/O.
const { isNum } = require('./lib/indicators');

const enabled = (cfg, name) => cfg.brains[name]?.enabled !== false;
const round2 = (x) => Number(x.toFixed(2));

// Paper position plan. Size = risk amount / stop distance, capped by free balance.
// Returns null when the free balance cannot cover the minimum position.
function buildPlan({ price, riskParams, equityUSDT, availableUSDT, slippagePct, minPositionUSDT }) {
    if (![price, equityUSDT, availableUSDT].every(isNum) || price <= 0) return null;
    const entry = price * (1 + slippagePct / 100);
    const sl = riskParams.stop_loss_percent / 100;
    const riskAmount = equityUSDT * (riskParams.max_risk_per_trade_percent / 100);
    const size = Math.min(riskAmount / sl, availableUSDT);
    if (!(size >= minPositionUSDT)) return null;
    return {
        simulated: true,
        entry,
        stopLoss: entry * (1 - sl),
        takeProfit: entry * (1 + riskParams.take_profit_percent / 100),
        positionSizeUSDT: round2(size)
    };
}

// inputs: { tech, risk, sentiment, liquidity, macro, mtf, vol, plan }
// flags:  { positionOpen, maxPositions, insufficientBalance }
//
// Gating brains (any one blocks): technical signal, risk, sentiment availability, liquidity,
// macro, multi-timeframe, position/balance limits.
// Confidence = weighted average of technical, macro, multi-timeframe, sentiment and (only when a
// breakout is detected, by default) volatility.
function decide(inputs, flags, cfg) {
    const { tech, risk, sentiment, liquidity, macro, mtf, vol, plan } = inputs;
    const bs = cfg.brain_settings;
    const w = bs.weights;
    const blockedBy = [];
    const parts = [[tech.score, w.technical]];
    const wantsBuy = tech.action === 'BUY';

    if (!wantsBuy) blockedBy.push('no_signal');
    else if (!risk.approved) blockedBy.push('risk');

    if (enabled(cfg, 'sentiment')) {
        if (!sentiment?.available) blockedBy.push('sentiment_unavailable');
        else parts.push([sentiment.score, w.sentiment]);
    }
    if (enabled(cfg, 'macro')) {
        if (!macro?.approved) blockedBy.push('macro');
        if (macro?.available) parts.push([macro.macroScore, w.macro]);
    }
    if (enabled(cfg, 'multi_timeframe')) {
        if (!mtf?.approved) blockedBy.push('multi_timeframe');
        if (mtf?.available) parts.push([mtf.confluenceScore, w.multi_timeframe]);
    }
    if (enabled(cfg, 'volatility') && vol?.available && (vol.breakoutDetected || !bs.volatility_counts_only_on_breakout)) {
        parts.push([vol.volatilityScore, w.volatility]);
    }
    if (enabled(cfg, 'liquidity') && liquidity?.status !== 'GOOD') blockedBy.push('liquidity');

    const totalWeight = parts.reduce((a, [, wt]) => a + wt, 0);
    const overall = Math.round(parts.reduce((a, [score, wt]) => a + score * wt, 0) / totalWeight);
    if (wantsBuy && overall < bs.min_confidence_score) blockedBy.push('low_confidence');

    if (flags.positionOpen) blockedBy.push('position_open');
    else if (wantsBuy) {
        if (flags.maxPositions) blockedBy.push('max_positions');
        if (flags.insufficientBalance) blockedBy.push('insufficient_balance');
    }

    const finalDecision = blockedBy.length === 0 ? 'BUY' : 'HOLD';
    return {
        finalDecision,
        overallConfidence: overall,
        blockedBy,
        plan: finalDecision === 'BUY' ? plan : null
    };
}

module.exports = { buildPlan, decide };
