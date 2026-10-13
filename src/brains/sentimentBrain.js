class SentimentBrain {
    constructor(config = {}) {
        this.name = "SentimentBrain";
        this.enabled = config.enabled !== undefined ? config.enabled : true;
    }

    analyze(marketData) {
        if (!this.enabled) return { brain: this.name, signal: "NEUTRAL", score: 0 };

        const sentimentScore = marketData.sentimentScore || 0.5; // Scale: 0 (bearish) to 1 (bullish)
        
        let signal = "NEUTRAL";
        let score = 0;

        if (sentimentScore > 0.6) {
            signal = "BULLISH";
            score = 0.6;
        } else if (sentimentScore < 0.4) {
            signal = "BEARISH";
            score = -0.6;
        }

        return {
            brain: this.name,
            signal,
            score,
            details: { sentimentScore }
        };
    }
}

module.exports = SentimentBrain;
