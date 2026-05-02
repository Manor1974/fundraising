const EVENT_ID = location.pathname.split('/').filter(Boolean).pop();

const els = {
  title: document.getElementById('dTitle'),
  sub: document.getElementById('dSub'),
  grid: document.getElementById('dGrid'),
  qr: document.getElementById('dQr'),
  orgLogoCard: document.getElementById('orgLogoCard'),
  orgLogo: document.getElementById('dOrgLogo'),
  beneficiarySub: document.getElementById('dBeneficiarySub'),
  beneficiaryTitle: document.getElementById('dBeneficiaryTitle'),
  clock: document.getElementById('dClock'),
};

let event = null;
let baskets = [];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

// Pick best column count for the available 1920x1080 area
function computeGrid(count) {
  const availW = 1920 - 56;
  const availH = 1080 - 220 - 150 - 44;
  const gap = 14;

  let best = { cols: 10, rows: 6, score: -Infinity, cellW: 160, cellH: 110 };
  for (let cols = 4; cols <= 16; cols++) {
    const rows = Math.ceil(count / cols);
    if (rows < 1) continue;
    const cellW = (availW - (cols - 1) * gap) / cols;
    const cellH = (availH - (rows - 1) * gap) / rows;
    if (cellW < 90 || cellH < 70) continue;
    const aspect = cellW / cellH;
    const aspectScore = -Math.abs(aspect - 1.5);
    const sizeScore = Math.min(cellW * 0.6, cellH) / 100;
    const fitPenalty = (cols * rows - count) * 0.02;
    const score = aspectScore * 1.5 + sizeScore - fitPenalty;
    if (score > best.score) best = { cols, rows, cellW, cellH, score };
  }
  return best;
}

function bigFontSize(cellW, cellH, len, headerH) {
  const padX = 18;
  const padY = 16;
  const widthBound = (cellW - padX) / Math.max(len, 1) / 0.62;
  const bodyH = cellH - headerH - padY;
  const heightBound = bodyH;
  return Math.floor(Math.max(20, Math.min(widthBound, heightBound) * 0.95));
}

function headerFontSize(cellW) {
  // "BASKET #999" max ~11 chars; fit it into the cell width with some padding
  return Math.floor(Math.max(11, Math.min(22, cellW / 11)));
}

function render() {
  if (!baskets.length) return;
  const layout = computeGrid(baskets.length);
  els.grid.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
  els.grid.style.gridAutoRows = `${Math.floor(layout.cellH)}px`;

  const hFs = headerFontSize(layout.cellW);
  const headerH = Math.ceil(hFs * 1.6 + 8); // header padding
  const maxLen = baskets.reduce((m, b) => {
    const text = b.ticket_number ? String(b.ticket_number) : '—';
    return Math.max(m, text.length);
  }, 1);
  const fontSize = bigFontSize(layout.cellW, layout.cellH, maxLen, headerH);

  const labelMap = { big: 'BIG TICKET', special: 'SPECIAL' };
  els.grid.innerHTML = baskets.map(b => {
    const has = !!b.ticket_number;
    const catCls = b.category ? ` cat-${b.category}` : '';
    const cls = (has ? 'has' : 'empty') + (b.picked_up ? ' picked' : '') + catCls;
    const big = has ? escapeHtml(b.ticket_number) : '—';
    const checkIcon = b.picked_up ? `<span class="pick-icon" aria-label="Picked up">✓</span>` : '';
    const label = labelMap[b.category] || 'BASKET';
    const num = b.display_number ?? b.basket_number;
    return `
      <div class="dcell ${cls}" data-num="${b.basket_number}">
        <div class="basket-header" style="font-size:${hFs}px">
          <span>${label} #${num}</span>${checkIcon}
        </div>
        <div class="dbig" style="font-size:${fontSize}px">${big}</div>
      </div>
    `;
  }).join('');
}

function flashCell(basketNum) {
  const cell = els.grid.querySelector(`.dcell[data-num="${basketNum}"]`);
  if (!cell) return;
  cell.classList.remove('flash');
  void cell.offsetWidth;
  cell.classList.add('flash');
}

async function loadEvent() {
  const r = await fetch(`/api/events/${EVENT_ID}`);
  if (!r.ok) {
    els.title.textContent = 'Event not found';
    return;
  }
  event = await r.json();
  els.title.textContent = (event.name || 'BASKET RAFFLE').toUpperCase();

  const subParts = [fmtDate(event.event_date), event.event_time].filter(Boolean);
  els.sub.textContent = `${event.basket_count} CHANCES TO WIN${subParts.length ? ' · ' + subParts.join(' · ') : ''}`;

  if (event.organization) {
    els.beneficiaryTitle.textContent = 'ALL PROCEEDS BENEFIT';
    els.beneficiarySub.textContent = event.organization;
  }

  if (event.org_logo) {
    els.orgLogo.src = `/uploads/${event.org_logo}`;
    els.orgLogoCard.style.display = '';
  }
  els.qr.src = `/qr/${EVENT_ID}.png?v=${Date.now()}`;
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
        const wasEmpty = idx >= 0 && !baskets[idx].ticket_number;
        if (idx >= 0) baskets[idx] = msg.basket;
        render();
        if (msg.basket.ticket_number && wasEmpty) flashCell(msg.basket.basket_number);
      } else if (msg.type === 'event-update') {
        loadEvent(); loadBaskets();
      }
    } catch {}
  };
}

function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Fit the 1920x1080 stage to whatever viewport we're rendered into
// (OptiSigns native = 1.0; preview/laptop = scaled down)
function fitDisplay() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.documentElement.style.setProperty('--display-scale', s.toString());
}
window.addEventListener('resize', fitDisplay);
fitDisplay();

// OptiSigns Chromium WebView memory-leak defense: hard-reload every 4 hours
const RELOAD_AFTER_MS = 4 * 60 * 60 * 1000;
setTimeout(() => location.reload(), RELOAD_AFTER_MS);

(async function boot() {
  await loadEvent();
  await loadBaskets();
  startStream();
  tickClock();
  setInterval(tickClock, 30 * 1000);
})();
