const defaults = require('./defaultConfig.json');

const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// defaultConfig.json + env overrides (PORT, HOST, PAPER_BALANCE_USDT), validated.
function loadConfig(env = process.env) {
    const config = JSON.parse(JSON.stringify(defaults));

    if (env.PORT !== undefined && env.PORT !== '') {
        const port = Number(env.PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
        config.port = port;
    }
    if (env.HOST) config.host = env.HOST;
    if (env.PAPER_BALANCE_USDT !== undefined && env.PAPER_BALANCE_USDT !== '') {
        const bal = Number(env.PAPER_BALANCE_USDT);
        if (!isPos(bal)) throw new Error(`Invalid PAPER_BALANCE_USDT: ${env.PAPER_BALANCE_USDT}`);
        config.paper.starting_balance_usdt = bal;
    }

    for (const core of ['technical', 'risk']) {
        if (config.brains[core]?.enabled !== true) throw new Error(`Brain "${core}" is required and cannot be disabled.`);
    }
    const bs = config.brain_settings;
    if (!(bs.min_confidence_score >= 0 && bs.min_confidence_score <= 100)) {
        throw new Error('brain_settings.min_confidence_score must be 0-100.');
    }
    for (const [name, w] of Object.entries(bs.weights)) {
        if (!isNonNeg(w)) throw new Error(`Invalid weight for ${name}.`);
    }
    if (!(bs.weights.technical > 0)) throw new Error('brain_settings.weights.technical must be > 0.');

    const p = config.paper;
    if (![p.starting_balance_usdt, p.max_open_positions, p.min_position_usdt].every(isPos)) {
        throw new Error('Invalid paper settings.');
    }
    // Position cap (% of equity per trade) must be in (0, 100]; daily loss halt in (0, 100], rolling 24h.
    for (const [k, v] of [['max_position_percent', p.max_position_percent], ['max_daily_loss_percent', p.max_daily_loss_percent]]) {
        if (!isPos(v) || v > 100) throw new Error(`Invalid paper.${k} (must be > 0 and <= 100).`);
    }
    if (!isNonNeg(p.fee_percent) || !isNonNeg(p.slippage_percent)) throw new Error('Invalid paper fee/slippage.');

    const s = config.scanner;
    if (![s.deep_per_cycle, s.concurrency, s.max_symbols].every((v) => Number.isInteger(v) && v > 0)) {
        throw new Error('Invalid scanner settings.');
    }
    // 0 disables the background settle loop; otherwise 10s..1h.
    if (!Number.isInteger(s.settle_interval_sec) || (s.settle_interval_sec !== 0 && (s.settle_interval_sec < 10 || s.settle_interval_sec > 3600))) {
        throw new Error('Invalid scanner.settle_interval_sec (0 or 10..3600).');
    }
    return config;
}

module.exports = { loadConfig };
