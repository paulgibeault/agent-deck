// DeckState: closed sessions, and the namespaces features keep their own state in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeckState } from '../lib/deckstate.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-'));
const onDisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('namespaces are kept apart', () => {
  const deck = new DeckState(tmp());
  const stars = deck.ns('stars'); const tags = deck.ns('tags');
  stars.set('a', { at: 1 });
  tags.set('a', ['x']);
  assert.deepEqual(stars.get('a'), { at: 1 });
  assert.deepEqual(tags.get('a'), ['x']);
  assert.equal(stars.get('b'), undefined);
  assert.equal(stars.get('b', 7), 7);
  assert.deepEqual(stars.keys(), ['a']);
  assert.deepEqual(deck.ns('nobody').keys(), []);
});

test('namespaces persist, next to hidden, and survive a reload', () => {
  const dir = tmp();
  const deck = new DeckState(dir);
  deck.setHidden('s1', true);
  deck.ns('stars').set('e1', true);
  deck.ns('vault').set('cfg', { dir: 'x' });
  assert.deepEqual(onDisk(dir), { hidden: ['s1'], ns: { stars: { e1: true }, vault: { cfg: { dir: 'x' } } } });

  const again = new DeckState(dir);
  assert.equal(again.hidden.has('s1'), true);
  assert.equal(again.ns('stars').get('e1'), true);
  assert.deepEqual(again.ns('vault').get('cfg'), { dir: 'x' });
  // The old API still saves namespaces it knows nothing about.
  again.setHidden('s1', false);
  assert.deepEqual(onDisk(dir), { hidden: [], ns: { stars: { e1: true }, vault: { cfg: { dir: 'x' } } } });
});

test('setting undefined deletes, and an empty namespace leaves state.json', () => {
  const dir = tmp();
  const deck = new DeckState(dir);
  const stars = deck.ns('stars');
  stars.set('a', 1);
  stars.set('a', undefined);
  assert.deepEqual(stars.keys(), []);
  assert.deepEqual(onDisk(dir), { hidden: [] });
});

test('a state.json from before namespaces still loads', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ hidden: ['old'] }));
  const deck = new DeckState(dir);
  assert.equal(deck.hidden.has('old'), true);
  assert.deepEqual(deck.ns('stars').keys(), []);
});

test('ns: get returns a copy; bad names and a corrupt ns are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-'));
  const st = new DeckState(dir);
  const v = st.ns('vault');
  v.set('cfg', { dir: '/a' });
  v.get('cfg').dir = '/changed';
  assert.equal(v.get('cfg').dir, '/a', 'changing the copy changes nothing');
  assert.throws(() => st.ns('__proto__'), /bad state namespace/);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ hidden: [], ns: [] }));
  const again = new DeckState(dir);
  again.ns('stars').set('k', 1);
  assert.equal(new DeckState(dir).ns('stars').get('k'), 1, 'an array ns is replaced, not written into');
});
