/** Accessible number fields with click steppers and vertical pointer scrubbing. */
export function enhanceNumberInputs(root = document) {
  for (const input of root.querySelectorAll('input[type="number"]')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'number-input';
    input.before(wrapper); wrapper.append(input);
    const name = input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim() || input.id;
    const controls = document.createElement('span'); controls.className = 'number-controls';
    if (input.dataset.unit) {
      const unit = document.createElement('span'); unit.className = 'number-unit';
      unit.textContent = input.dataset.unit; wrapper.append(unit); wrapper.classList.add('has-unit');
    }
    wrapper.append(controls);
    let lastValid = input.value;
    const step = () => Number(input.step) || 1;
    const bounded = value => Math.max(input.min === '' ? -Infinity : Number(input.min),
      Math.min(input.max === '' ? Infinity : Number(input.max), value));
    const assign = value => {
      input.value = String(Number(bounded(value).toFixed(4)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    input.addEventListener('input', () => {
      if (input.value !== '' && Number.isFinite(input.valueAsNumber)
        && input.valueAsNumber === bounded(input.valueAsNumber)) lastValid = input.value;
    });
    input.addEventListener('change', () => {
      if (input.value === '' && !input.required) return;
      const value = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : Number(lastValid || input.min || 0);
      if (input.value === '' || value !== bounded(value)) assign(value);
    }, true);
    for (const direction of [1, -1]) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'number-stepper'; button.dataset.direction = direction;
      button.setAttribute('aria-label', `${direction > 0 ? '增加' : '减少'}${name}`);
      button.title = '点击增减；按住并上下拖动调节；Shift 加快，Alt 放慢';
      button.innerHTML = `<span class="step-arrow ${direction < 0 ? 'down' : ''}" aria-hidden="true"></span>`;
      controls.append(button);
      let drag = null, suppressClick = false;
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || input.disabled) return;
        event.preventDefault();
        drag = { id: event.pointerId, y: event.clientY, value: input.valueAsNumber || Number(input.min) || 0, moved: false };
        button.setPointerCapture(event.pointerId);
      });
      button.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        const distance = drag.y - event.clientY;
        if (Math.abs(distance) < 4 && !drag.moved) return;
        drag.moved = true; wrapper.classList.add('scrubbing');
        assign(drag.value + Math.trunc(distance / (event.altKey ? 12 : 4)) * step() * (event.shiftKey ? 10 : 1));
      });
      const finish = event => {
        if (!drag || event.pointerId !== drag.id) return;
        suppressClick = drag.moved;
        if (drag.moved) input.dispatchEvent(new Event('change', { bubbles: true }));
        drag = null; wrapper.classList.remove('scrubbing');
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
        setTimeout(() => { suppressClick = false; }, 0);
      };
      button.addEventListener('pointerup', finish);
      button.addEventListener('pointercancel', finish);
      button.addEventListener('lostpointercapture', finish);
      button.addEventListener('click', event => {
        if (suppressClick || input.disabled) return;
        assign((input.valueAsNumber || Number(input.min) || 0) + direction * step() * (event.shiftKey ? 10 : 1));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }
}
