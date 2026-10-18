import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities } from '../skills/optbrew/scripts/core/html.mjs';

test('character references decode only to real characters; any other one stays as written (Task 21f re-review N1)', () => {
  assert.equal(decodeEntities('a &amp; b &#65; &#x41; &#x1F600;'), 'a & b A A \u{1F600}');
  for (const raw of ['&#99999999;', '&#x110000;', '&#xD800;', '&#55296;', '&#999999999999999999999999999999;'])
    assert.equal(decodeEntities(`a ${raw} b`), `a ${raw} b`, raw);
});
