const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const { loadConfig } = require(path.join(SRC, 'config', 'loadConfig'));
const { createScanner } = require(path.join(SRC, 'scanner'));
const { PaperEngine } = require(path.join(SRC, 'lib', 'paperEngine'));
const { decide, buildPlan } = require(path.join(SRC, 'coordinator'));
const { analyzeTechnical } = require(path.join(SRC, 'brains', 'technicalBrain'));
const { evaluateReflection } = require(path.join(SRC, 'brains', 'reflectionBrain'));

const MIN = 60000;
const TF = { '1m': MIN, '15m': 15 * MIN, '1h': 60 * MIN, '4h': 240 * MIN };
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % TF['4h']) + 5000;

function gen(tf, n, pathFn, { range = 0.004, vol = () => 100 } = {}) {
    const ms = TF[tf];
    const lastTs = NOW - (NOW % ms) - ms;
    return Array.from({ length: n }, (_, i) => {
        const close = pathFn(i);
        const open = i === 0 ? close : pathFn(i - 1);
        return [lastTs - (n - 1 - i) * ms, open, Math.max(open, close) * (1 + range), Math.min(open, close) * (1 - range), close, vol(i)];
    });
}
const up = (i) => 100 * Math.pow(1.004, i);
const down = (i) => 300 * Math.pow(0.996, i);

// Uptrend with regular pullbacks (RSI ~54, not overbought). A straight line up is RSI ~100 = HOLD by design.
const buyPath = (i) => 100 + i * 0.06 + Math.sin(((i + 1) * 2 * Math.PI) / 8) * 2;

function mockExchange({ btcPath = up, symbols = {}, tickers = {}, id = 'mock-' + Math.random() } = {}) {
    const calls = [];
    const ex = {
        id,
        calls,
        fetchTickers: async (list) => Object.fromEntries(list.filter((s) => tickers[s]).map((s) => [s, tickers[s]])),
        fetchTicker: async (s) => {
            if (s === 'BTC/USDT') return { last: 100, percentage: 0.5 };
            if (!tickers[s]) throw new Error('no ticker');
            return tickers[s];
        },
        fetchOHLCV: async (s, tf, since, limit) => {
            calls.push([s, tf]);
            if (s === 'BTC/USDT') return tf === '4h' ? gen('4h', 260, btcPath) : gen('1h', 8, btcPath);
            const cfg = symbols[s];
            if (!cfg) throw new Error('no ohlcv for ' + s);
            if (tf === '1m') return cfg.minute ? cfg.minute(since) : [];
            return gen(tf, 120, tf === '15m' ? cfg.path15 : cfg.path1h, { vol: (i) => (i === 119 ? cfg.lastVol ?? 300 : 100) });
        },
        fetchOrderBook: async () => ({ bids: [[100, 50], [99.95, 50]], asks: [[100.05, 20], [100.1, 20]] })
    };
    return ex;
}

const goodTicker = (last = 100) => ({ last, high: last * 1.08, low: last * 0.95, quoteVolume: 5e7, percentage: 1 });

function setup(exOpts, { configMutate, sentiment } = {}) {
    const config = loadConfig({});
    config.scanner.min_quote_volume_usdt = 1e6;
    if (configMutate) configMutate(config);
    const ex = mockExchange(exOpts);
    const clock = { t: NOW };
    const engine = new PaperEngine({ startingBalance: 1000, feePct: 0.1, slippagePct: 0.05, now: () => clock.t });
    const scanner = createScanner({
        config,
        getExchange: (n) => { if (n !== 'mock') { const e = new Error('Unsupported exchange: ' + n); e.status = 400; throw e; } return ex; },
        analyzeSentiment: async () => sentiment ?? { available: true, score: 70, status: 'GREED', reasoning: 'fng 70' },
        engine,
        now: () => clock.t
    });
    return { config, ex, engine, scanner, clock };
}
const body = (extra = {}) => ({ exchangeName: 'mock', symbols: ['SOL/USDT'], paperTrading: true, ...extra });

