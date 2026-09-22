/**
 * LIVE INTEGRATION TESTS
 * PreStocks & Jupiter Live Network Verification
 * Run separately with: node --test test/integration.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPreStocksTokens,
  PRESET_BASKETS
} from '../src/dataLayer.js';

describe('Live Integration Tests (Network Dependent)', () => {
  test('Excludes SpaceX from active PreStocks token candidate list', async () => {
    const tokens = await fetchPreStocksTokens();
    const spacex = tokens.find(t => t.symbol === 'SPACEX');
    assert.equal(spacex, undefined, 'SpaceX must be excluded (post-IPO)');

    const anthropic = tokens.find(t => t.symbol === 'ANTHROPIC');
    assert.ok(anthropic, 'Anthropic must be present in PreStocks list');
    assert.ok(anthropic.contract_address, 'Contract address must be defined');
  });

  test('Preset basket constants match requirements', () => {
    const preset = PRESET_BASKETS.MAIN;
    assert.deepEqual(preset.symbols, ['ANTHROPIC', 'ANDURIL', 'FIGUREAI']);
    assert.equal(Object.keys(preset.weights).length, 3);
  });
});
