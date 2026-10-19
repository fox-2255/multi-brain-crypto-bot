// Scanner: one scan cycle = settle open paper trades -> filter pairs -> deep-analyze a rotating
// subset with all brains -> coordinator decision -> open paper positions for the best BUYs.
// No express/ccxt import here: the exchange getter and sentiment source are injected.
const { analyzeTechnical } = require('./brains/technicalBrain');
const { evaluateRisk, normalizeRiskParams } = require('./brains/riskBrain');
const { evaluateLiquidity } = require('./brains/liquidityBrain');
const { analyzeMacroTrend } = require('./brains/macroBrain');
const { evaluateMultiTimeframe } = require('./brains/multiTimeframeBrain');
const { detectBreakout } = require('./brains/volatilityBrain');
const { evaluateReflection } = require('./brains/reflectionBrain');
const { buildPlan, decide } = require('./coordinator');
const { httpError } = require('./lib/http');
const { isNum } = require('./lib/indicators');

const SYMBOL_RE = /^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/;
const CACHE_MAX = 500;
const MINUTE_MS = 60 * 1000;

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i); // fn must not throw
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

function createScanner({ config, getExchange, analyzeSentiment, engine, now = Date.now, log = () => {} }) {
    const cache = new Map(); // `${exchange}|${symbol}` -> { result, at }
    let lock = Promise.resolve();

    const enabled = (name) => config.brains[name]?.enabled !== false;
    const sc = config.scanner;

    function validateRequest(body) {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid request body.');
        const paperTrading = body.paperTrading !== false;
        if (!paperTrading) throw httpError(403, 'Live trading is not implemented. Paper mode only.');

        const rawList = body.symbols ?? (body.symbol !== undefined ? [body.symbol] : [config.trading_symbol]);
        if (!Array.isArray(rawList) || rawList.some((s) => typeof s !== 'string')) throw httpError(400, 'symbols must be an array of strings.');
        const symbols = [...new Set(rawList.map((s) => s.trim().toUpperCase()).filter(Boolean))];
        if (symbols.length < 1) throw httpError(400, 'Add at least one pair.');
        if (symbols.length > sc.max_symbols) throw httpError(400, `Max ${sc.max_symbols} pairs.`);
        const bad = symbols.find((s) => !SYMBOL_RE.test(s));
        if (bad) throw httpError(400, `Invalid symbol: ${String(bad).slice(0, 20)} (expected e.g. SOL/USDT).`);

        if (body.riskParams !== undefined && (body.riskParams === null || typeof body.riskParams !== 'object' || Array.isArray(body.riskParams))) {
            throw httpError(400, 'riskParams must be an object.');
        }
        const { value: riskParams, error } = normalizeRiskParams({ ...config.risk_parameters, ...(body.riskParams || {}) });
        if (error) throw httpError(400, error);

        const exchangeName = body.exchangeName ?? config.selected_exchange;
        return { exchangeName, symbols, riskParams, paperTrading };
    }

    async function loadTickers(exchange, symbols) {
        const map = new Map();
        try {
            const all = await exchange.fetchTickers(symbols);
            for (const s of symbols) if (all && all[s]) map.set(s, all[s]);
            return map;
        } catch (err) {
            log('warn', `fetchTickers failed (${err.message}); falling back to per-symbol.`);
        }
        await mapLimit(symbols, sc.concurrency, async (s) => {
            try { map.set(s, await exchange.fetchTicker(s)); } catch (err) { log('debug', `ticker ${s}: ${err.message}`); }
            return null;
        });
        return map;
    }

    async function settleOpen(exchange, exchangeName) {
        const closed = [];
        const open = engine.openTrades(exchangeName);
        await mapLimit(open, sc.concurrency, async (t) => {
            try {
                const rows = await exchange.fetchOHLCV(t.symbol, '1m', t.checkedTs, 1000);
                const done = (rows || []).filter((r) => Array.isArray(r) && isNum(r[0]) && r[0] + MINUTE_MS <= now());
                const result = engine.settle(t.id, done);
                if (result) closed.push(result);
            } catch (err) {
                log('warn', `settle ${t.symbol}: ${err.message}`);
            }
            return null;
        });
        return closed;
    }

    function classify(symbol, ticker, riskParams) {
        const base = symbol.split('/')[0];
        if (sc.excluded_bases.includes(base)) return { skip: { symbol, skipped: 'not_crypto' } };
        if (!ticker) return { skip: { symbol, error: 'No ticker (pair not available on this exchange).' } };
        if (!isNum(ticker.last) || ticker.last <= 0) return { skip: { symbol, error: 'Invalid ticker price from exchange.' } };

        const quoteVolume = isNum(ticker.quoteVolume) ? ticker.quoteVolume
            : (isNum(ticker.baseVolume) ? ticker.baseVolume * ticker.last : null);
        if (quoteVolume === null) return { skip: { symbol, error: 'No volume data from exchange.' } };
        if (quoteVolume < sc.min_quote_volume_usdt) return { skip: { symbol, skipped: 'low_volume', quoteVolume } };

        if (isNum(ticker.high) && isNum(ticker.low) && ticker.low > 0) {
            const range24hPct = ((ticker.high - ticker.low) / ticker.low) * 100;
            if (range24hPct < riskParams.take_profit_percent) return { skip: { symbol, skipped: 'low_range', range24hPct, quoteVolume } };
        }
        return { eligible: { symbol, ticker, quoteVolume } };
    }

    async function fetchDeep(exchange, item) {
        try {
            const [ohlcv15, ohlcv1h, book] = await Promise.all([
                exchange.fetchOHLCV(item.symbol, '15m', undefined, 120),
                enabled('multi_timeframe') ? exchange.fetchOHLCV(item.symbol, '1h', undefined, 120) : Promise.resolve(null),
                exchange.fetchOrderBook(item.symbol, 10)
            ]);
            return { ...item, ohlcv15, ohlcv1h, book };
        } catch (err) {
            return { ...item, error: `Data fetch failed: ${err.message}` };
        }
    }

    // Evaluates all brains for one pair against CURRENT paper-engine state.
    function evaluate(item, ctx) {
        const { exchangeName, riskParams, macro, sentiment } = ctx;
        const t = now();
        const tech = analyzeTechnical(item.ohlcv15, item.ticker, { now: t });
        const risk = enabled('risk') ? evaluateRisk(tech, riskParams) : { approved: true, reasoning: 'Risk brain disabled.' };
        const liquidity = enabled('liquidity') ? evaluateLiquidity(item.book) : { status: 'GOOD', reasoning: 'Liquidity brain disabled.' };
        const mtf = enabled('multi_timeframe') ? evaluateMultiTimeframe(item.ohlcv15, item.ohlcv1h, { now: t }) : null;
        const vol = enabled('volatility') ? detectBreakout(item.ohlcv15, item.book, { now: t }) : null;

        const positionOpen = engine.hasOpen(exchangeName, item.symbol);
        const maxPositions = !positionOpen && engine.openCount() >= config.paper.max_open_positions;
        const plan = buildPlan({
            price: item.ticker.last,
            riskParams,
            equityUSDT: engine.equity(),
            availableUSDT: engine.availableUSDT(),
            slippagePct: config.paper.slippage_percent,
            minPositionUSDT: config.paper.min_position_usdt
        });
        const insufficientBalance = tech.action === 'BUY' && plan === null && !positionOpen && !maxPositions;

        const coordinator = decide(
            { tech, risk, sentiment, liquidity, macro, mtf, vol, plan },
            { positionOpen, maxPositions, insufficientBalance },
            config
        );
        return {
            symbol: item.symbol,
            quoteVolume: item.quoteVolume,
            coordinator,
            brains: { technical: tech, risk, sentiment, liquidity, macro, multiTimeframe: mtf, volatility: vol }
        };
    }

    function remember(exchangeName, result) {
        const key = `${exchangeName}|${result.symbol}`;
        cache.delete(key);
        cache.set(key, { result, at: now() });
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }

    async function runScan(body) {
        const { exchangeName, symbols, riskParams } = validateRequest(body);
        const exchange = getExchange(exchangeName);

        const closed = await settleOpen(exchange, exchangeName);
        const tickers = await loadTickers(exchange, symbols);

        const bySymbol = new Map();
        const eligible = [];
        for (const s of symbols) {
            const c = classify(s, tickers.get(s), riskParams);
            if (c.skip) bySymbol.set(s, c.skip);
            else eligible.push(c.eligible);
        }

        // Rotate: never-scanned first, then the stalest.
        const lastAt = (s) => cache.get(`${exchangeName}|${s.symbol}`)?.at ?? -1;
        const ordered = [...eligible].sort((a, b) => lastAt(a) - lastAt(b));
        const deepSet = ordered.slice(0, sc.deep_per_cycle);
        const deepSymbols = new Set(deepSet.map((d) => d.symbol));

        const [macro, sentiment] = await Promise.all([
            enabled('macro') ? analyzeMacroTrend(exchange, { now: now() }) : Promise.resolve(null),
            enabled('sentiment') ? analyzeSentiment() : Promise.resolve(null)
        ]);

        const fetched = await mapLimit(deepSet, sc.concurrency, (item) => fetchDeep(exchange, item));
        const ctx = { exchangeName, riskParams, macro, sentiment };

        // Pass 1: evaluate. Pass 2: open BUYs best-first, re-evaluating against updated paper state.
        const evaluated = new Map();
        for (const f of fetched) {
            if (f.error) { bySymbol.set(f.symbol, { symbol: f.symbol, error: f.error }); continue; }
            try {
                evaluated.set(f.symbol, { item: f, result: evaluate(f, ctx) });
            } catch (err) {
                log('error', `evaluate ${f.symbol}: ${err.stack || err.message}`);
                bySymbol.set(f.symbol, { symbol: f.symbol, error: `Analysis failed: ${err.message}` });
            }
        }

        const opened = [];
        const buys = [...evaluated.values()]
            .filter((e) => e.result.coordinator.finalDecision === 'BUY')
            .sort((a, b) => b.result.coordinator.overallConfidence - a.result.coordinator.overallConfidence);
        for (const entry of buys) {
            const fresh = evaluate(entry.item, ctx);
            entry.result = fresh;
            if (fresh.coordinator.finalDecision !== 'BUY') continue;
            try {
                const trade = engine.open({
                    exchange: exchangeName,
                    symbol: fresh.symbol,
                    plan: fresh.coordinator.plan,
                    score: fresh.coordinator.overallConfidence,
                    signal: fresh.brains.technical.signal
                });
                opened.push(trade);
                log('info', `PAPER BUY ${exchangeName} ${trade.symbol} @ ${trade.entry} size ${trade.sizeUSDT} USDT (confidence ${trade.score})`);
            } catch (err) {
                log('error', `open ${fresh.symbol}: ${err.message}`);
                entry.result = { ...fresh, coordinator: { ...fresh.coordinator, finalDecision: 'HOLD', plan: null, blockedBy: [...fresh.coordinator.blockedBy, 'open_failed'] } };
            }
        }
        for (const e of evaluated.values()) {
            remember(exchangeName, e.result);
            bySymbol.set(e.result.symbol, { ...e.result, ageSec: 0 });
        }

        // Eligible pairs not scanned this cycle: last known result, or pending.
        const maxAgeMs = sc.max_cache_age_sec * 1000;
        for (const e of eligible) {
            if (deepSymbols.has(e.symbol)) continue;
            const hit = cache.get(`${exchangeName}|${e.symbol}`);
            if (hit && now() - hit.at <= maxAgeMs) {
                bySymbol.set(e.symbol, { ...hit.result, ageSec: Math.round((now() - hit.at) / 1000) });
            } else {
                bySymbol.set(e.symbol, { symbol: e.symbol, pending: true, quoteVolume: e.quoteVolume });
            }
        }

        const results = symbols.map((s) => bySymbol.get(s));
        const scored = results.filter((r) => r.coordinator).sort((a, b) => b.coordinator.overallConfidence - a.coordinator.overallConfidence);
        const rest = results.filter((r) => !r.coordinator);

        return {
            success: true,
            status: 'ACTIVE',
            exchange: exchangeName,
            paperTrading: true,
            scan: {
                total: symbols.length,
                eligible: eligible.length,
                deep: deepSet.length,
                scanned: results.filter((r) => r.coordinator).length,
                passCycles: Math.max(1, Math.ceil(eligible.length / sc.deep_per_cycle))
            },
            macro,
            paper: { opened, closed },
            reflection: enabled('reflection') ? evaluateReflection(engine.allTrades()) : null,
            results: [...scored, ...rest]
        };
    }

    // Scans never overlap (two clients / a slow cycle would double-open positions).
    function scan(body) {
        const run = lock.then(() => runScan(body));
        lock = run.catch(() => {});
        return run;
    }

    return { scan, _cache: cache };
}

module.exports = { createScanner, mapLimit, SYMBOL_RE };
