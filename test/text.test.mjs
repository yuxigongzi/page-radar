/*
 * Unit checks for shared/text.js. Run: node test/text.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../shared/text.js');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + e.message);
  }
}

test('hashText is stable and length aware', () => {
  assert.equal(T.hashText('abc'), T.hashText('abc'));
  assert.notEqual(T.hashText('abc'), T.hashText('abcd'));
});

test('noiseKey ignores relative time and digits', () => {
  assert.equal(T.noiseKey('阅读 123 · 3 分钟前'), T.noiseKey('阅读 456 · 5 分钟前'));
});

test('stripInlineHandlers removes quoted handlers and keeps tags intact', () => {
  const html = '<div data-x="a>b" onclick="x(1)"><img src="a.png" onerror = \'y(2)\'><b>hi</b></div>';
  const out = T.stripInlineHandlers(html);
  assert.equal(out, '<div data-x="a>b" ><img src="a.png" ><b>hi</b></div>');
});

test('stripInlineHandlers handles unquoted values and uppercase names', () => {
  const out = T.stripInlineHandlers('<body OnLoad=alert(1) class=k><a onMouseOver=go()>x</a></body>');
  assert.equal(out, '<body  class=k><a >x</a></body>');
});

test('stripInlineHandlers leaves handler-free HTML untouched', () => {
  const html = '<div class="a" data-onclick="kept"><span>text</span></div>';
  assert.equal(T.stripInlineHandlers(html), html);
});

test('stripInlineHandlers keeps visible text around loose angle brackets', () => {
  const html = '<div>1 < 2 且 3 > 2</div><script>var s = 1;</script>';
  const out = T.stripInlineHandlers(html);
  assert.match(out, /1 < 2 且 3 > 2/);
  assert.match(out, /<script>var s = 1;<\/script>/);
});

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall text checks passed');
