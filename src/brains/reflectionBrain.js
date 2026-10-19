// Reflection Brain: looks at recent closed paper trades and advises on risk. Advisory only (never blocks).
const DEFAULTS = { window: 20, minSample: 5, cautionWinRate: 40 };

function evaluateReflection(trades = [], opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const closed = (Array.isArray(trades) ? trades : [])
        .filter((t) => t && t.status === 'CLOSED' && (t.result === 'WIN' || t.result === 'LOSS'))
        .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))
        .slice(-cfg.window);

    const sample = closed.length;
    if (sample < cfg.minSample) {
        return {
            status: 'INSUFFICIENT_DATA',
            sample,
            winRate: null,
            recommendation: `Need at least ${cfg.minSample} closed trades before adjusting.`
        };
    }

    const wins = closed.filter((t) => t.result === 'WIN').length;
    const winRate = Number(((wins / sample) * 100).toFixed(1));
    if (winRate < cfg.cautionWinRate) {
        return {
            status: 'CAUTION',
            sample,
            winRate,
            recommendation: `Win rate ${winRate}% over last ${sample} trades. Consider lowering risk per trade.`
        };
    }
    return { status: 'NORMAL', sample, winRate, recommendation: 'Maintain current risk parameters.' };
}

module.exports = { evaluateReflection };
