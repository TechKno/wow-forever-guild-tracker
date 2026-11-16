import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const script = readFileSync(new URL('../public/tools.js', import.meta.url), 'utf8');

function calculator() {
  const rows = new Map(['orange', 'yellow', 'green', 'grey', 'red'].map(band => {
    const result = {};
    return [band, {dataset: {skinningBand: band}, querySelector: () => result}];
  }));
  const elements = {
    'skinning-mob-level': {max: '63'},
    'skinning-current-skill': {},
    'skinning-required': {},
    'skinning-highest': {},
    'skinning-ranges': {querySelectorAll: () => rows.values()}
  };
  for (const input of [elements['skinning-mob-level'], elements['skinning-current-skill']]) {
    Object.assign(input, {
      value: '', valueAsNumber: NaN, validity: {valid: true},
      addEventListener(type, update) { this[type] = update; },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; }
    });
  }
  runInNewContext(script, {document: {getElementById: id => elements[id]}});
  return {
    ranges() {
      if (elements['skinning-ranges'].hidden) return null;
      return Object.fromEntries([...rows].filter(([, row]) => !row.hidden)
        .map(([band, row]) => [band, row.querySelector('dd').textContent]));
    },
    enter(kind, value, {valid = true, badInput = false} = {}) {
      const input = elements[kind === 'level' ? 'skinning-mob-level' : 'skinning-current-skill'];
      const output = elements[kind === 'level' ? 'skinning-required' : 'skinning-highest'];
      Object.assign(input, {value: String(value), valueAsNumber: value === '' ? NaN : value, validity: {valid, badInput}});
      input.input();
      return [output.textContent, input['aria-invalid']];
    }
  };
}

test('Skinning uses the correct thresholds at level 10, 20 and 21', () => {
  const {enter} = calculator();
  for (const [level, required] of [[1,1],[10,1],[11,10],[17,70],[19,90],[20,100],[21,105],[60,300],[63,315]]) {
    assert.deepEqual(enter('level', level), [String(required), undefined], 'Mob level '+level);
  }
});

test('Skinning skill rounds down to a mob level and accepts bonuses above 300', () => {
  const {enter} = calculator();
  assert.deepEqual(enter('skill', 0), ['Learn Skinning first', undefined]);
  for (const [skill, level] of [[1,10],[9,10],[10,11],[53,15],[99,19],[100,20],[104,20],[105,21],[300,60],[310,62],[315,63],[320,63]]) {
    assert.deepEqual(enter('skill', skill), [String(level), undefined], 'Skinning skill '+skill);
  }
});

test('clearing or invalidating an input clears the previous result', () => {
  const {enter} = calculator();
  enter('level', 17);
  assert.deepEqual(enter('level', 64, {valid: false}), ['—', 'true']);
  assert.deepEqual(enter('level', ''), ['—', undefined]);
  enter('skill', 53);
  assert.deepEqual(enter('skill', 53.5, {valid: false}), ['—', 'true']);
  assert.deepEqual(enter('skill', '', {valid: false, badInput: true}), ['—', 'true']);
  assert.deepEqual(enter('skill', ''), ['—', undefined]);
});

test('skill-up colour ranges cover skinnable mobs and mark the levels still locked', () => {
  const {enter, ranges} = calculator();
  assert.equal(ranges(), null);
  enter('skill', 53);
  assert.deepEqual(ranges(), {
    orange: 'Levels 13–15',
    yellow: 'Levels 11–12',
    green: 'Levels 1–10',
    red: 'Levels 16–63'
  });
  enter('skill', 105);
  assert.deepEqual(ranges(), {
    orange: 'Levels 19–21',
    yellow: 'Levels 16–18',
    green: 'Levels 11–15',
    grey: 'Levels 1–10',
    red: 'Levels 22–63'
  });
  enter('skill', 315);
  assert.equal(ranges().red, undefined);
  enter('skill', 0);
  assert.equal(ranges(), null);
  enter('skill', 53);
  enter('skill', '', {valid: false, badInput: true});
  assert.equal(ranges(), null);
});

test('the exact 25, 50 and 100 point gaps move a mob into the next colour', () => {
  const {enter, ranges} = calculator();
  for (const [skill, band] of [[25, 'orange'], [26, 'yellow'], [51, 'green'], [101, 'grey']]) {
    enter('skill', skill);
    assert.match(ranges()[band], /^Levels 1–/, 'Skinning skill '+skill);
  }
  enter('skill', 10);
  assert.equal(ranges().red, 'Levels 12–63');
  enter('skill', 34);
  assert.equal(ranges().orange, 'Levels 11–13');
});
