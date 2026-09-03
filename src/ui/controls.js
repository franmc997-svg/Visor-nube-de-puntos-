// Fabricas de controles del panel. Todo pensado para el dedo: nada por debajo
// de 38 px de alto, y sin menus desplegables nativos (en iOS abren una rueda
// modal que tapa la nube justo cuando quieres ver el efecto del cambio).

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function fila(labelText, valueText) {
  const wrap = el('div', 'fila');
  const label = el('label');
  label.appendChild(el('span', null, labelText));
  const val = el('span', 'val', valueText || '');
  label.appendChild(val);
  wrap.appendChild(label);
  return { wrap, val };
}

/**
 * Deslizador continuo.
 * @param {object} o {label, min, max, value, step, format, onInput, help}
 */
export function slider(o) {
  const { wrap, val } = fila(o.label, o.format ? o.format(o.value) : String(o.value));
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step ?? 'any');
  input.value = String(o.value);
  input.setAttribute('aria-label', o.label);
  const apply = (v) => {
    val.textContent = o.format ? o.format(v) : String(v);
    o.onInput(v);
  };
  input.addEventListener('input', () => apply(Number(input.value)));
  wrap.appendChild(input);
  const nodes = [wrap];
  if (o.help) nodes.push(el('p', 'ayuda', o.help));
  return {
    nodes,
    set(v) { input.value = String(v); val.textContent = o.format ? o.format(v) : String(v); },
    get() { return Number(input.value); },
    nudge(steps) {
      const s = Number(input.step) || (o.max - o.min) / 100;
      const v = Math.min(o.max, Math.max(o.min, Number(input.value) + s * steps));
      input.value = String(v);
      apply(v);
      return v;
    },
  };
}

/** Grupo de botones exclusivos. options = [{id, label, disabled}] */
export function segmentado(o) {
  const wrap = el('div', 'fila');
  if (o.label) {
    const label = el('label');
    label.appendChild(el('span', null, o.label));
    wrap.appendChild(label);
  }
  const group = el('div', 'segmentado');
  group.setAttribute('role', 'group');
  const buttons = new Map();
  for (const opt of o.options) {
    const b = el('button', null, opt.label);
    b.disabled = !!opt.disabled;
    b.addEventListener('click', () => { select(opt.id); o.onChange(opt.id); });
    buttons.set(opt.id, b);
    group.appendChild(b);
  }
  function select(id) {
    for (const [key, b] of buttons) b.classList.toggle('activa', key === id);
  }
  select(o.value);
  wrap.appendChild(group);
  const nodes = [wrap];
  if (o.help) nodes.push(el('p', 'ayuda', o.help));
  return { nodes, select, setDisabled(id, on) { const b = buttons.get(id); if (b) b.disabled = on; } };
}

export function conmutador(o) {
  const wrap = el('div', 'conmutador');
  const label = el('span', null, o.label);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!o.value;
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', o.label);
  input.addEventListener('change', () => o.onChange(input.checked));
  wrap.appendChild(label);
  wrap.appendChild(input);
  const nodes = [wrap];
  if (o.help) nodes.push(el('p', 'ayuda', o.help));
  return { nodes, set(v) { input.checked = v; } };
}

export function boton(label, onClick, cls = 'secundario') {
  const b = el('button', cls, label);
  b.addEventListener('click', onClick);
  return { nodes: [b] };
}

export function bloqueInfo() {
  const div = el('div', 'info');
  return { nodes: [div], set(html) { div.innerHTML = html; } };
}

/** Escala logaritmica 0..1000 <-> [min,max]. Da control fino donde importa. */
export function logMap(min, max) {
  const a = Math.log(min), b = Math.log(max);
  return {
    toValue: (t) => Math.exp(a + (b - a) * (t / 1000)),
    toSlider: (v) => Math.round(1000 * (Math.log(Math.max(min, Math.min(max, v))) - a) / (b - a)),
  };
}

/** Formatea una longitud en metros con la unidad que toca. */
export function formatoLongitud(m) {
  if (m < 0.01) return `${(m * 1000).toFixed(2)} mm`;
  if (m < 1) return `${(m * 100).toFixed(2)} cm`;
  return `${m.toFixed(3)} m`;
}

export function formatoNumero(n) {
  return n.toLocaleString('es-ES');
}
