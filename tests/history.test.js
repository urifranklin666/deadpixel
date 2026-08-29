import test from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../site/js/engine.js';

test('history discards redo entries and their memory estimate', () => {
  const history = new History(40, 100);
  history.push('one', () => {}, () => {}, { bytes: 20 });
  history.push('two', () => {}, () => {}, { bytes: 30 });
  history.undo();
  history.push('replacement', () => {}, () => {}, { bytes: 10 });
  assert.deepEqual(history.entries.map(entry => entry.label), ['one', 'replacement']);
  assert.equal(history.bytes, 30);
  assert.equal(history.canRedo, false);
});

test('history evicts old entries to stay within its byte budget', () => {
  const history = new History(40, 50);
  history.push('one', () => {}, () => {}, { bytes: 30 });
  history.push('two', () => {}, () => {}, { bytes: 30 });
  assert.deepEqual(history.entries.map(entry => entry.label), ['two']);
  assert.equal(history.bytes, 30);
  assert.equal(history.index, 0);
});

test('history always retains the latest action even if it exceeds the budget', () => {
  const history = new History(40, 10);
  history.push('large', () => {}, () => {}, { bytes: 100 });
  assert.equal(history.entries.length, 1);
  assert.equal(history.canUndo, true);
});
