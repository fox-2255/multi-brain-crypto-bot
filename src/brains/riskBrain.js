class RiskBrain {
    constructor(config = {}) {
        this.name = "RiskBrain";
        this.enabled = config.enabled !== undefined ? config.enabled : true;
        this.maxDrawdownPercent = config.maxDrawdownPercent || 5.0;
    }

    evaluateRisk(accountBalance, openPositions) {
        if (!this.enabled) return { brain: this.name, safe: true, action: "ALLOW" };

        let totalExposure = 0;
        if (openPositions && Array.isArray(openPositions)) {
            totalExposure = openPositions.reduce((acc, pos) => acc + (pos.size || 0), 0);
        }

        if (totalExposure > accountBalance * 0.5) {
            return {
                brain: this.name,
                safe: false,
                action: "REDUCE_EXPOSURE",
                reason: "Total exposure exceeds 50% of account balance"
            };
        }

        return {
            brain: this.name,
            safe: true,
            action: "ALLOW",
            reason: "Risk levels within acceptable limits"
        };
    }
}

module.exports = RiskBrain;
