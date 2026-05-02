const EVENT_ID = location.pathname.split('/').filter(Boolean).pop();

const els = {
  evtName: document.getElementById('evtName'),
  evtWhen: document.getElementById('evtWhen'),
  orgName: document.getElementById('orgName'),
  orgLogo: document.getElementById('orgLogo'),
  list: document.getElementById('list'),
  search: document.getElementById('search'),
  downloadPdf: document.getElementById('downloadPdf'),
};

let event = null;
let baskets = [];
let query = '';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function isMatch(b, q) {
  if (!q) return false;
  const t = (b.ticket_number || '').toString();
  return t.includes(q) || ('#' + b.basket_number).includes(q) || (b.description || '').toLowerCase().includes(q.toLowerCase());
}

function render() {
  const q = query.trim();
  let drawn = baskets.filter(b => b.ticket_number);
  if (!drawn.length) {
    els.list.innerHTML = `<p class="cust-empty">No numbers drawn yet. Check back soon!</p>`;
    return;
  }
  // If searching, filter; else show all in basket-number order
  let rows = drawn;
  if (q) {
    rows = drawn.filter(b => isMatch(b, q));
    if (!rows.length) {
      els.list.innerHTML = `<p class="cust-empty">No match for <strong>${escapeHtml(q)}</strong>.<br>Double-check your ticket number.</p>`;
      return;
    }
  }
  const labelMap = { big: 'Big Ticket', special: 'Special' };
  els.list.innerHTML = rows.map(b => {
    const status = b.picked_up
      ? `<span class="b-status picked">Picked up</span>`
      : `<span class="b-status waiting">Come claim it</span>`;
    const catCls = b.category ? ` cat-${b.category}` : '';
    const label = labelMap[b.category] || 'Basket';
    return `
      <div class="cust-row${catCls} ${q && isMatch(b, q) ? 'hit' : ''}">
        <div class="b-num">${label}<br>#${b.basket_number}</div>
        <div>
          <div class="b-ticket">${escapeHtml(b.ticket_number)}</div>
          ${b.description ? `<span class="b-desc">${escapeHtml(b.description)}</span>` : ''}
        </div>
        ${status}
      </div>
    `;
  }).join('');
}

async function loadEvent() {
  const r = await fetch(`/api/events/${EVENT_ID}`);
  if (!r.ok) {
    els.evtName.textContent = 'Event not found';
    return;
  }
  event = await r.json();
  els.evtName.textContent = event.name;
  if (event.organization) els.orgName.textContent = event.organization;
  const subParts = [fmtDate(event.event_date), event.event_time].filter(Boolean);
  els.evtWhen.textContent = subParts.join(' · ');
  if (event.org_logo) {
    els.orgLogo.src = `/uploads/${event.org_logo}`;
    els.orgLogo.style.display = '';
  } else {
    els.orgLogo.parentElement.style.display = 'none';
  }
}

async function loadBaskets() {
  const r = await fetch(`/api/events/${EVENT_ID}/baskets`);
  baskets = await r.json();
  render();
}

let es = null;
function startStream() {
  if (es) es.close();
  es = new EventSource(`/api/events/${EVENT_ID}/stream`);
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'basket') {
        const idx = baskets.findIndex(x => x.basket_number === msg.basket.basket_number);
        if (idx >= 0) baskets[idx] = msg.basket;
        render();
      } else if (msg.type === 'event-update') {
        loadEvent(); loadBaskets();
      }
    } catch {}
  };
}

els.search.addEventListener('input', (e) => {
  query = e.target.value;
  render();
});

// Print-to-PDF: just trigger the browser print dialog. Saves as PDF on phones.
els.downloadPdf.addEventListener('click', (e) => {
  e.preventDefault();
  window.print();
});

(async function boot() {
  await loadEvent();
  await loadBaskets();
  startStream();
})();
