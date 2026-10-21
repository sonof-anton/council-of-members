'use strict';

const levels = ['level-1', 'level-2', 'level-3'];

function init() {
  const buttons = document.querySelectorAll('#view-switcher button');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const level = parseInt(btn.dataset.level, 10);
      switchTo(level);
      window.council.setLevel(level);
    });
  });
}

function switchTo(level) {
  // Update buttons
  const buttons = document.querySelectorAll('#view-switcher button');
  buttons.forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.level, 10) === level);
  });

  // Show/hide levels
  levels.forEach((id, i) => {
    const el = document.getElementById(id);
    if (i + 1 === level) {
      el.classList.add('level-active');
    } else {
      el.classList.remove('level-active');
    }
  });
}

module.exports = { init, switchTo };