test('config loads, validates, env overrides', () => {
    const c = loadConfig({ PORT: '4000', PAPER_BALANCE_USDT: '500' });
    assert.equal(c.port, 4000);
    assert.equal(c.paper.starting_balance_usdt, 500);
    assert.ok(c.brain_settings.min_confidence_score > 0 && c.risk_parameters.stop_loss_percent > 0 && c.trading_symbol && c.selected_exchange);
    assert.throws(() => loadConfig({ PORT: 'abc' }));
    assert.throws(() => loadConfig({ PAPER_BALANCE_USDT: '-5' }));
});

test('technical: uptrend BUY, downtrend HOLD, bad data HOLD', () => {
    const buy = analyzeTechnical(gen('15m', 120, buyPath), { percentage: 1 }, { now: NOW });
    assert.equal(buy.action, 'BUY', buy.reasoning);
    assert.ok(buy.score >= 60 && buy.score <= 100);
    assert.match(buy.reasoning, /^Uptrend: /);
    const hold = analyzeTechnical(gen('15m', 120, down), null, { now: NOW });
    assert.equal(hold.action, 'HOLD'); assert.match(hold.reasoning, /^HOLD: /);
    assert.equal(analyzeTechnical(gen('15m', 20, up), null, { now: NOW }).action, 'HOLD');
    assert.equal(analyzeTechnical(null, null, { now: NOW }).action, 'HOLD');
    const nan = gen('15m', 120, up); nan[50][4] = NaN;
    assert.equal(analyzeTechnical(nan, null, { now: NOW }).action, 'HOLD');
});

test('coordinator: every hard filter blocks, confidence is weighted', () => {
    const cfg = loadConfig({});
    const base = {
        tech: { action: 'BUY', score: 80 }, risk: { approved: true }, sentiment: { available: true, score: 70 },
        liquidity: { status: 'GOOD' }, macro: { available: true, approved: true, macroScore: 80 },
        mtf: { available: true, approved: true, confluenceScore: 80 }, vol: { available: true, breakoutDetected: true, volatilityScore: 90 },
        plan: { positionSizeUSDT: 50 }
    };
    const flags = { positionOpen: false, maxPositions: false, insufficientBalance: false };
    const ok = decide(base, flags, cfg);
    assert.equal(ok.finalDecision, 'BUY'); assert.deepEqual(ok.blockedBy, []); assert.ok(ok.plan);
    // weights 3,2,2,1,1.5 -> (240+160+160+70+135)/9.5 = 80.5
    assert.equal(ok.overallConfidence, 81);
    const cases = {
        no_signal: { ...base, tech: { action: 'HOLD', score: 50 } },
        risk: { ...base, risk: { approved: false } },
        sentiment_unavailable: { ...base, sentiment: { available: false } },
        macro: { ...base, macro: { available: true, approved: false, macroScore: 20 } },
        multi_timeframe: { ...base, mtf: { available: true, approved: false, confluenceScore: 20 } },
        liquidity: { ...base, liquidity: { status: 'HIGH_SLIPPAGE' } },
        low_confidence: { ...base, tech: { action: 'BUY', score: 61 }, sentiment: { available: true, score: 10 }, macro: { available: true, approved: true, macroScore: 36 }, mtf: { available: true, approved: true, confluenceScore: 30 } }
    };
    for (const [reason, inputs] of Object.entries(cases)) {
        const r = decide(inputs, flags, cfg);
        assert.equal(r.finalDecision, 'HOLD', reason);
        assert.ok(r.blockedBy.includes(reason), `${reason} -> ${r.blockedBy}`);
        assert.equal(r.plan, null);
    }
    assert.ok(decide(base, { ...flags, positionOpen: true }, cfg).blockedBy.includes('position_open'));
    assert.ok(decide(base, { ...flags, maxPositions: true }, cfg).blockedBy.includes('max_positions'));
    // macro unavailable -> approved false -> blocks (fail closed)
    assert.ok(decide({ ...base, macro: { available: false, approved: false, macroScore: 0 } }, flags, cfg).blockedBy.includes('macro'));
    // disabled brains are skipped
    const off = loadConfig({}); off.brains.macro.enabled = false; off.brains.multi_timeframe.enabled = false; off.brains.sentiment.enabled = false;
    assert.equal(decide({ ...base, macro: null, mtf: null, sentiment: null }, flags, off).finalDecision, 'BUY');
});

