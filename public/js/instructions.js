const EVENT_ID = location.pathname.split('/').filter(Boolean).pop();
const PIN_KEY = `pin:event:${EVENT_ID}`;

const els = {
  pinScreen: document.getElementById('pinScreen'),
  pinInput: document.getElementById('pinInput'),
  pinBtn: document.getElementById('pinBtn'),
  pinErr: document.getElementById('pinErr'),
  toolbar: document.getElementById('toolbar'),
  printBtn: document.getElementById('printBtn'),
  sheet: document.getElementById('sheet'),
  ihEventName: document.getElementById('ihEventName'),
  ihMeta: document.getElementById('ihMeta'),
  ihOrgLogo: document.getElementById('ihOrgLogo'),
  adminUrl: document.getElementById('adminUrl'),
  adminPin: document.getElementById('adminPin'),
  adminQr: document.getElementById('adminQr'),
  custUrl: document.getElementById('custUrl'),
};

let pin = sessionStorage.getItem(PIN_KEY) || '';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
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
  const event = await res.json();
  if (!event.pin) {
    // Server didn't return pin — wrong auth
    sessionStorage.removeItem(PIN_KEY);
    pin = '';
    showPin();
    return;
  }
  els.pinScreen.style.display = 'none';
  els.toolbar.style.display = 'block';
  els.sheet.style.display = 'block';

  els.ihEventName.textContent = event.name;
  const meta = [event.organization, fmtDate(event.event_date), event.event_time].filter(Boolean);
  els.ihMeta.textContent = meta.join(' · ');

  if (event.org_logo) {
    els.ihOrgLogo.src = `/uploads/${event.org_logo}`;
    els.ihOrgLogo.style.display = '';
  }

  const base = `${location.protocol}//${location.host}`;
  els.adminUrl.textContent = `${base}/admin/${EVENT_ID}`;
  els.adminPin.textContent = event.pin;
  els.adminQr.src = `/qr/${EVENT_ID}.png?target=admin&v=${Date.now()}`;
  els.custUrl.textContent = `${base}/raffle/${EVENT_ID}`;

  document.title = `${event.name} · Instructions`;
}

function showPin() {
  els.pinScreen.style.display = '';
  els.toolbar.style.display = 'none';
  els.sheet.style.display = 'none';
  els.pinInput.focus();
}

els.pinBtn.addEventListener('click', unlock);
els.pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
els.printBtn.addEventListener('click', () => window.print());

if (pin) boot(); else showPin();
