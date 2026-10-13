class SentimentBrain {
    constructor(config = {}) {
        this.name = "SentimentBrain";
        this.enabled = config.enabled !== undefined ? config.enabled : true;
    }

    analyze(data) {
        if (!this.enabled) return { brain: this.name, signal: "NEUTRAL", score: 0 };

        // Kunin ang sentimentScore kung nasaan man ito (sa data o sa data.marketData)
        const sentimentScore = (data && data.sentimentScore !== undefined) 
            ? data.sentimentScore 
            : (data && data.marketData && data.marketData.sentimentScore !== undefined)
                ? data.marketData.sentimentScore
                : 0.5;
        
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
