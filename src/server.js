const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Import Brains
const TechnicalBrain = require('./brains/technicalBrain');
const RiskBrain = require('./brains/riskBrain');
const SentimentBrain = require('./brains/sentimentBrain');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50MB' }));

// Load configuration
let config = {};
try {
    const configPath = path.join(__dirname, 'config', 'defaultConfig.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
    console.log('[WARNING] Could not load defaultConfig.json, using defaults.');
}

// Initialize Brain Instances
const technicalBrain = new TechnicalBrain(config.brains?.technical || {});
const riskBrain = new RiskBrain(config.brains?.risk || {});
const sentimentBrain = new SentimentBrain(config.brains?.sentiment || {});

const PORT = config.port || 3000;

// Status Endpoint
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        message: "Multi-Brain Server is Online!",
        status: "ACTIVE"
    });
});

// Multi-Brain Analysis Endpoint
app.post('/api/analyze', (req, res) => {
    try {
        const marketData = req.body.marketData || {};
        const accountBalance = req.body.accountBalance || 1000;
        const openPositions = req.body.openPositions || [];

        // Run Brains
        const techResult = technicalBrain.analyze(marketData);
        const riskResult = riskBrain.evaluateRisk(accountBalance, openPositions);
        const sentimentResult = sentimentBrain.analyze(req.body); // Pasa ang buong req.body para masagap ang sentimentScore

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            analysis: {
                technical: techResult,
                risk: riskResult,
                sentiment: sentimentResult
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`[MULTI-BRAIN SERVER] Running on port ${PORT}`);
});
