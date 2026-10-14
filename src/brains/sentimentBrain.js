const FNG_URL = 'https://api.alternative.me/fng/?limit=1';
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;

let cache = null;

async function analyzeSentiment() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

    try {
        const res = await fetch(FNG_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const score = Number(json?.data?.[0]?.value);
        if (!Number.isFinite(score) || score < 0 || score > 100) {
            throw new Error('Malformed response');
        }

        const value = {
            available: true,
            score,
            status: score > 50 ? 'GREED' : 'FEAR',
            reasoning: `Fear & Greed Index: ${score}.`
        };
        cache = { at: Date.now(), value };
        return value;
    } catch (err) {
        return {
            available: false,
            score: null,
            status: 'UNKNOWN',
            reasoning: `Sentiment unavailable: ${err.message}`
        };
    }
}

module.exports = { analyzeSentiment };
