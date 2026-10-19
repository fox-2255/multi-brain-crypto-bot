// ccxt constructor options per exchange.
// Binance: by default ccxt's loadMarkets also pulls USD-M (fapi) and COIN-M (dapi) futures
// exchangeInfo. This bot is spot-only, and those extra requests are large and were timing out
// on mobile (blocking every OHLCV call). Verified against ccxt's binance.fetchMarkets:
// options.fetchMarkets.types selects which market types are fetched.
function exchangeOptions(name, timeoutMs) {
    const opts = { enableRateLimit: true, timeout: timeoutMs };
    if (name === 'binance') opts.options = { fetchMarkets: { types: ['spot'] } };
    return opts;
}

module.exports = { exchangeOptions };
