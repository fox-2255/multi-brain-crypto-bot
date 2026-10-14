// src/reflectionBrain.js
class ReflectionBrain {
    async evaluate(pastTrades) {
        // Susuriin ang nakaraang performance para mag-adjust ng diskarte
        const trades = pastTrades || [];
        const wins = trades.filter(t => t.result === 'WIN').length;
        const total = trades.length;
        
        const winRate = total > 0 ? (wins / total) * 100 : 50;

        let recommendation = "Maintain current risk parameters.";
        if (winRate < 40 && total >= 5) {
            recommendation = "High loss frequency detected. Lower risk per trade by 1%.";
        }

        return {
            brain: "ReflectionBrain",
            winRate: winRate.toFixed(1) + "%",
            recommendation: recommendation
        };
    }
}

module.exports = ReflectionBrain;
