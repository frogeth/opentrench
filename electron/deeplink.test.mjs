// What the shell forwards to the page as an opentrench:// link, and how it finds one in an argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import deeplink from './deeplink.js';

const { isLink, findLink } = deeplink;
const KEY = 'a'.repeat(43);
const INVITE = `opentrench://room/relay.example/${KEY}`;

test('isLink: the scheme plus URL characters, and nothing else', () => {
  assert.equal(isLink(INVITE), true);
  assert.equal(isLink(`opentrench://room/relay.example:8443/${KEY}`), true);
  assert.equal(isLink('opentrench://together/x'), true);
  assert.equal(isLink("opentrench://room/h/k?x=1&y=2#f~._-!$'()*+,;=%40"), true);
  assert.equal(isLink('opentrench://' + 'a'.repeat(600)), true);
});

test('isLink: rejects other schemes, empty, over-long and unsafe strings', () => {
  assert.equal(isLink('https://relay.example/room'), false);
  assert.equal(isLink('opentrench:/room/x'), false);
  assert.equal(isLink('opentrench://'), false);
  assert.equal(isLink('opentrench://' + 'a'.repeat(601)), false);
  assert.equal(isLink('opentrench://room/relay.example/with space'), false);
  assert.equal(isLink('opentrench://room/x\n'), false);
  assert.equal(isLink('opentrench://room/x"'), false);
  assert.equal(isLink(' opentrench://room/x'), false);
  assert.equal(isLink(undefined), false);
  assert.equal(isLink(42), false);
  assert.equal(isLink(null), false);
});

test('findLink: picks the opentrench:// argument among the others', () => {
  assert.equal(findLink(['/Applications/opentrench.app/Contents/MacOS/opentrench', '--no-sandbox', INVITE, 'later'], ), INVITE);
  assert.equal(findLink([INVITE]), INVITE);
  // the first one wins
  assert.equal(findLink([INVITE, 'opentrench://room/other/' + KEY]), INVITE);
});

test('findLink: nothing when there is no link, an over-long one, or no argv', () => {
  assert.equal(findLink(['electron', '.']), undefined);
  assert.equal(findLink(['C:\\opentrench\\opentrench.exe', 'opentrench://' + 'a'.repeat(601)]), undefined);
  assert.equal(findLink(['x', 'https://relay.example/room']), undefined);
  assert.equal(findLink([42, null, undefined, {}]), undefined);
  assert.equal(findLink([42, null, INVITE]), INVITE);
  assert.equal(findLink(undefined), undefined);
  assert.equal(findLink('opentrench://room/x'), undefined);
});
