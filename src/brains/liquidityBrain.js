function evaluateLiquidity(orderBook) {
    const bestBid = orderBook?.bids?.[0]?.[0];
    const bestAsk = orderBook?.asks?.[0]?.[0];

    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0) {
        return { status: 'POOR', reasoning: 'Order book data unavailable.' };
    }
    const spread = bestAsk - bestBid;
    const isHealthy = spread < bestBid * 0.001;
    return {
        status: isHealthy ? 'GOOD' : 'HIGH_SLIPPAGE',
        reasoning: isHealthy ? 'Order book liquidity is healthy.' : 'Warning: High spread detected.'
    };
}

module.exports = { evaluateLiquidity };
