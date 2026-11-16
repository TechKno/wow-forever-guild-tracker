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

  function bindCalculator(input, output, calculate) {
    function update() {
      const value = input.valueAsNumber;
      const empty = input.value === '' && !input.validity.badInput;
      const valid = !empty && input.validity.valid && Number.isSafeInteger(value);
      if (!empty && !valid) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      output.textContent = valid ? String(calculate(value)) : '—';
    }

    input.addEventListener('input', update);
    update();
  }

  const level = document.getElementById('skinning-mob-level');
  const skill = document.getElementById('skinning-current-skill');
  const maxLevel = Number(level.max);
  bindCalculator(level, document.getElementById('skinning-required'), requiredSkinning);
  bindCalculator(skill, document.getElementById('skinning-highest'), value => highestMobLevel(value, maxLevel));
})();
