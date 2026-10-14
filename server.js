// server.js - Multi-Brain Crypto Trading Bot Server
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

// Import all 5 Brains mula sa src/brains/
const TechnicalBrain = require('./src/brains/technicalBrain');
const RiskBrain = require('./src/brains/riskBrain');
const SentimentBrain = require('./src/brains/sentimentBrain');
const LiquidityBrain = require('./src/brains/liquidityBrain');
const ReflectionBrain = require('./src/brains/reflectionBrain');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Initialize Brains
const techBrain = new TechnicalBrain();
const riskBrain = new RiskBrain();
const sentimentBrain = new SentimentBrain();
const liquidityBrain = new LiquidityBrain();
const reflectionBrain = new ReflectionBrain();

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'ONLINE', message: 'Multi-Brain Crypto Trading Bot API is running!' });
});

// Main Analysis & Decision Endpoint (Chief Coordinator)
app.post('/api/analyze', async (req, res) => {
    try {
        const marketData = req.body.marketData || { price: 100, volume: 5000, orderBook: { bids: 120, asks: 90 } };
        const pastTrades = req.body.pastTrades || [];

        // Patakbuhin ang lahat ng 5 brains sabay-sabay
        const techResult = await techBrain.analyze(marketData);
        const riskResult = await riskBrain.evaluate(marketData);
        const sentimentResult = await sentimentBrain.analyze();
        const liquidityResult = await liquidityBrain.analyze(marketData);
        const reflectionResult = await reflectionBrain.evaluate(pastTrades);

        // Chief Coordinator Aggregation Logic
        let overallScore = (techResult.score + liquidityResult.score) / 2;
        let finalDecision = overallScore >= 70 && riskResult.approved ? "BUY" : "HOLD";

        res.json({
            success: true,
            decision: finalDecision,
            coordinatorScore: overallScore.toFixed(1) + "%",
            brains: {
                technical: techResult,
                risk: riskResult,
                sentiment: sentimentResult,
                liquidity: liquidityResult,
                reflection: reflectionResult
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Multi-Brain Bot Server is running on port ${PORT}`);
});
