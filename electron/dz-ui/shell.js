/* Clinixos — injection des Modules DZ dans le menu latéral principal.
   Le frontend React est un bundle compilé : on étend le DOM de façon non destructive. */
(function () {
  if (window.__dzShell) return;
  window.__dzShell = true;

  var MODULES = [
    { key: 'dz-file', label: "File d'attente", page: '/dz/file.html', title: 'Tickets, appel salle, écran TV',
      icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
    { key: 'dz-poso', label: 'Posologie & ANPP', page: '/dz/posologie.html', title: 'Doses pédiatriques, DDI, équivalents',
      icon: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>' },
    { key: 'dz-docs', label: 'Médico-légal', page: '/dz/docs.html', title: 'Arrêts, psychotropes, CBV, mutuelles',
      icon: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>' },
    { key: 'dz-caisse', label: 'Caisse DZ', page: '/dz/caisse.html', title: 'Clôture par billets, écarts médecin',
      icon: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01"/><path d="M18 12h.01"/>' },
    { key: 'dz-ingest', label: 'Reprise legacy', page: '/dz/ingest.html', title: 'MedWin / Access → Clinixos',
      icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>' },
    { key: 'dz-backup', label: 'Sauvegarde', page: '/dz/backup.html', title: 'Snapshot chiffré AES-256, USB, R2',
      icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' },
    { key: 'dz-license', label: 'Licence', page: '/dz/license.html', title: 'Activation hors-ligne Ed25519',
      icon: '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>' },
    { key: 'dz-tv', label: 'Écran TV', page: '/tv', title: "Salle d'attente (FR/AR)", external: true,
      icon: '<rect width="20" height="15" x="2" y="7" rx="2"/><polyline points="17 2 12 7 7 2"/>' }
  ];

  var activeKey = null;
  var shell = null, frame = null;
  var origTitle = null, titleEl = null;
  var mainEl = null;
  var navBound = false;

  function icon(paths) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  function ensureShell() {
    if (shell) return shell;
    shell = document.createElement('div');
    shell.id = 'dz-shell';
    shell.setAttribute('aria-hidden', 'true');
    shell.style.cssText = 'position:fixed;z-index:45;display:none;background:var(--page-bg,#F1F5F9);';
    frame = document.createElement('iframe');
    frame.id = 'dz-frame';
    frame.title = 'Module Clinixos';
    frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;';
    shell.appendChild(frame);
    document.body.appendChild(shell);

    window.addEventListener('resize', positionShell);
    // Replacer si l'aside change (collapse/expand)
    var aside = document.querySelector('aside');
    if (aside && window.MutationObserver) {
      new MutationObserver(positionShell).observe(aside, { attributes: true, attributeFilter: ['class'] });
    }
    return shell;
  }

  function positionShell() {
    if (!shell || shell.style.display === 'none') return;
    // Se caler exactement sur la zone <main> de l'app (sous le header, à droite de l'aside).
    var main = (!mainEl || !document.contains(mainEl))
      ? (document.querySelector('main.page') || document.querySelector('main'))
      : mainEl;
    if (main) mainEl = main;
    var aside = document.querySelector('aside');
    var header = document.querySelector('header');
    var left, top, w, h;
    if (main) {
      var r = main.getBoundingClientRect();
      left = r.left; top = r.top; w = r.width; h = r.height;
      // main peut être visibility:hidden mais garde son boîte
      if (w < 40 || h < 40) {
        left = aside ? aside.getBoundingClientRect().right : 0;
        top = header ? header.getBoundingClientRect().bottom : 0;
        w = window.innerWidth - left;
        h = window.innerHeight - top;
      }
    } else {
      left = aside ? aside.getBoundingClientRect().right : 0;
      top = header ? header.getBoundingClientRect().bottom : 0;
      w = window.innerWidth - left;
      h = window.innerHeight - top;
    }
    shell.style.left = left + 'px';
    shell.style.top = top + 'px';
    shell.style.width = w + 'px';
    shell.style.height = h + 'px';
  }

  function setHeaderText(text) {
    var h = document.querySelector('header');
    if (!h) return;
    titleEl = h.querySelector('.text-base.font-black') || h.querySelector('div > div');
    if (titleEl && origTitle === null) origTitle = titleEl.textContent;
    if (titleEl && text) titleEl.textContent = text;
  }

  function updateActive() {
    var buttons = document.querySelectorAll('.dz-btn');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var on = btn.getAttribute('data-dz-key') === activeKey;
      btn.classList.toggle('bg-[#0F4C81]', on);
      btn.classList.toggle('text-white', on);
      btn.classList.toggle('shadow-lg', on);
      btn.classList.toggle('text-slate-300', !on);
      var ind = btn.querySelector('.dz-ind');
      if (ind) ind.style.display = on ? '' : 'none';
    }
    // Désactiver visuellement les entrées React natives
    var nav = document.querySelector('aside nav');
    if (nav) {
      var natives = nav.querySelectorAll('button:not(.dz-btn)');
      for (var j = 0; j < natives.length; j++) {
        var b = natives[j];
        if (activeKey) {
          b.classList.remove('bg-[#0F4C81]', 'text-white', 'shadow-lg');
          b.classList.add('text-slate-300');
          var bi = b.querySelector('span.absolute');
          if (bi) bi.style.visibility = 'hidden';
        }
      }
    }
  }

  function openModule(mod) {
    if (mod.external) {
      window.open(mod.page, '_blank');
      return;
    }
    ensureShell();
    activeKey = mod.key;
    setHeaderText(mod.label);
    if (!mainEl) mainEl = document.querySelector('main.page') || document.querySelector('main');
    if (mainEl) mainEl.style.visibility = 'hidden';
    frame.src = mod.page + (mod.page.indexOf('?') >= 0 ? '&' : '?') + 'embed=1&t=' + Date.now();
    shell.style.display = 'block';
    shell.setAttribute('aria-hidden', 'false');
    positionShell();
    updateActive();
    try { history.replaceState(null, '', '#' + mod.key); } catch (e) {}
  }

  function closeModule() {
    if (!activeKey) return;
    activeKey = null;
    if (shell) {
      shell.style.display = 'none';
      shell.setAttribute('aria-hidden', 'true');
      frame.src = 'about:blank';
    }
    if (mainEl) mainEl.style.visibility = '';
    if (titleEl && origTitle !== null) titleEl.textContent = origTitle;
    updateActive();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }

  function bindNav(nav) {
    if (navBound) return;
    navBound = true;
    nav.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (btn && !btn.classList.contains('dz-btn')) closeModule();
    }, true);
  }

  function injectMenu() {
    var nav = document.querySelector('aside nav');
    if (!nav) return false;
    bindNav(nav);
    if (nav.querySelector('.dz-btn')) { updateActive(); return true; }

    var frag = document.createDocumentFragment();

    var label = document.createElement('div');
    label.className = 'dz-section-label';
    label.textContent = 'Modules Algérie';
    frag.appendChild(label);

    MODULES.forEach(function (mod) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dz-btn group relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition text-slate-300 hover:bg-[#1E293B] hover:text-white';
      btn.title = mod.title || mod.label;
      btn.setAttribute('data-dz-key', mod.key);
      btn.innerHTML =
        '<span class="dz-ind absolute left-0 h-7 w-1 rounded-r-full bg-[#00B4A6]" style="display:none"></span>' +
        icon(mod.icon) +
        '<span class="flex-1 text-left dz-label">' + mod.label + '</span>';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openModule(mod);
      });
      frag.appendChild(btn);
    });

    nav.appendChild(frag);
    updateActive();
    return true;
  }

  function enforceActive() {
    if (!activeKey) return;
    // React peut re-rendre et réafficher <main> / réécrire le titre du header
    var m = document.querySelector('main.page') || document.querySelector('main');
    if (m) { mainEl = m; m.style.visibility = 'hidden'; }
    var mod = null;
    for (var i = 0; i < MODULES.length; i++) if (MODULES[i].key === activeKey) mod = MODULES[i];
    if (mod) setHeaderText(mod.label);
    positionShell();
    if (shell && shell.style.display !== 'block') {
      shell.style.display = 'block';
      if (frame && mod && frame.src.indexOf('/dz/') === -1) {
        frame.src = mod.page + '?embed=1';
      }
    }
    updateActive();
  }

  function start() {
    injectMenu();
    if (window.MutationObserver) {
      var timer = null;
      new MutationObserver(function () {
        if (timer) return;
        timer = setTimeout(function () {
          timer = null;
          if (!document.querySelector('aside nav .dz-btn')) injectMenu();
          else updateActive();
          enforceActive();
        }, 120);
      }).observe(document.body, { childList: true, subtree: true });
    }
    if (!document.querySelector('aside nav')) {
      setTimeout(start, 600);
    }
  }

  function boot() {
    // Injection immédiate si le DOM est déjà monté (évite la course avec le screenshot)
    injectMenu();
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
