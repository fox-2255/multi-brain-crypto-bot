class SentimentBrain {
    constructor(config = {}) {
        this.name = "SentimentBrain";
        this.enabled = config.enabled !== undefined ? config.enabled : true;
    }

    analyze(data) {
        if (!this.enabled) return { brain: this.name, signal: "NEUTRAL", score: 0 };

        // Hahanapin nito ang sentimentScore kahit nasaan man ito nakaposisyon
        let sentimentScore = 0.5;
        if (typeof data === 'object' && data !== null) {
            if (data.sentimentScore !== undefined) {
                sentimentScore = data.sentimentScore;
            } else if (data.marketData && data.marketData.sentimentScore !== undefined) {
                sentimentScore = data.marketData.sentimentScore;
            }
        }
        
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
