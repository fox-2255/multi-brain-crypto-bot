// Reflection Brain: looks at recent closed paper trades and advises on risk. Advisory only (never blocks).
const DEFAULTS = { window: 20, minSample: 5, cautionWinRate: 40 };

function evaluateReflection(trades = [], opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const closed = (Array.isArray(trades) ? trades : [])
        .filter((t) => t && t.status === 'CLOSED' && (t.result === 'WIN' || t.result === 'LOSS'))
        .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))
        .slice(-cfg.window);

    const sample = closed.length;
    const bySetup = {};
    for (const t of closed) {
        const k = t.setup || 'trend';
        const b = (bySetup[k] = bySetup[k] || { n: 0, wins: 0 });
        b.n += 1;
        if (t.result === 'WIN') b.wins += 1;
    }
    for (const b of Object.values(bySetup)) b.winRate = Number(((b.wins / b.n) * 100).toFixed(1));
    const setupNote = Object.keys(bySetup).length > 1
        ? ` By setup: ${Object.entries(bySetup).map(([k, b]) => `${k} ${b.wins}/${b.n} (${b.winRate}%)`).join(', ')}.`
        : '';
    if (sample < cfg.minSample) {
        return {
            status: 'INSUFFICIENT_DATA',
            sample,
            winRate: null,
            bySetup,
            recommendation: `Need at least ${cfg.minSample} closed trades before adjusting.${setupNote}`
        };
    }

    const wins = closed.filter((t) => t.result === 'WIN').length;
    const winRate = Number(((wins / sample) * 100).toFixed(1));
    if (winRate < cfg.cautionWinRate) {
        return {
            status: 'CAUTION',
            sample,
            winRate,
            bySetup,
            recommendation: `Win rate ${winRate}% over last ${sample} trades. Consider lowering risk per trade.${setupNote}`
        };
    }
    return { status: 'NORMAL', sample, winRate, bySetup, recommendation: `Maintain current risk parameters.${setupNote}` };
}

module.exports = { evaluateReflection };
