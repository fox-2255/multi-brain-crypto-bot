class TechnicalBrain {
    constructor(config = {}) {
        this.name = "TechnicalBrain";
        this.enabled = config.enabled !== undefined ? config.enabled : true;
    }

    analyze(marketData) {
        if (!this.enabled) return { brain: this.name, signal: "NEUTRAL", score: 0 };

        const prices = marketData.prices || [];
        if (prices.length === 0) {
            return { brain: this.name, signal: "NEUTRAL", score: 0, reason: "Insufficient price data" };
        }

        const lastPrice = prices[prices.length - 1];
        const prevPrice = prices[prices.length - 2] || lastPrice;

        let score = 0;
        let signal = "NEUTRAL";

        if (lastPrice > prevPrice) {
            score = 0.65;
            signal = "BUY";
        } else if (lastPrice < prevPrice) {
            score = -0.65;
            signal = "SELL";
        }

        return {
            brain: this.name,
            signal,
            score,
            details: { lastPrice, prevPrice }
        };
    }
}

module.exports = TechnicalBrain;