test('buildPlan: size from risk, capped by free balance, null when too small', () => {
    const rp = { max_risk_per_trade_percent: 2, stop_loss_percent: 2.5, take_profit_percent: 5 };
    const p = buildPlan({ price: 100, riskParams: rp, equityUSDT: 1000, availableUSDT: 1000, slippagePct: 0, minPositionUSDT: 10 });
    assert.equal(p.positionSizeUSDT, 800); // 20 / 0.025
    assert.equal(p.stopLoss, 97.5); assert.equal(p.takeProfit, 105);
    assert.equal(buildPlan({ price: 100, riskParams: rp, equityUSDT: 1000, availableUSDT: 300, slippagePct: 0, minPositionUSDT: 10 }).positionSizeUSDT, 300);
    assert.equal(buildPlan({ price: 100, riskParams: rp, equityUSDT: 1000, availableUSDT: 5, slippagePct: 0, minPositionUSDT: 10 }), null);
    assert.equal(buildPlan({ price: NaN, riskParams: rp, equityUSDT: 1000, availableUSDT: 1000, slippagePct: 0, minPositionUSDT: 10 }), null);
});

test('scan: bullish setup opens exactly one paper position and reports it', async () => {
    const { scanner, engine } = setup({
        symbols: { 'SOL/USDT': { path15: buyPath, path1h: up } },
        tickers: { 'SOL/USDT': goodTicker() }
    });
    const r = await scanner.scan(body());
    const sol = r.results[0];
    assert.equal(r.success, true);
    assert.equal(sol.symbol, 'SOL/USDT');
    assert.equal(sol.brains.technical.action, 'BUY', sol.brains.technical.reasoning);
    assert.equal(sol.coordinator.finalDecision, 'BUY', String(sol.coordinator.blockedBy));
    assert.equal(r.paper.opened.length, 1);
    assert.equal(engine.openCount(), 1);
    assert.ok(sol.brains.macro.approved && sol.brains.multiTimeframe.approved);
    for (const k of ['technical', 'risk', 'sentiment', 'liquidity', 'macro', 'multiTimeframe', 'volatility']) assert.ok(sol.brains[k], k);
    // second scan: position is open -> no second position
    const r2 = await scanner.scan(body());
    assert.equal(engine.openCount(), 1);
    assert.equal(r2.paper.opened.length, 0);
    assert.ok(r2.results[0].coordinator.blockedBy.includes('position_open'));
    assert.equal(r2.results[0].coordinator.finalDecision, 'HOLD');
});

test('scan: bearish BTC blocks altcoin BUY (macro filter)', async () => {
    const { scanner, engine } = setup({
        btcPath: down,
        symbols: { 'SOL/USDT': { path15: buyPath, path1h: up } },
        tickers: { 'SOL/USDT': goodTicker() }
    });
    const r = await scanner.scan(body());
    assert.equal(r.results[0].brains.technical.action, 'BUY');
    assert.equal(r.results[0].coordinator.finalDecision, 'HOLD');
    assert.ok(r.results[0].coordinator.blockedBy.includes('macro'));
    assert.equal(engine.openCount(), 0);
});

test('scan: higher-timeframe conflict blocks BUY (multi-timeframe filter)', async () => {
    const { scanner, engine } = setup({
        symbols: { 'SOL/USDT': { path15: buyPath, path1h: down } },
        tickers: { 'SOL/USDT': goodTicker() }
    });
    const r = await scanner.scan(body());
    assert.ok(r.results[0].coordinator.blockedBy.includes('multi_timeframe'));
    assert.equal(engine.openCount(), 0);
});

