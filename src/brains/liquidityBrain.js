// src/liquidityBrain.js
class LiquidityBrain {
    async analyze(marketData) {
        // Susuriin ang order book depth at liquidity spread
        const orderBook = marketData.orderBook || { bids: 100, asks: 90 };
        const ratio = orderBook.bids / (orderBook.asks || 1);
        
        let status = "GOOD";
        let score = 75;

        if (ratio > 1.2) {
            status = "HEALTHY";
            score = 85;
        } else if (ratio < 0.8) {
            status = "THIN";
            score = 40;
        }

        return {
            brain: "LiquidityBrain",
            status: status,
            score: score,
            details: `Bid/Ask ratio: ${ratio.toFixed(2)}, Order book is ${status.toLowerCase()}`
        };
    }
}

module.exports = LiquidityBrain;
