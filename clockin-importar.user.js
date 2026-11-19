// ==UserScript==
// @name         Clockin ← Apontador de Horas
// @namespace    lpalves.apontador-horas
// @version      1.2.0
// @description  Sincroniza o Clockin com o Apontador de Horas: compara cada dia, mostra o que muda (editar, criar, excluir) e aplica pelo próprio Clockin.
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
  const MONTHS_PT = { janeiro: 0, fevereiro: 1, 'março': 2, marco: 2, abril: 3, maio: 4, junho: 5, julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11 };

  const DAY_RE = /(\d{1,2}) de (janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i;
  const pad = (n) => String(n).padStart(2, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmtMin = (m) => `${Math.floor(m / 60)}h${pad(m % 60)}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

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

  // ───────── Utilidades de formulário (React/Radix do Clockin) ─────────
  function setNative(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  const byText = (sel, txt, root = document) => [...root.querySelectorAll(sel)].find((b) => b.textContent.trim() === txt);
  async function waitFor(fn, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); }
    return null;
  }
  const projMatch = (listName, target) => {
    const a = norm(listName).toLowerCase(), b = norm(target).toLowerCase();
    return !!a && (a === b || b.endsWith(a) || a.endsWith(b) || b.split('|').pop().trim() === a);
  };
  async function selectProjectIn(trig, name) {
    if (!trig) throw new Error('Não achei o seletor de projeto.');
    if (projMatch(trig.textContent, name)) return;
    trig.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    const opt = await waitFor(() => [...document.querySelectorAll('[role=option]')].find((o) => norm(o.textContent) === norm(name)), 3000);
    if (!opt) {
      const avail = [...document.querySelectorAll('[role=option]')].map((o) => o.textContent.trim()).join(', ');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      throw new Error(`Projeto "${name}" não encontrado. Disponíveis: ${avail || 'nenhum'}`);
    }
    opt.focus();
    opt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(250);
    if (!projMatch(trig.textContent, name)) throw new Error('Não consegui selecionar o projeto.');
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
          if (type === 'success' || /registrado|atualizado/i.test(text)) return done({ ok: true, text });
        }
      };
      const obs = new MutationObserver(check);
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-type'] });
      const timer = setTimeout(() => done({ ok: false, text: 'O Clockin não confirmou (sem resposta em 12s).' }), ms);
    });
  }
  async function openRowMenu(btn) {
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    return await waitFor(() => { const it = [...document.querySelectorAll('[role=menuitem]')]; return it.length ? it : null; }, 3000);
  }
  async function chooseMenu(items, label) {
    const it = items && items.find((i) => i.textContent.trim() === label);
    if (!it) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); throw new Error(`Opção "${label}" indisponível neste apontamento.`); }
    if (it.getAttribute('data-disabled') !== null || it.getAttribute('aria-disabled') === 'true') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      throw new Error(`"${label}" está bloqueado neste apontamento.`);
    }
    it.focus();
    it.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(300);
  }

  // ───────── Leitura da semana mostrada no Clockin ─────────
  const weekLabelEl = () => [...document.querySelectorAll('h1,h2,h3,span,div')].find((e) => e.children.length === 0 && /^\d{2}\/\d{2} – \d{2}\/\d{2}$/.test(e.textContent.trim()));
  async function gotoWeek(weekStart) {
    if (location.pathname !== '/timer') throw new Error('Abra a página de Apontamento (/timer).');
    for (let i = 0; i < 80; i++) {
      const el = await waitFor(weekLabelEl, 5000);
      if (!el) throw new Error('Não achei a semana exibida no Clockin.');
      const [d, m] = el.textContent.trim().slice(0, 5).split('/').map(Number);
      // Ano: o mais próximo da semana desejada
      let shown = new Date(weekStart.getFullYear(), m - 1, d);
      if (shown - weekStart > 180 * 864e5) shown = new Date(weekStart.getFullYear() - 1, m - 1, d);
      if (weekStart - shown > 180 * 864e5) shown = new Date(weekStart.getFullYear() + 1, m - 1, d);
      if (Math.abs(shown - weekStart) < 864e5) { await sleep(400); return; }
      const before = el.textContent;
      const btn = document.querySelector(`button[aria-label="${shown > weekStart ? 'Semana anterior' : 'Próxima semana'}"]`);
      if (!btn) throw new Error('Não achei os botões de semana do Clockin.');
      btn.click();
      await waitFor(() => { const x = weekLabelEl(); return x && x.textContent !== before; }, 5000);
    }
    throw new Error('Não consegui chegar na semana escolhida.');
  }
  function readWeek(weekStart) {
    const days = new Map();
    for (const h of document.querySelectorAll('h4')) {
      const m = h.textContent.match(DAY_RE);
      if (!m || MONTHS_PT[m[2].toLowerCase()] == null) continue;
      let date = null;
      for (let i = 0; i < 7; i++) { const x = addDays(weekStart, i); if (x.getDate() === Number(m[1]) && x.getMonth() === MONTHS_PT[m[2].toLowerCase()]) date = x; }
      if (!date) continue;
      const card = h.parentElement && h.parentElement.parentElement;
      const rows = [];
      for (const t of card ? card.querySelectorAll('.font-mono') : []) {
        const tm = t.textContent.match(/(\d{2}:\d{2})\D+(\d{2}:\d{2})/);
        if (!tm) continue;
        let row = t;
        while (row && row !== card && !row.querySelector('span.font-medium')) row = row.parentElement;
        if (!row || row === card) continue;
        const proj = row.querySelector('span.font-medium');
        const descEl = proj && proj.nextElementSibling;
        const badge = [...row.querySelectorAll('div')].find((x) => /rounded-md border/.test(x.className) && x.children.length === 0);
        const btn = row.querySelector('button[aria-label="Ações do apontamento"]');
        rows.push({
          project: norm(proj ? proj.textContent : ''),
          desc: norm(descEl ? descEl.textContent : '').replace(/^·\s*/, ''),
          start: tm[1], end: tm[2], status: badge ? norm(badge.textContent) : '',
          locked: !btn || /bloqueado/i.test(row.textContent),
        });
      }
      days.set(ymd(date), rows);
    }
    return days;
  }
  // Quantas linhas iguais existem (pode haver lançamentos repetidos idênticos)
  function countRows(weekStart, dateKey, start, end, desc) { return findRows(weekStart, dateKey, start, end, desc).length; }
  function findRow(weekStart, dateKey, start, end, desc) { return findRows(weekStart, dateKey, start, end, desc)[0] || null; }
  function findRows(weekStart, dateKey, start, end, desc) {
    const found = [];
    for (const h of document.querySelectorAll('h4')) {
      const card = h.parentElement && h.parentElement.parentElement;
      if (!card) continue;
      const m = h.textContent.match(DAY_RE);
      if (!m) continue;
      const [, , mo, dd] = dateKey.match(/(\d+)-(\d+)-(\d+)/);
      if (Number(m[1]) !== Number(dd) || MONTHS_PT[m[2].toLowerCase()] !== Number(mo) - 1) continue;
      for (const t of card.querySelectorAll('.font-mono')) {
        const tm = t.textContent.match(/(\d{2}:\d{2})\D+(\d{2}:\d{2})/);
        if (!tm || tm[1] !== start || tm[2] !== end) continue;
        let row = t;
        while (row && row !== card && !row.querySelector('span.font-medium')) row = row.parentElement;
        const d = norm(row.querySelector('span.font-medium')?.nextElementSibling?.textContent || '').replace(/^·\s*/, '');
        if (d === desc) found.push(row);
      }
    }
    return found;
  }

  // ───────── Feriados: o Clockin mostra "Feriado: nome" no título do dia ─────────
  function weekFromLabel() {
    const el = weekLabelEl();
    if (!el) return null;
    const [d, m] = el.textContent.trim().slice(0, 5).split('/').map(Number);
    const now = new Date();
    let w = new Date(now.getFullYear(), m - 1, d);
    if (w - now > 180 * 864e5) w = new Date(now.getFullYear() - 1, m - 1, d);
    if (now - w > 180 * 864e5) w = new Date(now.getFullYear() + 1, m - 1, d);
    return w;
  }
  function scanHolidays(weekStart) {
    const out = [];
    if (!weekStart) return out;
    for (const h of document.querySelectorAll('h4')) {
      const m = h.textContent.match(DAY_RE);
      if (!m) continue;
      const fm = h.textContent.match(/Feriado:\s*(.+)$/i) || (h.parentElement && h.parentElement.textContent.match(/Feriado:\s*(.+?)\s*Total:/i));
      if (!fm) continue;
      for (let i = 0; i < 7; i++) {
        const x = addDays(weekStart, i);
        if (x.getDate() === Number(m[1]) && x.getMonth() === MONTHS_PT[m[2].toLowerCase()]) out.push({ date: ymd(x), name: norm(fm[1]) });
      }
    }
    return out;
  }
  const sentHol = new Set();
  function postHolidays(list) {
    const fresh = list.filter((h) => !sentHol.has(`${h.date}|${h.name}`));
    if (!fresh.length) return Promise.resolve(0);
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST', url: 'http://127.0.0.1:47321/api/holidays/import', timeout: 15000,
        headers: { 'X-Apontador-Bridge': 'clockin', 'Content-Type': 'application/json' },
        data: JSON.stringify({ holidays: fresh }),
        onload: (r) => { if (r.status === 200) fresh.forEach((h) => sentHol.add(`${h.date}|${h.name}`)); resolve(r.status === 200 ? fresh.length : 0); },
        onerror: () => resolve(0), ontimeout: () => resolve(0),
      });
    });
  }
  // Sempre que a semana exibida muda, manda os feriados dela para o Apontador (se ele estiver aberto)
  let lastLabel = '';
  setInterval(() => {
    if (location.pathname !== '/timer') return;
    const el = weekLabelEl();
    const key = el ? el.textContent + '|' + document.querySelectorAll('h4').length : '';
    if (!el || key === lastLabel) return;
    lastLabel = key;
    postHolidays(scanHolidays(weekFromLabel()));
  }, 3000);
  async function importYearHolidays(year, progress) {
    const all = [];
    let w = startOfWeek(new Date(year, 0, 1));
    const end = new Date(year + 1, 0, 1);
    let i = 0;
    while (w < end) {
      progress(++i);
      await gotoWeek(w);
      all.push(...scanHolidays(w).filter((h) => h.date.startsWith(String(year))));
      w = addDays(w, 7);
    }
    const uniq = [...new Map(all.map((h) => [h.date, h])).values()];
    await postHolidays(uniq);
    return uniq;
  }

  // ───────── Plano por dia ─────────
  const descOf = (s) => `#${s.workItemId} ${s.title}${s.notes ? ` — ${s.notes}` : ''}`.slice(0, 500);
  function buildPlan(weekStart, sessions, clockinDays, project) {
    const plan = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i), key = ymd(day);
      const desired = sessions.filter((s) => ymd(new Date(s.start)) === key).map((s) => {
        const a = new Date(s.start), b = new Date(s.end);
        return { s, start: hhmm(a), end: hhmm(b), desc: descOf(s), crosses: ymd(a) !== ymd(b) };
      });
      const all = clockinDays.get(key) || [];
      const mine = all.filter((r) => projMatch(r.project, project));
      const others = all.filter((r) => !projMatch(r.project, project));
      const acts = [];
      if (!desired.length) {
        if (mine.length) acts.push({ type: 'skip', text: `${mine.length} apontamento(s) no Clockin e nenhuma sessão no Apontador: não mexi.` });
        plan.push({ day, key, acts, clockinMin: all.reduce((a, r) => a + toMin(r.end) - toMin(r.start), 0), appMin: 0, others });
        continue;
      }
      const D = desired.filter((d) => !d.crosses), E = mine.slice();
      for (const d of desired.filter((x) => x.crosses)) acts.push({ type: 'warn', text: `${d.start}–${d.end} ${d.desc}: passa da meia-noite, lance à mão.` });
      const take = (pred) => { const i = E.findIndex(pred); return i < 0 ? null : E.splice(i, 1)[0]; };
      // 1) já igual
      for (const d of D.slice()) {
        const e = take((x) => x.start === d.start && x.end === d.end && norm(x.desc) === norm(d.desc));
        if (e) { acts.push({ type: 'ok', d, e }); D.splice(D.indexOf(d), 1); }
      }
      // 2) mesmo card (#id) → editar; 3) horário que se sobrepõe → editar; 4) qualquer sobra → editar
      const pair = (pred) => {
        for (const d of D.slice()) {
          const e = take((x) => !x.locked && pred(x, d));
          if (e) { acts.push({ type: 'edit', d, e, on: true }); D.splice(D.indexOf(d), 1); }
        }
      };
      pair((x, d) => x.desc.includes(`#${d.s.workItemId}`));
      pair((x, d) => Math.max(toMin(x.start), toMin(d.start)) < Math.min(toMin(x.end), toMin(d.end)));
      pair(() => true);
      for (const d of D) {
        // Se um apontamento travado já ocupa esse horário, criar duplicaria as horas
        const clash = E.find((x) => x.locked && Math.max(toMin(x.start), toMin(d.start)) < Math.min(toMin(x.end), toMin(d.end)));
        acts.push({ type: 'create', d, on: !clash });
        if (clash) acts.push({ type: 'warn', text: `Criar ${d.start}–${d.end} ficou desmarcado: o horário bate com um apontamento travado (${clash.start}–${clash.end}).` });
      }
      for (const e of E) acts.push(e.locked ? { type: 'locked', e } : { type: 'delete', e, on: true });
      const order = { delete: 0, edit: 1, create: 2, ok: 3, locked: 4, warn: 5, skip: 6 };
      acts.sort((a, b) => order[a.type] - order[b.type] || (a.d || a.e).start.localeCompare((b.d || b.e).start));
      plan.push({
        day, key, acts, others,
        clockinMin: all.reduce((a, r) => a + toMin(r.end) - toMin(r.start), 0),
        appMin: desired.reduce((a, d) => a + toMin(d.end) - toMin(d.start), 0) + others.reduce((a, r) => a + toMin(r.end) - toMin(r.start), 0),
      });
    }
    return plan;
  }

  // ───────── Ações no Clockin ─────────
  async function doCreate(d, project) {
    const manual = byText('button', 'Manual');
    if (manual) { manual.click(); await sleep(200); }
    const main = document.querySelector('input[aria-label="Horário inicial"]');
    if (!main) throw new Error('Não achei o formulário de apontamento.');
    await selectProjectIn([...document.querySelectorAll('[role=combobox]')].find((c) => !c.closest('[data-edit-row]')) || document.querySelector('[role=combobox]'), project);
    const ta = document.querySelector('[aria-label="Descrição da atividade"]') || document.querySelector('main textarea');
    const date = document.querySelector('input[aria-label="Data do apontamento"]');
    const t1 = document.querySelector('input[aria-label="Horário inicial"]'), t2 = document.querySelector('input[aria-label="Horário final"]');
    if (!ta || !date || !t1 || !t2) throw new Error('Não achei os campos do formulário. Nada foi enviado.');
    const st = new Date(d.s.start);
    setNative(ta, d.desc); setNative(date, ymd(st)); await sleep(80);
    setNative(t1, d.start); await sleep(80); setNative(t2, d.end); await sleep(250);
    if (date.value !== ymd(st) || t1.value !== d.start || t2.value !== d.end || ta.value !== d.desc) throw new Error('O formulário não aceitou os valores; nada foi enviado.');
    const btn = byText('button', 'Apontar');
    if (!btn || btn.disabled) throw new Error('O botão Apontar está indisponível.');
    const p = waitToast(); btn.click();
    const r = await p; if (!r.ok) throw new Error(r.text);
  }
  async function doEdit(weekStart, key, e, d, project) {
    const row = findRow(weekStart, key, e.start, e.end, e.desc);
    if (!row) throw new Error(`Não achei no Clockin o apontamento ${e.start}–${e.end} "${e.desc}".`);
    await chooseMenu(await openRowMenu(row.querySelector('button[aria-label="Ações do apontamento"]')), 'Editar');
    const save = await waitFor(() => byText('button', 'Salvar'), 4000);
    if (!save) throw new Error('O formulário de edição não abriu.');
    let form = save;
    while (form && !form.querySelector('input[type=time]')) form = form.parentElement;
    if (!form) throw new Error('Não achei os campos de edição.');
    form.setAttribute('data-edit-row', '1');
    const desc = [...form.querySelectorAll('input[type=text], textarea')].find((x) => x.placeholder !== 'HH:mm' && !/Duração/i.test(x.getAttribute('aria-label') || ''));
    const times = form.querySelectorAll('input[type=time]');
    if (!desc || times.length < 2) throw new Error('Não achei os campos de edição.');
    const trig = form.querySelector('[role=combobox]');
    if (trig) await selectProjectIn(trig, project);
    setNative(desc, d.desc); await sleep(60);
    setNative(times[0], d.start); await sleep(80); setNative(times[1], d.end); await sleep(250);
    if (times[0].value !== d.start || times[1].value !== d.end || desc.value !== d.desc) {
      byText('button', 'Cancelar', form)?.click();
      throw new Error('A edição não aceitou os valores; cancelei sem salvar.');
    }
    const p = waitToast(); save.click();
    const r = await p;
    if (!r.ok) { byText('button', 'Cancelar', form)?.click(); throw new Error(r.text); }
  }
  async function doDelete(weekStart, key, e) {
    const row = findRow(weekStart, key, e.start, e.end, e.desc);
    if (!row) throw new Error(`Não achei no Clockin o apontamento ${e.start}–${e.end} "${e.desc}".`);
    await chooseMenu(await openRowMenu(row.querySelector('button[aria-label="Ações do apontamento"]')), 'Excluir');
    const dlg = await waitFor(() => document.querySelector('[role=alertdialog]'), 4000);
    if (!dlg) throw new Error('A confirmação de exclusão não apareceu.');
    const ok = [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Excluir');
    if (!ok) { byText('button', 'Cancelar', dlg)?.click(); throw new Error('Não achei o botão de confirmar exclusão.'); }
    const seen = new Set(document.querySelectorAll('[data-sonner-toast]'));
    const before = countRows(weekStart, key, e.start, e.end, e.desc);
    ok.click();
    const gone = await waitFor(() => {
      const err = [...document.querySelectorAll('[data-sonner-toast][data-type=error]')].find((t) => !seen.has(t));
      if (err) return { err: err.textContent.trim() };
      return countRows(weekStart, key, e.start, e.end, e.desc) < before ? { ok: true } : null;
    }, 10000);
    if (!gone) throw new Error('O Clockin não confirmou a exclusão.');
    if (gone.err) throw new Error(gone.err);
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
  .box { width: min(820px, 96vw); max-height: 90vh; display: flex; flex-direction: column; background: #12131c; color: #e6e8ec; border: 1px solid #2c2f3d; border-radius: 12px; font-size: 13px; }
  .hd { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #2c2f3d; flex-wrap: wrap; }
  .hd h2 { margin: 0 auto 0 0; font-size: 15px; }
  button { background: #222533; color: #e6e8ec; border: 1px solid #353a4d; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 13px; }
  button:hover { background: #2b2f40; }
  button.pri { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .proj { display: flex; gap: 6px; align-items: center; padding: 8px 14px; border-bottom: 1px solid #2c2f3d; }
  .proj input { flex: 1; background: #0b0c12; color: #e6e8ec; border: 1px solid #353a4d; border-radius: 6px; padding: 5px 8px; font-size: 13px; }
  .list { overflow: auto; padding: 6px 14px 10px; flex: 1; }
  .day { margin-top: 12px; border: 1px solid #2c2f3d; border-radius: 8px; overflow: hidden; }
  .dh { display: flex; gap: 10px; align-items: center; padding: 7px 10px; background: #1a1c28; font-size: 12px; }
  .dh b { font-size: 12.5px; }
  .dh .grow { flex: 1; }
  .st { font-size: 11px; padding: 1px 7px; border-radius: 8px; }
  .st.ok { background: #14532d; color: #bbf7d0; }
  .st.bad { background: #7c2d12; color: #fed7aa; }
  .st.none { background: #262a33; color: #9aa3b2; }
  label.a { display: flex; gap: 8px; align-items: flex-start; padding: 6px 10px; border-top: 1px solid #1f2130; cursor: pointer; }
  label.a .t { flex: 1; min-width: 0; }
  label.a .m { color: #8b93a3; font-size: 12px; }
  .k { font-weight: 700; display: inline-block; min-width: 64px; }
  .k.del { color: #fca5a5; } .k.edit { color: #fde68a; } .k.create { color: #86efac; } .k.ok { color: #8b93a3; } .k.locked { color: #94a3b8; } .k.warn { color: #fde68a; }
  .mono { font-family: Consolas, monospace; }
  .ft { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-top: 1px solid #2c2f3d; }
  .msg { flex: 1; color: #9aa3b2; font-size: 12px; }
  .msg.bad { color: #fca5a5; }
  .note { padding: 8px 14px; color: #fde68a; font-size: 12px; border-bottom: 1px solid #2c2f3d; display: none; }
  .note.on { display: block; }
  .empty { color: #8b93a3; padding: 16px 0; }
</style>
<button class="fab">⇅ Sincronizar com o Apontador</button>
<div class="bg"><div class="box">
  <div class="hd">
    <h2>Sincronizar com o Apontador de Horas</h2>
    <button data-a="prev">‹</button><span class="wk"></span><button data-a="next">›</button>
    <button data-a="reload" title="Comparar de novo">↻</button>
    <button data-a="hol" title="Lê os feriados de todas as semanas do ano no Clockin e manda para o Apontador">📅 Feriados do ano</button>
    <button data-a="close">✕</button>
  </div>
  <div class="proj">Projeto no Clockin: <input class="pj"></div>
  <div class="note"></div>
  <div class="list"></div>
  <div class="ft"><span class="msg"></span><button data-a="close">Fechar</button><button class="pri" data-a="go" disabled>Aplicar</button></div>
</div></div>`;
  const $ = (s) => root.querySelector(s);
  const fab = $('.fab'), bg = $('.bg');
  const st = { week: startOfWeek(new Date()), plan: [], busy: false };
  $('.pj').value = GM_getValue('project', DEFAULT_PROJECT);
  $('.pj').addEventListener('change', () => { GM_setValue('project', $('.pj').value.trim() || DEFAULT_PROJECT); load(); });

  setInterval(() => { fab.style.display = location.pathname === '/timer' && !bg.classList.contains('on') ? 'block' : 'none'; }, 500);
  const msg = (t, bad = false) => { const m = $('.msg'); m.textContent = t; m.className = `msg${bad ? ' bad' : ''}`; };
  const actId = (di, ai) => `${di}:${ai}`;

  function renderPlan() {
    const end = addDays(st.week, 6);
    $('.wk').textContent = `${pad(st.week.getDate())}/${pad(st.week.getMonth() + 1)} – ${pad(end.getDate())}/${pad(end.getMonth() + 1)}`;
    const list = $('.list');
    if (!st.plan.length) { list.innerHTML = ''; updateGo(); return; }
    let html = '';
    st.plan.forEach((p, di) => {
      if (!p.acts.length && !p.clockinMin) return;
      const pending = p.acts.filter((a) => ['edit', 'create', 'delete'].includes(a.type));
      const status = !p.appMin && !pending.length ? '<span class="st none">sem sessões no Apontador</span>'
        : pending.length ? '<span class="st bad">divergente</span>' : '<span class="st ok">✓ igual</span>';
      html += `<div class="day"><div class="dh"><b>${DAY_NAMES[p.day.getDay()]} ${pad(p.day.getDate())}/${pad(p.day.getMonth() + 1)}</b>
        <span>Clockin ${fmtMin(p.clockinMin)}</span><span>→</span><span>Apontador ${fmtMin(p.appMin)}</span><span class="grow"></span>${status}</div>`;
      p.acts.forEach((a, ai) => {
        const id = actId(di, ai);
        const box = ['edit', 'create', 'delete'].includes(a.type) ? `<input type="checkbox" data-id="${id}" ${a.on ? 'checked' : ''}>` : '<span style="width:13px"></span>';
        let body = '';
        if (a.type === 'ok') body = `<span class="k ok">= igual</span> <span class="mono">${a.d.start}–${a.d.end}</span> ${esc(a.d.desc)}`;
        else if (a.type === 'edit') body = `<span class="k edit">✎ editar</span> <span class="mono">${a.e.start}–${a.e.end}</span> "${esc(a.e.desc)}"${a.e.status ? ` <span class="m">(${esc(a.e.status)})</span>` : ''}<div class="m">para <span class="mono">${a.d.start}–${a.d.end}</span> ${esc(a.d.desc)}</div>`;
        else if (a.type === 'create') body = `<span class="k create">＋ criar</span> <span class="mono">${a.d.start}–${a.d.end}</span> ${esc(a.d.desc)}`;
        else if (a.type === 'delete') body = `<span class="k del">✕ excluir</span> <span class="mono">${a.e.start}–${a.e.end}</span> "${esc(a.e.desc)}"${a.e.status ? ` <span class="m">(${esc(a.e.status)})</span>` : ''}<div class="m">não existe no Apontador</div>`;
        else if (a.type === 'locked') body = `<span class="k locked">🔒 travado</span> <span class="mono">${a.e.start}–${a.e.end}</span> "${esc(a.e.desc)}" <span class="m">período bloqueado no Clockin, não dá para alterar</span>`;
        else body = `<span class="k warn">⚠</span> ${esc(a.text)}`;
        html += `<label class="a">${box}<span class="t">${body}</span></label>`;
      });
      if (p.others.length) html += `<label class="a"><span style="width:13px"></span><span class="t m">+ ${p.others.length} apontamento(s) de outros projetos (${esc([...new Set(p.others.map((o) => o.project))].join(', '))}): não mexi</span></label>`;
      html += '</div>';
    });
    list.innerHTML = html || '<div class="empty">Nada no Clockin nem no Apontador nesta semana.</div>';
    updateGo();
  }
  function selectedActs() {
    const out = [];
    for (const c of root.querySelectorAll('input[type=checkbox][data-id]:checked')) {
      const [di, ai] = c.dataset.id.split(':').map(Number);
      out.push({ p: st.plan[di], a: st.plan[di].acts[ai] });
    }
    return out;
  }
  function updateGo() {
    const sel = selectedActs();
    const n = (t) => sel.filter((x) => x.a.type === t).length;
    const go = $('[data-a=go]');
    go.disabled = st.busy || !sel.length;
    go.textContent = sel.length ? `Aplicar (${[n('edit') && `${n('edit')} editar`, n('create') && `${n('create')} criar`, n('delete') && `${n('delete')} excluir`].filter(Boolean).join(', ')})` : 'Aplicar';
    const note = $('.note');
    note.classList.toggle('on', n('delete') > 0 || sel.some((x) => /aprovad/i.test(x.a.e?.status || '')));
    note.textContent = `${n('delete') ? `Atenção: ${n('delete')} apontamento(s) serão excluídos do Clockin de vez. ` : ''}${sel.some((x) => /aprovad/i.test(x.a.e?.status || '')) ? 'Alguns já estão aprovados; o Clockin pode recusar a alteração ou mandar de novo para aprovação.' : ''}`;
  }
  root.addEventListener('change', (e) => { if (e.target.matches('input[type=checkbox]')) updateGo(); });

  async function load() {
    if (st.busy) return;
    st.plan = []; renderPlan(); msg('Comparando o Clockin com o Apontador…');
    try {
      const project = $('.pj').value.trim() || DEFAULT_PROJECT;
      const [r] = await Promise.all([fetchSessions(st.week, addDays(st.week, 7)), gotoWeek(st.week)]);
      await sleep(500);
      st.plan = buildPlan(st.week, r.sessions || [], readWeek(st.week), project);
      const n = st.plan.reduce((a, p) => a + p.acts.filter((x) => ['edit', 'create', 'delete'].includes(x.type)).length, 0);
      msg(n ? `${n} alteração(ões) para deixar o Clockin igual ao Apontador. Confira e clique em Aplicar.` : 'Tudo igual ao Apontador nesta semana. ✓');
    } catch (e) { msg(e.message, true); }
    renderPlan();
  }

  async function go() {
    const sel = selectedActs();
    if (!sel.length) return;
    const project = $('.pj').value.trim() || DEFAULT_PROJECT;
    GM_setValue('project', project);
    st.busy = true; updateGo(); bg.classList.remove('on');
    let ok = 0;
    try {
      // Por dia: primeiro exclui, depois edita, depois cria
      for (const { p, a } of sel) {
        fab.style.display = 'block';
        fab.textContent = `Aplicando ${ok + 1}/${sel.length}…`;
        await gotoWeek(st.week);
        if (a.type === 'delete') await doDelete(st.week, p.key, a.e);
        else if (a.type === 'edit') await doEdit(st.week, p.key, a.e, a.d, project);
        else if (a.type === 'create') await doCreate(a.d, project);
        ok++;
        await sleep(800);
      }
      fab.textContent = `✔ ${ok} alteração(ões)`;
      bg.classList.add('on');
      st.busy = false;
      await load();
      msg(`${ok} alteração(ões) aplicada(s). ${$('.msg').textContent}`);
    } catch (e) {
      st.busy = false;
      bg.classList.add('on');
      await load();
      msg(`${ok} de ${sel.length} aplicada(s). Parou em: ${e.message}`, true);
    } finally {
      st.busy = false; updateGo();
      setTimeout(() => { fab.textContent = '⇅ Sincronizar com o Apontador'; }, 4000);
    }
  }

  fab.addEventListener('click', () => { if (st.busy) return; bg.classList.add('on'); load(); });
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'close') bg.classList.remove('on');
    else if (a === 'prev') { st.week = addDays(st.week, -7); load(); }
    else if (a === 'next') { st.week = addDays(st.week, 7); load(); }
    else if (a === 'reload') load();
    else if (a === 'hol') {
      if (st.busy) return;
      st.busy = true; updateGo();
      const y = st.week.getFullYear();
      importYearHolidays(y, (n) => msg(`Lendo os feriados de ${y} no Clockin… semana ${n}/53`))
        .then(async (list) => { st.busy = false; await load(); msg(`${list.length} feriado(s) de ${y} enviados para o Apontador: ${list.map((h) => `${h.date.slice(8)}/${h.date.slice(5, 7)} ${h.name}`).join(' · ') || 'nenhum'}`); })
        .catch((e) => { st.busy = false; msg(e.message, true); load(); });
    }
    else if (a === 'go') go();
  });
})();