test('scan: sentiment outage fails closed', async () => {
    const { scanner, engine } = setup({
        symbols: { 'SOL/USDT': { path15: buyPath, path1h: up } },
        tickers: { 'SOL/USDT': goodTicker() }
    }, { sentiment: { available: false, score: null, status: 'UNKNOWN', reasoning: 'down' } });
    const r = await scanner.scan(body());
    assert.ok(r.results[0].coordinator.blockedBy.includes('sentiment_unavailable'));
    assert.equal(engine.openCount(), 0);
});

test('scan: filters (stablecoin, low volume, flat, missing ticker) and per-symbol fetch errors', async () => {
    const { scanner } = setup({
        symbols: { 'SOL/USDT': { path15: buyPath, path1h: up } },
        tickers: {
            'SOL/USDT': goodTicker(),
            'USDC/USDT': goodTicker(1),
            'TINY/USDT': { ...goodTicker(), quoteVolume: 1000 },
            'FLAT/USDT': { last: 100, high: 100.5, low: 99.5, quoteVolume: 5e7 },
            'BROKEN/USDT': goodTicker()   // ticker ok but no OHLCV -> fetch error
        }
    });
    const r = await scanner.scan(body({ symbols: ['SOL/USDT', 'USDC/USDT', 'TINY/USDT', 'FLAT/USDT', 'GONE/USDT', 'BROKEN/USDT'] }));
    const get = (s) => r.results.find((x) => x.symbol === s);
    assert.equal(get('USDC/USDT').skipped, 'not_crypto');
    assert.equal(get('TINY/USDT').skipped, 'low_volume');
    assert.equal(get('FLAT/USDT').skipped, 'low_range');
    assert.match(get('GONE/USDT').error, /No ticker/);
    assert.match(get('BROKEN/USDT').error, /fetch failed/);
    assert.ok(get('SOL/USDT').coordinator);
    assert.equal(r.results.length, 6);
    assert.equal(r.scan.total, 6); assert.equal(r.scan.eligible, 2);
});

test('scan: rotation covers all eligible pairs; unscanned ones are pending or cached', async () => {
    const syms = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].map((b) => `${b}/USDT`);
    const symbols = Object.fromEntries(syms.map((s) => [s, { path15: down, path1h: down }]));
    const tickers = Object.fromEntries(syms.map((s) => [s, goodTicker()]));
    const { scanner } = setup({ symbols, tickers });
    const r1 = await scanner.scan(body({ symbols: syms }));
    assert.equal(r1.scan.deep, 6);
    assert.equal(r1.results.filter((x) => x.pending).length, 2);
    const r2 = await scanner.scan(body({ symbols: syms }));
    assert.equal(r2.results.filter((x) => x.pending).length, 0, 'second cycle scans the 2 left-over pairs first');
    assert.ok(r2.results.every((x) => x.coordinator));
    assert.ok(r2.results.some((x) => x.ageSec > 0 || x.ageSec === 0));
});

test('scan: max open positions is enforced, best confidence first', async () => {
    const syms = ['B1', 'B2', 'B3', 'B4'].map((b) => `${b}/USDT`);
    const symbols = Object.fromEntries(syms.map((s) => [s, { path15: buyPath, path1h: up }]));
    const tickers = Object.fromEntries(syms.map((s) => [s, goodTicker()]));
    const { scanner, engine, config } = setup({ symbols, tickers }, { configMutate: (c) => { c.paper.max_open_positions = 2; } });
    const r = await scanner.scan(body({ symbols: syms }));
    assert.equal(engine.openCount(), 2);
    assert.equal(r.paper.opened.length, 2);
    assert.equal(r.results.filter((x) => x.coordinator.blockedBy.includes('max_positions')).length, 2);
    assert.ok(config.paper.max_open_positions === 2);
});

