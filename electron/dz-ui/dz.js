/* SahaMed DZ UI — helper partagé (100% local, zéro dépendance). */
(function () {
  // Mode embarqué + thème sombre synchronisé depuis la page parente (shell).
  try {
    if (window.self !== window.top) {
      document.documentElement.classList.add('embed');
      if (parent.document && parent.document.documentElement.classList.contains('dark')) {
        document.documentElement.classList.add('dark');
      }
    }
  } catch (e) { /* cross-origin : on reste en standalone */ }

  const DZ = {
    token() { return localStorage.getItem('sahamed_http_token'); },
    async rpc(channel, args = []) {
      const h = { 'Content-Type': 'application/json' };
      const t = this.token();
      if (t) h.Authorization = 'Bearer ' + t;
      const r = await fetch('/api', { method: 'POST', headers: h, body: JSON.stringify({ channel, args }) });
      const j = await r.json();
      if (!j.ok && /Session expir/i.test(j.error || '')) {
        if (window.self !== window.top) {
          // dans le shell : on laisse l'app principale gérer le lock
          this.toast('Session expirée — reconnectez-vous', false);
          throw new Error('Session expirée');
        }
        location.href = '/';
        throw new Error('Session expirée');
      }
      if (!j.ok) throw new Error(j.error || 'Erreur');
      return j.data;
    },
    esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
    money(n) { return Number(n || 0).toLocaleString('fr-DZ') + ' DZD'; },
    toast(msg, ok = true) {
      let t = document.getElementById('dz-toast');
      if (!t) { t = document.createElement('div'); t.id = 'dz-toast'; document.body.appendChild(t); }
      t.textContent = msg;
      t.style.background = ok ? '#16A34A' : '#DC2626';
      t.style.display = 'block';
      clearTimeout(this._tt);
      this._tt = setTimeout(() => { t.style.display = 'none'; }, 3500);
    },
    /* Construit l'en-tête standalone (masqué en embed via CSS). */
    mountHeader(title, opts = {}) {
      const h = document.createElement('header');
      h.className = 'dz-top';
      h.innerHTML =
        '<a class="back" href="/">← SahaMed</a>' +
        '<h1>' + this.esc(title) + (opts.ar ? ' <span dir="rtl" style="opacity:.75;font-weight:600">' + opts.ar + '</span>' : '') + '</h1>' +
        '<span class="dz-lic" id="lic"></span>';
      document.body.insertBefore(h, document.body.firstChild);
      this.licenseChip(h.querySelector('#lic'));
      return h;
    },
    /* En-tête de page interne (page-title), utilisée en embed + standalone. */
    pageHead(title, subtitle, rightHtml) {
      return '<div class="dz-page-head"><div><div class="page-title">' + this.esc(title) +
        '</div>' + (subtitle ? '<div class="page-subtitle">' + this.esc(subtitle) + '</div>' : '') +
        '</div>' + (rightHtml || '') + '</div>';
    },
    async licenseChip(el) {
      if (!el) return;
      try {
        const r = await fetch('/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'guard:status', args: [] })
        });
        const j = await r.json();
        const s = j.data || {};
        el.innerHTML = s.mode === 'bound'
          ? '✅ Licencié'
          : '🧪 Essai — ' + (s.daysLeft ?? '?') + ' j <a href="/dz/license.html">Activer</a>';
      } catch { el.textContent = ''; }
    }
  };

  window.DZ = DZ;
})();
