// Panel de operación de Parking Center (vanilla JS, sin dependencias).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format((c ?? 0) / 100);
const time = (iso) => iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }) : '';
const dur = (m) => m == null ? '' : `${Math.floor(m / 60)} h ${m % 60} min`;
const CAT = { subscriber: 'Abonado', whitelist: 'Lista blanca', blacklist: 'Lista negra', visitor: 'Rotación' };
const DEC = { open: 'Abierta', deny: 'Denegada', ok: 'OK', error: 'Error', ignored: 'Ignorada', paid: 'Pagado', close: 'Cerrar', stay_cancelled: 'Anulada' };
const TYPE = { entry: 'Entrada', exit: 'Salida', manual: 'Manual', payment: 'Pago', barrier_open: 'Barrera abierta', barrier_close: 'Barrera cerrada', barrier_error: 'Error barrera', read: 'Lectura' };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts, headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || `Error ${res.status}`); throw new Error(data.error); }
  return data;
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());
const state = { lanes: [], devices: [], zones: [], drivers: [] };

// ---------- Pestañas ----------
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === b.dataset.tab));
  loaders[b.dataset.tab]?.();
  try { localStorage.setItem('tab', b.dataset.tab); } catch {}
}));

// ---------- Panel ----------
async function loadDashboard() {
  const [st, lanes, events] = await Promise.all([api('/status'), api('/lanes'), api('/events?limit=50')]);
  state.lanes = lanes;
  const pct = st.capacity ? Math.round((st.total / st.capacity) * 100) : 0;
  $('#kpis').innerHTML = `
    <div class="card kpi"><div class="l">Ocupación total</div><div class="v">${st.total} / ${st.capacity}</div><div class="bar"><i style="width:${pct}%"></i></div></div>
    <div class="card kpi"><div class="l">Plazas libres</div><div class="v">${Math.max(0, st.capacity - st.total)}</div></div>
    ${st.zones.map((z) => `<div class="card kpi"><div class="l">${esc(z.name)}</div><div class="v">${z.occupied} / ${z.capacity}</div>
      <div class="bar"><i style="width:${z.capacity ? Math.round((z.occupied / z.capacity) * 100) : 0}%"></i></div></div>`).join('')}`;
  $('#lane-cards').innerHTML = lanes.map((l) => `
    <div class="card lane" data-lane="${esc(l.id)}">
      <h3>${esc(l.name)}</h3><div class="m">${l.direction === 'entry' ? 'Entrada' : 'Salida'} · ${esc(l.id)}</div>
      <form class="read"><input name="plate" placeholder="Matrícula" required><button>Leer</button></form>
      <div class="actions"><button class="ghost" data-act="open">Abrir barrera</button><button class="ghost" data-act="close">Cerrar</button></div>
    </div>`).join('') || '<p class="hint">No hay carriles configurados.</p>';
  $('#events').innerHTML = events.map(eventRow).join('');
}

function eventRow(e) {
  const lane = state.lanes.find((l) => l.id === e.lane_id || l.id === e.laneId);
  return `<tr><td>${time(e.ts)}</td><td>${TYPE[e.type] ?? esc(e.type)}</td><td><b>${esc(e.plate)}</b></td>
    <td>${esc(lane?.name ?? e.lane_id ?? e.laneId ?? '')}</td><td class="${esc(e.decision)}">${DEC[e.decision] ?? esc(e.decision)}</td><td>${esc(e.reason)}</td></tr>`;
}

$('#lane-cards').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const laneId = ev.target.closest('.lane').dataset.lane;
  const r = await api(`/lanes/${laneId}/read`, { method: 'POST', body: formData(ev.target) });
  ev.target.reset();
  toast(r.plate ? `${r.plate}: ${r.reason}` : 'Lectura duplicada ignorada');
});
$('#lane-cards').addEventListener('click', async (ev) => {
  const act = ev.target.dataset.act; if (!act) return;
  const laneId = ev.target.closest('.lane').dataset.lane;
  await api(`/lanes/${laneId}/${act}`, { method: 'POST', body: {} });
  toast(act === 'open' ? 'Orden de apertura enviada' : 'Orden de cierre enviada');
});

// ---------- Tiempo real ----------
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('#live').textContent = '● en directo'; $('#live').classList.add('on'); };
  es.onerror = () => { $('#live').textContent = '● reconectando'; $('#live').classList.remove('on'); };
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    const tb = $('#events');
    tb.insertAdjacentHTML('afterbegin', eventRow(e));
    tb.firstElementChild.classList.add('flash');
    while (tb.children.length > 100) tb.lastElementChild.remove();
    if (['entry', 'exit', 'payment', 'manual'].includes(e.type)) {
      clearTimeout(connectStream.t);
      connectStream.t = setTimeout(() => { refreshKpis(); if ($('#stays').classList.contains('active')) loadStays(); }, 300);
    }
  };
}
function refreshKpis() {
  if ($('#dashboard').classList.contains('active')) loadDashboard();
}

