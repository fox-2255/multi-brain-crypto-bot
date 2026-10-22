const fs = require('node:fs');

// Server-side scan loop: the bot keeps scanning (and can catch a dip) even when the APK is closed.
// It reuses the last scan request the UI sent (pairs, exchange, risk params), persisted across restarts.
// Paper-only by construction: the scanner itself rejects paperTrading=false.

// Only remember what a scan request needs; ignore anything else a client sent.
function pickRequest(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    const req = { paperTrading: true };
    if (Array.isArray(body.symbols) && body.symbols.every((s) => typeof s === 'string')) req.symbols = body.symbols;
    else if (typeof body.symbol === 'string') req.symbols = [body.symbol];
    else return null; // no pair list -> nothing sensible to scan on our own
    if (typeof body.exchangeName === 'string') req.exchangeName = body.exchangeName;
    if (body.riskParams && typeof body.riskParams === 'object' && !Array.isArray(body.riskParams)) req.riskParams = body.riskParams;
    return req;
}

function loadRequest(file, log = () => {}) {
    try {
        return pickRequest(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
        if (err.code !== 'ENOENT') log('warn', `auto-scan: ignoring unreadable ${file} (${err.message})`);
        return null;
    }
}

function saveRequest(file, req, log = () => {}) {
    try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(req));
        fs.renameSync(tmp, file);
    } catch (err) {
        log('warn', `auto-scan: could not save request (${err.message})`);
    }
}

// Sequential timer (never overlaps itself; scanner.scan also serialises with UI scans).
// Errors back off exponentially (x2, capped) and reset on the next success.
function startAutoScanLoop({ scanner, file, intervalSec, log, maxBackoffSec = 300 }) {
    if (!intervalSec) { log('info', 'Auto-scan loop disabled.'); return { stop: () => {}, remember: () => {} }; }
    let request = loadRequest(file, log);
    let stopped = false;
    let timer = null;
    let failures = 0;

    const schedule = () => {
        if (stopped) return;
        const delaySec = failures ? Math.min(intervalSec * 2 ** failures, maxBackoffSec) : intervalSec;
        timer = setTimeout(tick, delaySec * 1000);
        timer.unref();
    };
    async function tick() {
        if (request) {
            try {
                await scanner.scan(request);
                failures = 0;
            } catch (err) {
                failures = Math.min(failures + 1, 10);
                log('warn', `auto-scan: ${err.message} (retry in ${Math.min(intervalSec * 2 ** failures, maxBackoffSec)}s)`);
            }
        }
        schedule();
    }

    // Called with every client scan body that the scanner accepted.
    function remember(body) {
        const req = pickRequest(body);
        if (!req) return;
        const changed = JSON.stringify(req) !== JSON.stringify(request);
        request = req;
        if (changed) saveRequest(file, req, log);
    }

    timer = setTimeout(tick, 10000);
    timer.unref();
    log('info', `Auto-scan loop every ${intervalSec}s${request ? ` (${request.symbols.length} pairs from last session)` : ' (waiting for the first scan from the app)'}.`);
    return { stop: () => { stopped = true; clearTimeout(timer); }, remember };
}

module.exports = { startAutoScanLoop, pickRequest, loadRequest, saveRequest };
