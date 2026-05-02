const form = document.getElementById('form');
const statusEl = document.getElementById('status');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = 'Creating…';
  const fd = new FormData(form);
  try {
    const res = await fetch('/api/events', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    statusEl.textContent = `Created! PIN: ${data.pin}`;
    setTimeout(() => { window.location.href = `/admin/${data.id}`; }, 700);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});
