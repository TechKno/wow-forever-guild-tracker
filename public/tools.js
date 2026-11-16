(() => {
  'use strict';

  function requiredSkinning(level) {
    if (level <= 10) return 1;
    if (level <= 20) return (level - 10) * 10;
    return level * 5;
  }

  function highestMobLevel(skill, maxLevel) {
    if (skill === 0) return 'Learn Skinning first';
    if (skill < 100) return Math.floor(skill / 10) + 10;
    return Math.min(maxLevel, Math.floor(skill / 5));
  }

  // Community colour estimates use the gap above the mob's minimum skill.
  const skinningBands = [
    ['red', 0], ['orange', 25], ['yellow', 50], ['green', 100], ['grey', Infinity]
  ];

  function renderSkinningRanges(section, skill, maxLevel) {
    section.hidden = !(skill > 0);
    if (section.hidden) return;

    const ranges = new Map();
    for (let level = 1; level <= maxLevel; level++) {
      const gap = skill - requiredSkinning(level);
      const [band] = skinningBands.find(([, cutoff]) => gap < cutoff);
      const range = ranges.get(band);
      if (range) range.last = level;
      else ranges.set(band, {first: level, last: level});
    }

    for (const row of section.querySelectorAll('[data-skinning-band]')) {
      const range = ranges.get(row.dataset.skinningBand);
      row.hidden = !range;
      if (range) {
        row.querySelector('dd').textContent = range.first === range.last
          ? `Level ${range.first}`
          : `Levels ${range.first}–${range.last}`;
      }
    }
  }

  function bindCalculator(input, render) {
    function update() {
      const value = input.valueAsNumber;
      const empty = input.value === '' && !input.validity.badInput;
      const valid = !empty && input.validity.valid && Number.isSafeInteger(value);
      if (!empty && !valid) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      render(valid ? value : null);
    }

    input.addEventListener('input', update);
    update();
  }

  const level = document.getElementById('skinning-mob-level');
  const skill = document.getElementById('skinning-current-skill');
  const required = document.getElementById('skinning-required');
  const highest = document.getElementById('skinning-highest');
  const ranges = document.getElementById('skinning-ranges');
  const maxLevel = Number(level.max);
  bindCalculator(level, value => {
    required.textContent = value === null ? '—' : String(requiredSkinning(value));
  });
  bindCalculator(skill, value => {
    highest.textContent = value === null ? '—' : String(highestMobLevel(value, maxLevel));
    renderSkinningRanges(ranges, value, maxLevel);
  });
})();