// ---------- Estancias ----------
async function loadStays() {
  const q = $('#stay-search').value.trim();
  const rows = await api('/stays' + (q ? `?plate=${encodeURIComponent(q)}` : ''));
  $('#stay-rows').innerHTML = rows.map((s) => `<tr>
    <td><b>${esc(s.plate)}</b></td><td>${CAT[s.category] ?? s.category}</td><td>${esc(s.zone_id)}</td><td>${time(s.entry_at)}</td>
    <td>${dur(s.minutes)}</td><td>${s.status !== 'inside' ? esc(s.status) : s.category === 'visitor' ? (s.due_cents ? money(s.due_cents) : (s.paid_at ? 'Pagado' : '—')) : '—'}</td>
    <td>${s.status === 'inside' ? `${s.category === 'visitor' && s.due_cents ? `<button data-pay="${s.id}">Cobrar</button>` : ''}
      <button class="danger" data-cancel="${s.id}">Anular</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="hint">Sin vehículos</td></tr>';
}
$('#stay-refresh').onclick = loadStays;
$('#stay-search').oninput = () => { clearTimeout(loadStays.t); loadStays.t = setTimeout(loadStays, 250); };
$('#stay-rows').addEventListener('click', async (ev) => {
  const { pay, cancel } = ev.target.dataset;
  if (pay) {
    const q = await api(`/stays/${pay}/quote`);
    if (!confirm(`Cobrar ${money(q.dueCents)} a ${q.stay.plate} (${dur(q.minutes)})?`)) return;
    await api(`/stays/${pay}/pay`, { method: 'POST', body: { method: 'cash' } });
    toast('Pago registrado'); loadStays();
  }
  if (cancel && confirm('¿Anular esta estancia?')) { await api(`/stays/${cancel}/cancel`, { method: 'POST', body: { reason: 'Anulada por operador' } }); loadStays(); }
});

// ---------- Vehículos ----------
async function loadVehicles() {
  const rows = await api('/vehicles');
  $('#vehicle-rows').innerHTML = rows.map((v) => `<tr><td><b>${esc(v.plate)}</b></td><td>${esc(v.owner)}</td><td>${CAT[v.category]}</td>
    <td>${esc(v.valid_from ?? '')} → ${esc(v.valid_to ?? '')}</td><td>${esc(v.notes)}</td>
    <td><button class="ghost" data-edit='${esc(JSON.stringify(v))}'>Editar</button> <button class="danger" data-del="${esc(v.plate)}">Borrar</button></td></tr>`).join('');
}
$('#vehicle-form').onsubmit = async (ev) => { ev.preventDefault(); await api('/vehicles', { method: 'POST', body: formData(ev.target) }); ev.target.reset(); toast('Vehículo guardado'); loadVehicles(); };
$('#vehicle-rows').addEventListener('click', async (ev) => {
  if (ev.target.dataset.del && confirm('¿Borrar vehículo?')) { await api(`/vehicles/${encodeURIComponent(ev.target.dataset.del)}`, { method: 'DELETE' }); loadVehicles(); }
  if (ev.target.dataset.edit) fillForm($('#vehicle-form'), JSON.parse(ev.target.dataset.edit));
});

function fillForm(form, obj) {
  for (const el of form.elements) if (el.name && obj[el.name] !== undefined) el.value = typeof obj[el.name] === 'object' && obj[el.name] !== null ? JSON.stringify(obj[el.name]) : (obj[el.name] ?? '');
}

// ---------- Dispositivos ----------
async function loadDevices() {
  if (!state.drivers.length) {
    state.drivers = await api('/drivers');
    $('#driver-select').innerHTML = state.drivers.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    $('#driver-select').onchange = () => { $('#driver-help').textContent = state.drivers.find((d) => d.id === $('#driver-select').value)?.help ?? ''; };
    $('#driver-select').onchange();
    $('#ingest-url').textContent = `${location.origin}/api/ingest/<ID del dispositivo>`;
  }
  state.devices = await api('/devices');
  $('#device-rows').innerHTML = state.devices.map((d) => `<tr><td>${esc(d.id)}</td><td>${esc(d.name)}</td>
    <td>${esc(state.drivers.find((x) => x.id === d.driver)?.name ?? d.driver)}</td><td>${esc(d.host ?? '')}${d.port ? ':' + d.port : ''}</td>
    <td data-status="${esc(d.id)}">${d.enabled ? '' : 'deshabilitado'}</td>
    <td><button class="ghost" data-test="${esc(d.id)}">Probar</button> <button class="ghost" data-edit='${esc(JSON.stringify(d))}'>Editar</button> <button class="danger" data-del="${esc(d.id)}">Borrar</button></td></tr>`).join('');
}
$('#device-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const d = formData(ev.target);
  try { d.options = d.options ? JSON.parse(d.options) : {}; } catch { return toast('Opciones: JSON inválido'); }
  const exists = state.devices.some((x) => x.id === d.id);
  await api(exists ? `/devices/${encodeURIComponent(d.id)}` : '/devices', { method: exists ? 'PUT' : 'POST', body: d });
  ev.target.reset(); toast('Dispositivo guardado'); loadDevices();
};
$('#device-rows').addEventListener('click', async (ev) => {
  const { test, edit, del } = ev.target.dataset;
  if (test) { const cell = $(`[data-status="${CSS.escape(test)}"]`); cell.textContent = 'probando…'; const r = await api(`/devices/${encodeURIComponent(test)}/test`, { method: 'POST', body: {} }); cell.innerHTML = `<span class="${r.ok ? 'ok' : 'error'}">${r.ok ? 'OK' : 'Fallo'}</span> ${esc(r.info)}`; }
  if (edit) { fillForm($('#device-form'), JSON.parse(edit)); $('#driver-select').onchange(); }
  if (del && confirm('¿Borrar dispositivo?')) { await api(`/devices/${encodeURIComponent(del)}`, { method: 'DELETE' }); loadDevices(); }
});

// ---------- Carriles y zonas ----------
async function loadLanes() {
  const [lanes, devices, zones] = await Promise.all([api('/lanes'), api('/devices'), api('/zones')]);
  Object.assign(state, { lanes, devices, zones });
  const devOpts = '<option value="">—</option>' + devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  $$('.device-select').forEach((s) => (s.innerHTML = devOpts));
  $('#zone-select').innerHTML = '<option value="">—</option>' + zones.map((z) => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
  $('#zone-rows').innerHTML = zones.map((z) => `<tr><td>${esc(z.id)}</td><td>${esc(z.name)}</td><td>${z.capacity}</td>
    <td><button class="ghost" data-edit-zone='${esc(JSON.stringify(z))}'>Editar</button> <button class="danger" data-del-zone="${esc(z.id)}">Borrar</button></td></tr>`).join('');
  const dn = (id) => esc(devices.find((d) => d.id === id)?.name ?? id ?? '');
  $('#lane-rows').innerHTML = lanes.map((l) => `<tr><td>${esc(l.id)}</td><td>${esc(l.name)}</td><td>${l.direction === 'entry' ? 'Entrada' : 'Salida'}</td>
    <td>${dn(l.camera_device_id)}</td><td>${dn(l.barrier_device_id) || '<span class="hint">(la cámara)</span>'}</td><td>${esc(l.zone_id ?? '')}</td>
    <td><button class="ghost" data-edit-lane='${esc(JSON.stringify(l))}'>Editar</button> <button class="danger" data-del-lane="${esc(l.id)}">Borrar</button></td></tr>`).join('');
}
$('#zone-form').onsubmit = async (ev) => { ev.preventDefault(); await api('/zones', { method: 'POST', body: formData(ev.target) }); ev.target.reset(); loadLanes(); };
$('#lane-form').onsubmit = async (ev) => { ev.preventDefault(); await api('/lanes', { method: 'POST', body: formData(ev.target) }); ev.target.reset(); toast('Carril guardado'); loadLanes(); };
$('#lanes').addEventListener('click', async (ev) => {
  const d = ev.target.dataset;
  if (d.editZone) fillForm($('#zone-form'), JSON.parse(d.editZone));
  if (d.editLane) fillForm($('#lane-form'), JSON.parse(d.editLane));
  if (d.delZone && confirm('¿Borrar zona?')) { await api(`/zones/${encodeURIComponent(d.delZone)}`, { method: 'DELETE' }); loadLanes(); }
  if (d.delLane && confirm('¿Borrar carril?')) { await api(`/lanes/${encodeURIComponent(d.delLane)}`, { method: 'DELETE' }); loadLanes(); }
});

// ---------- Configuración ----------
async function loadSettings() {
  const s = await api('/settings');
  for (const el of $('#settings-form').elements) {
    if (!el.name) continue;
    const [g, k] = el.name.split('.');
    if (el.type === 'checkbox') el.checked = !!s[g][k]; else el.value = s[g][k] ?? '';
  }
}
$('#settings-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const body = { tariff: {}, access: {} };
  for (const el of ev.target.elements) {
    if (!el.name) continue;
    const [g, k] = el.name.split('.');
    body[g][k] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  await api('/settings', { method: 'PUT', body }); toast('Configuración guardada');
};

// ---------- Informes ----------
async function loadReports() {
  const today = new Date().toISOString().slice(0, 10);
  if (!$('#rep-from').value) { $('#rep-from').value = today; $('#rep-to').value = today; }
  const r = await api(`/reports/summary?from=${$('#rep-from').value}&to=${$('#rep-to').value}`);
  const k = (l, v) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  $('#rep-kpis').innerHTML = k('Entradas', r.entries) + k('Salidas', r.exits) + k('Recaudación', money(r.revenueCents)) + k('Accesos denegados', r.denied) + k('Errores de barrera', r.barrierErrors);
}
$('#rep-run').onclick = loadReports;

const loaders = { dashboard: loadDashboard, stays: loadStays, vehicles: loadVehicles, devices: loadDevices, lanes: loadLanes, settings: loadSettings, reports: loadReports };

let initial = 'dashboard';
try { initial = localStorage.getItem('tab') || initial; } catch {}
(loaders[initial] ? $(`#tabs [data-tab="${initial}"]`) : $('#tabs button')).click();
if (initial !== 'dashboard') loadDashboard().catch(() => {});
connectStream();
