import assert from 'node:assert/strict';
import test from 'node:test';
import { assessParcelBox } from '../public/admin/royal-mail-parcel-check.js';

const sample = {weightGrams: 2610, lengthCm: 50, widthCm: 40, heightCm: 110};
test('express24 measurements use the longest outside edge and include the published boundary', () => {
  const result = assessParcelBox('NDB', null, sample);
  assert.equal(result.volumeLitres, 220);
  assert.equal(result.status, 'within');
  assert.match(result.messages[0], /contract limits still need confirmation/);
  assert.equal(assessParcelBox(' NDB ', null, {...sample, widthCm: 40.1}).status, 'attention');
  assert.equal(assessParcelBox('NDB', null, {...sample, lengthCm: 1, heightCm: 150}).status, 'within');
  assert.match(assessParcelBox('NDB', null, {...sample, lengthCm: 1, heightCm: 150.1}).messages.join(' '), /surcharge/);
  assert.equal(assessParcelBox('NDB', null, {...sample, weightGrams: 30001}).status, 'attention');
});

test('other services use only the recorded contract and single-parcel weight limit', () => {
  assert.equal(assessParcelBox('TPS48', null, {...sample, heightCm: 160}).status, 'unverified');
  const contract = {maxWeightGrams: 3000, maxLengthCm: 200, maxLengthPlusGirthCm: 290};
  const result = assessParcelBox('TPS48', contract, sample);
  assert.equal(result.lengthPlusGirthCm, 290);
  assert.equal(result.status, 'within');
  assert.equal(assessParcelBox('TPS48', contract, {...sample, widthCm: 40.1}).status, 'attention');
  assert.equal(assessParcelBox('TPS48', contract, {...sample, weightGrams: 3001}).status, 'attention');
  assert.equal(assessParcelBox('NDB', {maxWeightGrams: 30000, maxLengthCm: 150, maxVolumeLitres: 180}, sample).status, 'attention');
});

test('missing, non-finite or finer-than-measurable inputs give no size result', () => {
  for (const input of [{widthCm: 0}, {heightCm: undefined}, {weightGrams: NaN}, {lengthCm: Infinity}, {lengthCm: -2}, {heightCm: 12.34}]) {
    assert.equal(assessParcelBox('NDB', null, {...sample, ...input}).status, 'incomplete');
  }
});
