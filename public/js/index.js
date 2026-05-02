function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

async function load() {
  const res = await fetch('/api/events');
  const events = await res.json();
  const root = document.getElementById('list');
  if (!events.length) {
    root.innerHTML = `<p class="muted">No events yet. Click <strong>+ New Event</strong> to set one up.</p>`;
    return;
  }
  root.innerHTML = events.map(e => `
    <div class="event-card">
      <div class="meta">
        <h3>${escapeHtml(e.name)}</h3>
        <div class="muted">
          ${escapeHtml(e.organization || '')} ${e.organization ? '·' : ''}
          ${fmtDate(e.event_date)}${e.event_time ? ' · ' + escapeHtml(e.event_time) : ''}
          · ${e.basket_count} baskets
        </div>
      </div>
      <div class="links">
        <a href="/admin/${e.id}">Entry</a>
        <a href="/display/${e.id}" target="_blank">Display</a>
        <a href="/raffle/${e.id}" target="_blank">Customer List</a>
      </div>
    </div>
  `).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

load();
