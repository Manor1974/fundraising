const EVENT_ID = location.pathname.split('/').filter(Boolean).pop();
const PIN_KEY = `pin:event:${EVENT_ID}`;

const els = {
  pinScreen: document.getElementById('pinScreen'),
  pinInput: document.getElementById('pinInput'),
  pinBtn: document.getElementById('pinBtn'),
  pinErr: document.getElementById('pinErr'),
  entryView: document.getElementById('entryView'),
  evtTitle: document.getElementById('evtTitle'),
  evtMeta: document.getElementById('evtMeta'),
  grid: document.getElementById('grid'),
  connState: document.getElementById('connState'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modalTitle'),
  ticketInput: document.getElementById('ticketInput'),
  descInput: document.getElementById('descInput'),
  pickedInput: document.getElementById('pickedInput'),
  saveBtn: document.getElementById('saveBtn'),
  clearBtn: document.getElementById('clearBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  displayLink: document.getElementById('displayLink'),
  listLink: document.getElementById('listLink'),
  adjustCountBtn: document.getElementById('adjustCountBtn'),
};

let pin = sessionStorage.getItem(PIN_KEY) || '';
let event = null;
let baskets = [];
let editing = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

async function unlock() {
  const value = els.pinInput.value.trim();
  els.pinErr.style.display = 'none';
  const res = await fetch(`/api/events/${EVENT_ID}/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: value }),
  });
  if (!res.ok) {
    els.pinErr.style.display = 'block';
    els.pinInput.select();
    return;
  }
  pin = value;
  sessionStorage.setItem(PIN_KEY, pin);
  await boot();
}

async function boot() {
  const res = await fetch(`/api/events/${EVENT_ID}`, { headers: { 'x-pin': pin } });
  if (!res.ok) {
    sessionStorage.removeItem(PIN_KEY);
    pin = '';
    showPin();
    return;
  }
  event = await res.json();
  els.pinScreen.style.display = 'none';
  els.entryView.style.display = '';
  els.evtTitle.textContent = event.name;
  els.evtMeta.textContent = `${event.organization || ''}${event.organization ? ' · ' : ''}${event.event_date}${event.event_time ? ' · ' + event.event_time : ''} · ${event.basket_count} baskets`;
  els.displayLink.href = `/display/${EVENT_ID}`;
  els.listLink.href = `/raffle/${EVENT_ID}`;
  await loadBaskets();
  startStream();
}

function showPin() {
  els.pinScreen.style.display = '';
  els.entryView.style.display = 'none';
  els.pinInput.focus();
}

async function loadBaskets() {
  const r = await fetch(`/api/events/${EVENT_ID}/baskets`);
  baskets = await r.json();
  render();
}

function render() {
  els.grid.innerHTML = baskets.map(b => {
    const has = b.ticket_number;
    const status = has
      ? (b.picked_up ? `<span class="status picked">Picked</span>` : `<span class="status waiting">Waiting</span>`)
      : '';
    return `
      <div class="basket-cell" data-num="${b.basket_number}">
        <div class="num">Basket #${b.basket_number}</div>
        <div class="ticket ${has ? '' : 'empty'}">${has ? escapeHtml(b.ticket_number) : 'Tap to enter'}</div>
        ${b.description ? `<div class="desc">${escapeHtml(b.description)}</div>` : ''}
        ${status}
      </div>
    `;
  }).join('');
  for (const cell of els.grid.children) {
    cell.addEventListener('click', () => openModal(parseInt(cell.dataset.num, 10)));
  }
}

function openModal(num) {
  const b = baskets.find(x => x.basket_number === num);
  editing = num;
  els.modalTitle.textContent = `Basket #${num}`;
  els.ticketInput.value = b.ticket_number || '';
  els.descInput.value = b.description || '';
  els.pickedInput.checked = !!b.picked_up;
  els.modal.classList.add('open');
  setTimeout(() => els.ticketInput.focus(), 30);
}

function closeModal() {
  editing = null;
  els.modal.classList.remove('open');
}

async function save() {
  if (editing == null) return;
  const body = {
    ticket_number: els.ticketInput.value.trim(),
    description: els.descInput.value.trim(),
    picked_up: els.pickedInput.checked,
  };
  els.saveBtn.disabled = true;
  try {
    const r = await fetch(`/api/events/${EVENT_ID}/baskets/${editing}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-pin': pin },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Save failed');
    const updated = await r.json();
    const idx = baskets.findIndex(x => x.basket_number === updated.basket_number);
    if (idx >= 0) baskets[idx] = updated;
    render();
    closeModal();
  } catch (e) {
    alert(e.message);
  } finally {
    els.saveBtn.disabled = false;
  }
}

function clearTicket() {
  els.ticketInput.value = '';
  els.descInput.value = '';
  els.pickedInput.checked = false;
}

// SSE — keeps grid in sync if multiple admins are editing on different phones
let es = null;
function startStream() {
  if (es) es.close();
  es = new EventSource(`/api/events/${EVENT_ID}/stream`);
  es.onopen = () => { els.connState.textContent = '● live'; els.connState.style.color = 'var(--good)'; };
  es.onerror = () => { els.connState.textContent = '● reconnecting'; els.connState.style.color = 'var(--warn)'; };
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'basket') {
        const idx = baskets.findIndex(x => x.basket_number === msg.basket.basket_number);
        if (idx >= 0) {
          baskets[idx] = msg.basket;
          render();
        }
      } else if (msg.type === 'event-update') {
        loadBaskets();
      }
    } catch {}
  };
}

async function adjustBasketCount() {
  const current = baskets.length;
  const input = prompt(`How many baskets total?\n\nCurrent: ${current}\nMin 1, max 200.`, current);
  if (input == null) return;
  const newCount = parseInt(input, 10);
  if (!Number.isFinite(newCount) || newCount < 1 || newCount > 200) {
    alert('Please enter a number between 1 and 200.');
    return;
  }
  if (newCount === current) return;

  const body = { basket_count: newCount };
  let res = await fetch(`/api/events/${EVENT_ID}/basket-count`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-pin': pin },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    const data = await res.json();
    const ok = confirm(`${data.error}.\n\nRemove them anyway? (Their winning numbers will be erased.)`);
    if (!ok) return;
    body.force = true;
    res = await fetch(`/api/events/${EVENT_ID}/basket-count`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-pin': pin },
      body: JSON.stringify(body),
    });
  }
  if (!res.ok) {
    alert((await res.json()).error || 'Update failed');
    return;
  }
  await loadBaskets();
}

// Wire up
els.pinBtn.addEventListener('click', unlock);
els.pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
els.saveBtn.addEventListener('click', save);
els.cancelBtn.addEventListener('click', closeModal);
els.clearBtn.addEventListener('click', clearTicket);
els.adjustCountBtn?.addEventListener('click', adjustBasketCount);
els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.modal.classList.contains('open')) closeModal();
  if (e.key === 'Enter' && els.modal.classList.contains('open')) save();
});

// Boot
if (pin) boot();
else showPin();
