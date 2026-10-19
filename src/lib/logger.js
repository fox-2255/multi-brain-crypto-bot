const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Returns log(level, ...args). Unknown levelName falls back to info.
function createLogger(levelName = 'info') {
    const threshold = LEVELS[levelName] ?? LEVELS.info;
    return function log(level, ...args) {
        if (LEVELS[level] <= threshold) {
            const fn = level === 'debug' ? 'log' : level;
            console[fn](`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
        }
    };
}

module.exports = { createLogger };
