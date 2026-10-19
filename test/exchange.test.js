const test = require('node:test');
const assert = require('node:assert/strict');
const { exchangeOptions } = require('../src/lib/exchangeOptions');

test('exchangeOptions: binance is limited to spot markets, others untouched', () => {
    const b = exchangeOptions('binance', 10000);
    assert.deepEqual(b.options.fetchMarkets.types, ['spot']);
    assert.equal(b.timeout, 10000);
    assert.equal(b.enableRateLimit, true);
    const o = exchangeOptions('kraken', 10000);
    assert.equal(o.options, undefined);
    assert.equal(o.timeout, 10000);
});
