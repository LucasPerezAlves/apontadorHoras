// ==UserScript==
// @name         Clockin ← Apontador de Horas
// @namespace    lpalves.apontador-horas
// @version      1.0.1
// @description  Botão "Importar do Apontador" no Clockin: busca suas sessões do Azure (via ApontadorHoras.exe) e lança no Clockin pelo próprio formulário.
// @match        https://clockin.intranet.premiersoft.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return;

  const BRIDGE = 'http://127.0.0.1:47321/api/export';
  const DEFAULT_PROJECT = 'Tucano | Alocação - Bionexo';
  const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  const pad = (n) => String(n).padStart(2, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtH = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h${pad(m % 60)}`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Sessões já lançadas por este botão (para não duplicar)
  const imported = () => GM_getValue('imported', {});
  const markImported = (key) => { const m = imported(); m[key] = Date.now(); GM_setValue('imported', m); };
  const unmarkImported = (key) => { const m = imported(); delete m[key]; GM_setValue('imported', m); };

  function fetchSessions(from, to) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${BRIDGE}?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
        headers: { 'X-Apontador-Bridge': 'clockin' },
        timeout: 60000,
        onload: (r) => {
          let j = null;
          try { j = JSON.parse(r.responseText); } catch { /* ignore */ }
          if (r.status >= 200 && r.status < 300 && j) resolve(j);
          else reject(new Error((j && j.message) || `Apontador respondeu ${r.status}`));
        },
        onerror: () => reject(new Error('Não encontrei o Apontador de Horas. Abra o ApontadorHoras.exe e tente de novo.')),
        ontimeout: () => reject(new Error('O Apontador demorou demais para responder.')),
      });
    });
  }

  // ───────── Preenchimento do formulário do Clockin ─────────
  function setNative(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === txt);
  async function waitFor(fn, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); }
    return null;
  }
  async function selectProject(name) {
    const trig = await waitFor(() => document.querySelector('main [role=combobox], [role=combobox]'));
    if (!trig) throw new Error('Não achei o seletor de projeto.');
    if (trig.textContent.trim() === name) return;
    trig.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    const opt = await waitFor(() => [...document.querySelectorAll('[role=option]')].find((o) => o.textContent.trim() === name), 3000);
    if (!opt) {
      const avail = [...document.querySelectorAll('[role=option]')].map((o) => o.textContent.trim()).join(', ');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      throw new Error(`Projeto "${name}" não encontrado. Disponíveis: ${avail || 'nenhum'}`);
    }
    opt.focus();
    opt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(250);
    if (trig.textContent.trim() !== name) throw new Error('Não consegui selecionar o projeto.');
  }
  function waitToast(ms = 12000) {
    return new Promise((resolve) => {
      const seen = new Set(document.querySelectorAll('[data-sonner-toast]'));
      const done = (v) => { obs.disconnect(); clearTimeout(timer); resolve(v); };
      const check = () => {
        for (const t of document.querySelectorAll('[data-sonner-toast]')) {
          if (seen.has(t)) continue;
          const type = t.getAttribute('data-type') || '';
          const text = t.textContent.trim();
          if (type === 'error') return done({ ok: false, text });
          if (type === 'success' || /registrado/i.test(text)) return done({ ok: true, text });
        }
      };
      const obs = new MutationObserver(check);
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-type'] });
      const timer = setTimeout(() => done({ ok: false, text: 'O Clockin não confirmou o lançamento (sem resposta em 12s).' }), ms);
    });
  }
  async function launchOne(s, project) {
    if (location.pathname !== '/timer') throw new Error('Abra a página de Apontamento (/timer).');
    const manual = byText('button', 'Manual');
    if (manual) { manual.click(); await sleep(200); }
    await selectProject(project);
    const st = new Date(s.start), en = new Date(s.end);
    // Na tela larga o Clockin usa um <input> de uma linha; na estreita, um <textarea>
    const ta = document.querySelector('[aria-label="Descrição da atividade"]')
      || document.querySelector('textarea[placeholder*="trabalhando"], input[placeholder*="trabalhando"]')
      || document.querySelector('main textarea');
    const max = ta && ta.maxLength > 0 ? ta.maxLength : 500;
    const desc = `#${s.workItemId} ${s.title}${s.notes ? ` — ${s.notes}` : ''}`.slice(0, max);
    const date = document.querySelector('input[aria-label="Data do apontamento"]') || document.querySelector('input[type=date]');
    const [t1, t2] = [document.querySelector('input[aria-label="Horário inicial"]'), document.querySelector('input[aria-label="Horário final"]')];
    if (!ta || !date || !t1 || !t2) {
      const miss = [!ta && 'descrição', !date && 'data', !t1 && 'início', !t2 && 'fim'].filter(Boolean).join(', ');
      throw new Error(`Não achei no formulário: ${miss}. Nada foi enviado.`);
    }
    setNative(ta, desc);
    setNative(date, ymd(st));
    await sleep(80);
    setNative(t1, hhmm(st));
    await sleep(80);
    setNative(t2, hhmm(en));
    await sleep(250);
    if (date.value !== ymd(st) || t1.value !== hhmm(st) || t2.value !== hhmm(en) || ta.value !== desc) {
      throw new Error('O formulário não aceitou os valores; nada foi enviado.');
    }
    const btn = byText('button', 'Apontar');
    if (!btn || btn.disabled) throw new Error('O botão Apontar está indisponível.');
    const toastP = waitToast();
    btn.click();
    const r = await toastP;
    if (!r.ok) throw new Error(r.text);
    return r.text;
  }

  // ───────── Interface ─────────
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:0;bottom:0;z-index:2147483000;';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  for (const t of ['keydown', 'keyup', 'keypress']) root.addEventListener(t, (e) => e.stopPropagation());
  root.innerHTML = `
<style>
  * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
  .fab { position: fixed; right: 20px; bottom: 20px; border: 0; border-radius: 22px; padding: 11px 16px; background: #4f46e5; color: #fff;
    font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.35); display: none; }
  .fab:hover { background: #4338ca; }
  .bg { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: none; align-items: center; justify-content: center; }
  .bg.on { display: flex; }
  .box { width: min(640px, 94vw); max-height: 88vh; display: flex; flex-direction: column; background: #12131c; color: #e6e8ec; border: 1px solid #2c2f3d; border-radius: 12px; font-size: 13px; }
  .hd { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #2c2f3d; flex-wrap: wrap; }
  .hd h2 { margin: 0 auto 0 0; font-size: 15px; }
  button { background: #222533; color: #e6e8ec; border: 1px solid #353a4d; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 13px; }
  button:hover { background: #2b2f40; }
  button.pri { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .proj { display: flex; gap: 6px; align-items: center; padding: 8px 14px; border-bottom: 1px solid #2c2f3d; }
  .proj input { flex: 1; background: #0b0c12; color: #e6e8ec; border: 1px solid #353a4d; border-radius: 6px; padding: 5px 8px; font-size: 13px; }
  .list { overflow: auto; padding: 6px 14px; flex: 1; }
  .day { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #8b93a3; margin: 10px 0 4px; }
  label.s { display: flex; gap: 8px; align-items: flex-start; padding: 6px; border-radius: 6px; cursor: pointer; }
  label.s:hover { background: #1b1d29; }
  label.s .t { flex: 1; min-width: 0; }
  label.s .t b { font-weight: 600; }
  label.s .m { color: #8b93a3; font-size: 12px; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #14532d; color: #bbf7d0; margin-left: 6px; }
  .tag.warn { background: #713f12; color: #fde68a; }
  .ft { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-top: 1px solid #2c2f3d; }
  .msg { flex: 1; color: #9aa3b2; font-size: 12px; }
  .msg.bad { color: #fca5a5; }
  .empty { color: #8b93a3; padding: 16px 0; }
</style>
<button class="fab">⬇ Importar do Apontador</button>
<div class="bg"><div class="box">
  <div class="hd">
    <h2>Importar do Apontador de Horas</h2>
    <button data-a="prev">‹</button><span class="wk"></span><button data-a="next">›</button>
    <button data-a="close">✕</button>
  </div>
  <div class="proj">Projeto no Clockin: <input class="pj"></div>
  <div class="list"></div>
  <div class="ft"><span class="msg"></span><button data-a="close">Fechar</button><button class="pri" data-a="go" disabled>Lançar</button></div>
</div></div>`;
  const $ = (s) => root.querySelector(s);
  const fab = $('.fab'), bg = $('.bg');
  const st = { week: startOfWeek(new Date()), sessions: [], busy: false };
  $('.pj').value = GM_getValue('project', DEFAULT_PROJECT);
  $('.pj').addEventListener('change', () => GM_setValue('project', $('.pj').value.trim() || DEFAULT_PROJECT));

  setInterval(() => { fab.style.display = location.pathname === '/timer' && !bg.classList.contains('on') ? 'block' : 'none'; }, 500);
  const msg = (t, bad = false) => { const m = $('.msg'); m.textContent = t; m.className = `msg${bad ? ' bad' : ''}`; };

  function renderList() {
    const imp = imported();
    const list = $('.list');
    const end = addDays(st.week, 6);
    $('.wk').textContent = `${pad(st.week.getDate())}/${pad(st.week.getMonth() + 1)} – ${pad(end.getDate())}/${pad(end.getMonth() + 1)}`;
    if (!st.sessions.length) { list.innerHTML = '<div class="empty">Nenhuma sessão fechada sua nesta semana.</div>'; updateGo(); return; }
    let html = '', lastDay = '';
    for (const s of st.sessions) {
      const a = new Date(s.start), b = new Date(s.end);
      const day = `${DAY_NAMES[a.getDay()]} ${pad(a.getDate())}/${pad(a.getMonth() + 1)}`;
      if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }
      const crosses = ymd(a) !== ymd(b);
      const done = !!imp[s.key];
      html += `<label class="s"><input type="checkbox" data-k="${esc(s.key)}" ${done || crosses ? '' : 'checked'} ${crosses ? 'disabled' : ''}>
        <span class="t"><b>${hhmm(a)}–${hhmm(b)}</b> · ${fmtH((b - a) / 36e5)} · #${s.workItemId} ${esc(s.title)}
        ${done ? '<span class="tag">já lançado</span>' : ''}${crosses ? '<span class="tag warn">passa da meia-noite: lance à mão</span>' : ''}
        ${s.notes ? `<div class="m">${esc(s.notes)}</div>` : ''}</span></label>`;
    }
    list.innerHTML = html;
    updateGo();
  }
  function selected() { return [...root.querySelectorAll('input[type=checkbox][data-k]:checked')].map((c) => st.sessions.find((s) => s.key === c.dataset.k)).filter(Boolean); }
  function updateGo() {
    const sel = selected();
    const h = sel.reduce((a, s) => a + (new Date(s.end) - new Date(s.start)) / 36e5, 0);
    $('[data-a=go]').disabled = st.busy || !sel.length;
    $('[data-a=go]').textContent = sel.length ? `Lançar ${sel.length} (${fmtH(h)})` : 'Lançar';
  }
  root.addEventListener('change', (e) => { if (e.target.matches('input[type=checkbox]')) updateGo(); });

  async function load() {
    st.sessions = []; renderList(); msg('Buscando suas sessões no Azure…');
    try {
      const r = await fetchSessions(st.week, addDays(st.week, 7));
      st.sessions = r.sessions || [];
      msg(`${st.sessions.length} sessão(ões) de ${r.email}. Marque as que quer lançar.`);
    } catch (e) { msg(e.message, true); }
    renderList();
  }

  async function go() {
    const sel = selected();
    const project = $('.pj').value.trim() || DEFAULT_PROJECT;
    GM_setValue('project', project);
    st.busy = true; updateGo();
    bg.classList.remove('on');
    let ok = 0;
    try {
      for (const s of sel) {
        fab.style.display = 'block';
        fab.textContent = `Lançando ${ok + 1}/${sel.length}…`;
        await launchOne(s, project);
        markImported(s.key);
        ok++;
        await sleep(700);
      }
      fab.textContent = `✔ ${ok} lançado(s)`;
    } catch (e) {
      bg.classList.add('on');
      renderList();
      msg(`${ok} lançado(s). Parou em uma sessão: ${e.message}`, true);
    } finally {
      st.busy = false; updateGo();
      setTimeout(() => { fab.textContent = '⬇ Importar do Apontador'; }, 4000);
    }
  }

  fab.addEventListener('click', () => { if (st.busy) return; bg.classList.add('on'); load(); });
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'close') bg.classList.remove('on');
    else if (a === 'prev') { st.week = addDays(st.week, -7); load(); }
    else if (a === 'next') { st.week = addDays(st.week, 7); load(); }
    else if (a === 'go') go();
  });
  // Clique direito num item "já lançado" permite lançar de novo, se você tiver apagado no Clockin
  root.addEventListener('contextmenu', (e) => {
    const cb = e.target.closest('label.s')?.querySelector('input[data-k]');
    if (!cb || !imported()[cb.dataset.k]) return;
    e.preventDefault();
    unmarkImported(cb.dataset.k); renderList();
    msg('Marcação de "já lançado" removida para essa sessão.');
  });
})();