test('scan: request validation', async () => {
    const { scanner } = setup({});
    const bad = async (b, status) => {
        await assert.rejects(() => scanner.scan(b), (e) => e.status === status, JSON.stringify(b));
    };
    await bad(null, 400);
    await bad(body({ paperTrading: false }), 403);
    await bad(body({ symbols: ['sol-usdt'] }), 400);
    await bad(body({ symbols: [] }), 400);
    await bad(body({ symbols: 'SOL/USDT' }), 400);
    await bad(body({ symbols: [123] }), 400);
    await bad(body({ symbols: Array.from({ length: 51 }, (_, i) => `T${i}AA/USDT`) }), 400);
    await bad(body({ riskParams: { stop_loss_percent: 50 } }), 400);
    await bad(body({ riskParams: { max_risk_per_trade_percent: 'abc' } }), 400);
    await bad(body({ riskParams: [] }), 400);
    await bad(body({ exchangeName: 'nope' }), 400);
    // scanner survives bad requests
    assert.equal((await scanner.scan(body({ symbols: ['SOL/USDT'] }))).success, true);
});

test('scan: concurrent scans are serialized (no double-open)', async () => {
    const { scanner, engine } = setup({
        symbols: { 'SOL/USDT': { path15: buyPath, path1h: up } },
        tickers: { 'SOL/USDT': goodTicker() }
    });
    const [a, b] = await Promise.all([scanner.scan(body()), scanner.scan(body())]);
    assert.equal(engine.openCount(), 1);
    assert.equal(a.paper.opened.length + b.paper.opened.length, 1);
});

test('paper engine: take-profit, stop-loss, same-candle conflict (stop first), gap, fees', () => {
    const mk = () => new PaperEngine({ startingBalance: 1000, feePct: 0.1, slippagePct: 0.05, now: () => NOW });
    const plan = { entry: 100, stopLoss: 97.5, takeProfit: 105, positionSizeUSDT: 200 };
    const open = (e) => e.open({ exchange: 'x', symbol: 'A/USDT', plan, score: 80, signal: null });

    let e = mk(); let t = open(e);
    assert.equal(e.settle(t.id, [[NOW + 0, 100, 101, 99, 100, 1], [NOW + MIN, 100, 106, 99, 105, 1]]).exitReason, 'TAKE_PROFIT');
    assert.equal(e.get(t.id).result, 'WIN');
    assert.equal(e.get(t.id).pnlPct, 4.8); // 5% - 2*0.1% fees
    assert.equal(e.get(t.id).pnlUSDT, 9.6);

    e = mk(); t = open(e);
    assert.equal(e.settle(t.id, [[NOW, 100, 100.5, 97, 98, 1]]).exitReason, 'STOP_LOSS');
    assert.equal(e.get(t.id).result, 'LOSS'); assert.ok(e.get(t.id).pnlUSDT < 0);

    e = mk(); t = open(e); // candle touches both levels -> stop first
    assert.equal(e.settle(t.id, [[NOW, 100, 110, 90, 100, 1]]).exitReason, 'STOP_LOSS');

    e = mk(); t = open(e); // gap down through the stop fills at the open (worse than stop)
    e.settle(t.id, [[NOW, 90, 91, 89, 90, 1]]);
    assert.ok(e.get(t.id).exit < 97.5);

    e = mk(); t = open(e); // no hit, malformed row ignored, only candles after checkedTs count, no double-settle
    assert.equal(e.settle(t.id, [[NOW - MIN, 100, 200, 1, 100, 1], ['x', 1], [NOW, 100, 101, 99, 100, 1]]), null);
    assert.equal(e.get(t.id).checkedTs, NOW + MIN);
    assert.equal(e.hasOpen('x', 'A/USDT'), true);
    assert.throws(() => open(e), /already open/);
    e.settle(t.id, [[NOW + MIN, 100, 106, 99, 100, 1]]);
    assert.equal(e.settle(t.id, [[NOW + 2 * MIN, 100, 106, 99, 100, 1]]), null);
    assert.equal(e.stats().closed, 1);
    assert.ok(e.equity() > 1000);
});

