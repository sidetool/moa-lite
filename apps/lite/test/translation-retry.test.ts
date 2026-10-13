import test from 'node:test';
import assert from 'node:assert/strict';
import { translationRetry, translationDelay } from '../client/translation-retry.js';
test('translation retries rotate bounded keys, stop permanent failures and back off quota errors', () => {
  assert.equal(translationRetry('translation-key-invalid',0,5,1,0),null);
  assert.equal(translationRetry('translation-key-invalid',0,5,2,0),1000);
  assert.equal(translationRetry('translation-permission-denied',1,5,2,0),null);
  assert.equal(translationRetry('translation-credit-exhausted',0,5,1,0),null);
  assert.equal(translationRetry('translation-model-unavailable',0,5,8,0),null);
  assert.equal(translationRetry('translation-quota',1,5,1,1000),10000);
  assert.equal(translationRetry('translation-unavailable',0,2,1,60000),60000);
  assert.equal(translationRetry('translation-unavailable',2,2,1,0),null);
});
test('cancelling while waiting between translation requests stops immediately', async () => {
  const controller = new AbortController(), wait = translationDelay(60000,controller.signal);
  controller.abort(); await assert.rejects(wait,/translation-cancelled/);
  await assert.rejects(translationDelay(60000,controller.signal),/translation-cancelled/);
});
