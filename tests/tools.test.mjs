import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const script = readFileSync(new URL('../public/tools.js', import.meta.url), 'utf8');

function calculator() {
  const elements = {
    'skinning-mob-level': {max: '63'},
    'skinning-current-skill': {},
    'skinning-required': {},
    'skinning-highest': {}
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