test('scan: open trade is settled on the next scan and shows up in paper.closed', async () => {
    const { scanner, engine, ex, clock } = setup({
        symbols: {
            'SOL/USDT': {
                path15: buyPath, path1h: up,
                minute: (since) => [
                    [since + MIN, 100, 101, 99, 100, 1],        // closed, no hit
                    [since + 2 * MIN, 100, 200, 99, 150, 1],    // closed, blows through take-profit
                    [since + 4 * MIN, 100, 1, 1, 1, 1]          // still forming at the clock below: must be ignored
                ]
            }
        },
        tickers: { 'SOL/USDT': goodTicker() }
    });
    await scanner.scan(body());
    assert.equal(engine.openCount(), 1);
    clock.t = NOW + 4 * MIN - 1000; // candle starting at NOW+4m is still forming
    const r = await scanner.scan(body());
    assert.equal(r.paper.closed.length, 1);
    assert.equal(r.paper.closed[0].exitReason, 'TAKE_PROFIT');
    assert.equal(engine.stats().wins, 1);
    assert.equal(engine.stats().closed, 1);
    // No cooldown rule yet: the pair still has a valid BUY, so it is re-entered in the same cycle.
    assert.equal(r.paper.opened.length, 1);
    assert.ok(ex.calls.some(([, tf]) => tf === '1m'));
});

test('settleAll: closes open trades without a scan, skips forming candle, no-op when nothing open', async () => {
    const { scanner, engine, clock } = setup({
        symbols: {
            'SOL/USDT': {
                path15: buyPath, path1h: up,
                minute: (since) => [[since + MIN, 100, 101, 99, 100, 1], [since + 2 * MIN, 100, 200, 99, 150, 1]]
            }
        },
        tickers: { 'SOL/USDT': goodTicker() }
    });
    assert.deepEqual(await scanner.settleAll(), []);
    await scanner.scan(body());
    assert.equal(engine.openCount(), 1);
    clock.t = NOW + 2 * MIN + 1000; // the take-profit candle is still forming -> must not close yet
    assert.equal((await scanner.settleAll()).length, 0);
    assert.equal(engine.openCount(), 1);
    clock.t = NOW + 6 * MIN; // TP candle (NOW+4m) has now closed
    const closed = await scanner.settleAll();
    assert.equal(closed.length, 1);
    assert.equal(closed[0].exitReason, 'TAKE_PROFIT');
    assert.equal(engine.openCount(), 0);
});

test('config: settle_interval_sec validation', () => {
    assert.equal(loadConfig({}).scanner.settle_interval_sec, 60);
});

test('paper engine: persistence + corrupt file recovery', () => {
    const fs = require('node:fs'); const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbcb-'));
    const file = path.join(dir, 'sub', 'trades.json');
    const a = new PaperEngine({ file, startingBalance: 1000, feePct: 0.1, slippagePct: 0.05, now: () => NOW });
    a.open({ exchange: 'x', symbol: 'A/USDT', plan: { entry: 100, stopLoss: 97, takeProfit: 105, positionSizeUSDT: 50 }, score: 70 });
    const b = new PaperEngine({ file, startingBalance: 1000, feePct: 0.1, slippagePct: 0.05, now: () => NOW });
    b.load();
    assert.equal(b.openCount(), 1);
    assert.equal(b.open({ exchange: 'x', symbol: 'B/USDT', plan: { entry: 1, stopLoss: 0.9, takeProfit: 1.1, positionSizeUSDT: 5 }, score: 70 }).id, 2);
    fs.writeFileSync(file, '{not json');
    const c = new PaperEngine({ file, startingBalance: 1000, feePct: 0.1, slippagePct: 0.05, now: () => NOW, log: () => {} });
    c.load();
    assert.equal(c.openCount(), 0);
    assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('reflection: advisory recommendations', () => {
    assert.equal(evaluateReflection([]).status, 'INSUFFICIENT_DATA');
    const mk = (n, wins) => Array.from({ length: n }, (_, i) => ({ status: 'CLOSED', result: i < wins ? 'WIN' : 'LOSS', closedAt: i }));
    assert.equal(evaluateReflection(mk(10, 2)).status, 'CAUTION');
    assert.equal(evaluateReflection(mk(10, 6)).status, 'NORMAL');
    assert.equal(evaluateReflection('junk').status, 'INSUFFICIENT_DATA');
});
