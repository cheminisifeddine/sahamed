/* SahaMed DZ UI — helper partagé (100% local, zéro dépendance). */
const DZ = {
  token() { return localStorage.getItem('sahamed_http_token'); },
  async rpc(channel, args = []) {
    const h = { 'Content-Type': 'application/json' };
    const t = this.token();
    if (t) h.Authorization = 'Bearer ' + t;
    const r = await fetch('/api', { method: 'POST', headers: h, body: JSON.stringify({ channel, args }) });
    const j = await r.json();
    if (!j.ok && /Session expir/i.test(j.error || '')) { location.href = '/'; throw new Error('Session expirée'); }
    if (!j.ok) throw new Error(j.error || 'Erreur');
    return j.data;
  },
  esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
  money(n) { return Number(n || 0).toLocaleString('fr-DZ') + ' DZD'; },
  toast(msg, ok = true) {
    let t = document.getElementById('dz-toast');
    if (!t) { t = document.createElement('div'); t.id = 'dz-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.background = ok ? '#166534' : '#991b1b';
    t.style.display = 'block';
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.style.display = 'none', 3500);
  },
  async licenseChip(el) {
    try {
      const r = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'guard:status', args: [] }) });
      const j = await r.json();
      const s = j.data || {};
      el.innerHTML = s.mode === 'bound' ? '✅ Licencié' : `🧪 Essai — ${s.daysLeft ?? '?'} j restants <a href="/dz/license.html">Activer</a>`;
    } catch { el.textContent = ''; }
  }
};
