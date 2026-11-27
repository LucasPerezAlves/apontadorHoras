'use strict';
// Apontador de Horas — mini aplicação local.
// Sobe um servidor em 127.0.0.1, serve a interface e repassa as chamadas ao Azure DevOps
// com o seu Personal Access Token (guardado criptografado com DPAPI do Windows).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = 47321;
const HOST = '127.0.0.1';
const IS_WIN = process.platform === 'win32';
const APP_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'ApontadorHoras');
const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'ApontadorHoras');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const HOLIDAYS_FILE = path.join(APP_DIR, 'feriados.json');
const LOG_FILE = path.join(DATA_DIR, 'app.log');
const APP_TOKEN = crypto.randomBytes(24).toString('hex');
const NO_WINDOW = process.argv.includes('--no-window');
const AFTER_UPDATE = process.argv.includes('--after-update'); // subiu sozinho depois de uma atualização
const APP_VERSION = (() => { try { return require('./version.js'); } catch { return '0.0.0-dev'; } })();
const UPDATE_REPO = 'LucasPerezAlves/apontadorHoras';
const APP_NOTES = (() => { try { return require('./novidades.js'); } catch { return ''; } })();
const DEBUG = process.argv.includes('--debug');

fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ───────── Log (o .exe não tem console) ─────────
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* ignore */ }
  if (DEBUG) process.stdout.write(line);
}
console.log = log;
console.error = log;
log(`Iniciando v${APP_VERSION} (pid ${process.pid}, node ${process.version}${process.env.AH_CHILD ? ', processo em segundo plano' : ''}${AFTER_UPDATE ? ', depois de atualizar' : ''})`);

// Clique duplo abre um console; o app se relança escondido e este processo sai.
// Para ver o que acontece, rode com --debug (o console fica aberto e mostra o log).
if (IS_WIN && !DEBUG && !NO_WINDOW && !process.env.AH_CHILD) {
  try {
    const child = spawn(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
      detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, AH_CHILD: '1' },
    });
    child.on('error', (e) => log('Falha ao relançar', e));
    child.unref();
    log('Relançado em segundo plano, pid', child.pid);
    setTimeout(() => process.exit(0), 300);
    return;
  } catch (e) { log('Falha ao relançar; seguindo neste processo', e); }
}

function messageBox(msg) {
  if (!IS_WIN) { process.stderr.write(msg + '\n'); return; }
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:AH_MSG, 'Apontador de Horas')"],
    { env: { ...process.env, AH_MSG: msg }, windowsHide: true, timeout: 120000 });
  } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => { log('FATAL', e); messageBox(`Erro inesperado:\n${e.message}\n\nDetalhes em:\n${LOG_FILE}`); process.exit(1); });
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

const UI_HTML = require('./ui.js');

// ───────── Cofre do token (DPAPI: só o seu usuário do Windows consegue ler) ─────────
function psRun(script, envVars) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...envVars }, windowsHide: true, encoding: 'utf8', timeout: 30000,
  });
  if (r.status !== 0) throw new Error(`PowerShell falhou: ${(r.stderr || r.error || '').toString().slice(0, 300)}`);
  return r.stdout.trim();
}
function protect(secret) {
  if (!IS_WIN) return { kind: 'plain', blob: Buffer.from(secret).toString('base64') };
  const blob = psRun("Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:AH_SECRET); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))", { AH_SECRET: secret });
  return { kind: 'dpapi', blob };
}
function unprotect({ kind, blob }) {
  if (kind === 'plain') return Buffer.from(blob, 'base64').toString();
  return psRun("Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:AH_BLOB); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))", { AH_BLOB: blob });
}

let config = null; // { org, project, email, name, token: {kind, blob} }
let pat = null;
function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    pat = unprotect(config.token);
  } catch (e) {
    if (fs.existsSync(CONFIG_FILE)) log('Não consegui ler a configuração', e);
    config = null; pat = null;
  }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

// ───────── Feriados (vindos do Clockin ou adicionados à mão) ─────────
// Lista de { date: 'AAAA-MM-DD', name, source: 'clockin' | 'manual', off?: true }
// off: true desativa um feriado (por exemplo, um nacional que a empresa não folga).
function loadHolidays() { try { const j = JSON.parse(fs.readFileSync(HOLIDAYS_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
function saveHolidays(list) { fs.writeFileSync(HOLIDAYS_FILE, JSON.stringify(list, null, 2)); }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function upsertHolidays(items, source) {
  const list = loadHolidays();
  let changed = 0;
  for (const h of items) {
    if (!h || !DATE_RE.test(String(h.date))) continue;
    const name = String(h.name || 'Feriado').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Feriado';
    const i = list.findIndex((x) => x.date === h.date);
    const next = { date: h.date, name, source, ...(h.off ? { off: true } : {}) };
    if (i < 0) { list.push(next); changed++; }
    else if (source === 'manual' || list[i].source !== 'manual') {
      // o que você ajustou à mão não é sobrescrito pelo Clockin
      if (JSON.stringify(list[i]) !== JSON.stringify(next)) { list[i] = next; changed++; }
    }
  }
  if (changed) { list.sort((a, b) => a.date.localeCompare(b.date)); saveHolidays(list); }
  return { changed, list };
}

// Atestados: guardados só neste PC (%APPDATA%\ApontadorHoras\atestados.json). Dia inteiro ou um horário.
const ATT_FILE = path.join(APP_DIR, 'atestados.json');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function loadAtestados() { try { const j = JSON.parse(fs.readFileSync(ATT_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
function saveAtestados(list) { fs.mkdirSync(APP_DIR, { recursive: true }); fs.writeFileSync(ATT_FILE, JSON.stringify(list, null, 2)); }

// Lista da equipe: feriados.json no repositório do GitHub, para quem não tem Clockin.
// Quem mantém o repositório edita o arquivo; os apps baixam ao abrir e a cada 6 h e guardam uma cópia.
const TEAM_HOL_FILE = path.join(APP_DIR, 'feriados-equipe.json');
const TEAM_HOL_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/feriados.json`;
let teamHol = (() => { try { return JSON.parse(fs.readFileSync(TEAM_HOL_FILE, 'utf8')); } catch { return { feriados: [] }; } })();
let teamHolError = '';
async function fetchTeamHolidays() {
  try {
    const r = await fetch(`${TEAM_HOL_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'ApontadorHoras', 'Cache-Control': 'no-cache' } });
    if (r.status === 404) { teamHol = { feriados: [], fetchedAt: new Date().toISOString() }; teamHolError = ''; return; }
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`);
    const j = await r.json();
    const list = (Array.isArray(j) ? j : j.feriados || [])
      .filter((h) => h && DATE_RE.test(String(h.date)))
      .map((h) => ({ date: h.date, name: String(h.name || 'Feriado').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Feriado' }));
    teamHol = { feriados: list, atualizado: (j && j.atualizado) || null, fetchedAt: new Date().toISOString() };
    teamHolError = '';
    fs.writeFileSync(TEAM_HOL_FILE, JSON.stringify(teamHol, null, 2));
    log('Feriados da equipe:', list.length);
  } catch (e) { teamHolError = 'Não consegui baixar a lista da equipe agora (usando a última cópia).'; log('Feriados da equipe: falhou', e?.cause || e); }
}
setTimeout(fetchTeamHolidays, 3000);
setInterval(fetchTeamHolidays, 6 * 3600e3);
const holidaysPayload = (list) => ({ holidays: list, team: teamHol.feriados || [], teamInfo: { atualizado: teamHol.atualizado || null, fetchedAt: teamHol.fetchedAt || null, error: teamHolError, url: `https://github.com/${UPDATE_REPO}/blob/main/feriados.json` } });

// ───────── Azure DevOps ─────────
function authHeader(token) { return 'Basic ' + Buffer.from(':' + token).toString('base64'); }
function netError(e) {
  const code = e?.cause?.code || e?.code || '';
  return new Error(`Não consegui conectar ao dev.azure.com${code ? ` (${code})` : ''}. Confira a internet/VPN e tente de novo.`);
}
async function adoFetch(url, opts) {
  try { return await fetch(url, opts); } catch (e) { log('Falha de rede', url.toString(), e?.cause || e); throw netError(e); }
}
async function whoAmI(org, token) {
  const res = await adoFetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/connectionData`, {
    headers: { Authorization: authHeader(token), Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
    redirect: 'manual',
  });
  if (res.status === 401 || res.status === 203 || res.status === 302) throw new Error('Token recusado pelo Azure DevOps. Confira se ele foi criado na organização certa e não expirou.');
  if (!res.ok) throw new Error(`Azure DevOps respondeu ${res.status}.`);
  const j = await res.json();
  const u = j.authenticatedUser || {};
  const email = String(u.properties?.Account?.$value || '').trim().toLowerCase();
  if (!email) throw new Error('O token funcionou, mas não consegui descobrir seu e-mail.');
  return { email, name: u.providerDisplayName || email };
}


// ───────── Exportação (usada pelo botão "Importar do Apontador" dentro do Clockin) ─────────
function decodeEntities(s) { return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function parseWS(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  for (const c of [raw, decodeEntities(raw), decodeEntities(raw.replace(/<[^>]+>/g, ''))]) {
    try { const v = JSON.parse(c); if (Array.isArray(v)) return v; } catch { /* próximo */ }
  }
  return [];
}
async function adoJson(url, opts = {}) {
  const r = await adoFetch(url, {
    ...opts, redirect: 'manual',
    headers: { Authorization: authHeader(pat), Accept: 'application/json', 'Content-Type': 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress', ...(opts.headers || {}) },
  });
  if (!r.ok) { const e = new Error(`Azure respondeu ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
async function exportSessions(from, to) {
  const org = encodeURIComponent(config.org), proj = encodeURIComponent(config.project);
  const ids = new Set();
  try {
    const idx = await adoJson(`https://extmgmt.dev.azure.com/${org}/_apis/ExtensionManagement/InstalledExtensions/SWProcessTools/philips-emr-workflow-ado/Data/Scopes/Default/Current/Collections/userWorkSessionIndex/Documents/${encodeURIComponent(config.email)}?api-version=7.1-preview.1`);
    (idx.workItems || []).forEach((i) => ids.add(Number(i)));
  } catch (e) { log('export: lista do hub indisponível', e.message); }
  const days = Math.min(400, Math.ceil((Date.now() - from.getTime()) / 864e5) + 2);
  try {
    const w = await adoJson(`https://dev.azure.com/${org}/${proj}/_apis/wit/wiql?$top=400&api-version=7.1`, {
      method: 'POST',
      body: JSON.stringify({ query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.ChangedDate] >= @Today - ${days} AND ([System.AssignedTo] = @Me OR [System.AssignedTo] EVER @Me)` }),
    });
    (w.workItems || []).forEach((x) => ids.add(x.id));
  } catch (e) { log('export: WIQL falhou', e.message); }
  const list = [...ids].filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const j = await adoJson(`https://dev.azure.com/${org}/_apis/wit/workitems?ids=${chunk.join(',')}&fields=System.Title,System.TeamProject,Custom.WorkSessionEntry&errorPolicy=Omit&api-version=7.1`);
    for (const w of j.value || []) {
      if (!w || !w.fields) continue;
      for (const e of parseWS(w.fields['Custom.WorkSessionEntry'])) {
        if ((e.userEmail || '').trim().toLowerCase() !== config.email || !e.start || !e.end) continue;
        const s = new Date(e.start), en = new Date(e.end);
        if (isNaN(s) || isNaN(en) || s < from || s >= to) continue;
        out.push({
          key: `${w.id}:${e.id || e.start}`, workItemId: w.id, title: w.fields['System.Title'] || '',
          start: s.toISOString(), end: en.toISOString(), notes: e.notes || '',
          url: `https://dev.azure.com/${org}/${encodeURIComponent(w.fields['System.TeamProject'] || config.project)}/_workitems/edit/${w.id}`,
        });
      }
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

// ───────── HTTP ─────────
let lastPing = Date.now();
let byeTimer = null;
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Corpo grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Só aceita chamadas feitas para este próprio endereço (bloqueia DNS rebinding)
    if (req.headers.host !== `${HOST}:${PORT}`) return send(res, 403, { message: 'Host inválido' });
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
      return send(res, 200, UI_HTML.replace('__APP_TOKEN__', APP_TOKEN), 'text/html; charset=utf-8');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { message: 'Não encontrado' });
    // Versão e processo: a janela usa para saber quando a versão nova já está no ar
    if (url.pathname === '/api/version') return send(res, 200, { version: APP_VERSION, pid: process.pid });

    // Ponte para o Clockin: só responde a quem manda o cabeçalho próprio (páginas comuns não conseguem
    // mandar cabeçalho customizado para cá sem CORS, e este endpoint não libera CORS).
    if (url.pathname === '/api/holidays/import' && req.method === 'POST') {
      if (req.headers['x-apontador-bridge'] !== 'clockin') return send(res, 403, { message: 'Acesso negado' });
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString() || '{}');
      const items = (Array.isArray(body.holidays) ? body.holidays : []).slice(0, 400).map((h) => ({ date: h.date, name: h.name }));
      const r = upsertHolidays(items, 'clockin');
      if (r.changed) log('Feriados do Clockin atualizados:', r.changed);
      return send(res, 200, { ok: true, changed: r.changed, total: r.list.length });
    }
    if (url.pathname === '/api/export' && req.method === 'GET') {
      if (req.headers['x-apontador-bridge'] !== 'clockin') return send(res, 403, { message: 'Acesso negado' });
      if (!config || !pat) return send(res, 409, { message: 'Abra o Apontador de Horas e conecte seu token do Azure primeiro.' });
      const from = new Date(url.searchParams.get('from') || ''), to = new Date(url.searchParams.get('to') || '');
      if (isNaN(from) || isNaN(to) || to <= from || to - from > 62 * 864e5) return send(res, 400, { message: 'Período inválido (máx. 62 dias).' });
      try {
        const sessions = await exportSessions(from, to);
        log('Exportadas', sessions.length, 'sessões para o Clockin');
        return send(res, 200, { email: config.email, sessions, atestados: loadAtestados() });
      } catch (e) {
        return send(res, e.status === 401 || e.status === 203 ? 401 : 502, { message: e.status === 401 || e.status === 203 ? 'O token do Azure expirou. Abra o Apontador e informe um novo.' : e.message });
      }
    }

    // A janela foi fechada: encerra em alguns segundos, a menos que ela volte (recarregar a página)
    if (url.pathname === '/api/bye' && req.method === 'POST') {
      const bt = url.searchParams.get('t') || '';
      if (bt.length === APP_TOKEN.length && crypto.timingSafeEqual(Buffer.from(bt), Buffer.from(APP_TOKEN))) {
        clearTimeout(byeTimer);
        byeTimer = setTimeout(() => { log('Janela fechada (bye)'); shutdown(); }, 5000);
      }
      return send(res, 204, '');
    }

    // Toda chamada da API precisa do token desta sessão (impede outros sites de usarem o app)
    const t = req.headers['x-app-token'];
    if (typeof t !== 'string' || t.length !== APP_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(APP_TOKEN))) {
      return send(res, 403, { message: 'Sessão inválida. Feche e abra o app de novo.' });
    }
    lastPing = Date.now(); lastApiAt = lastPing; apiCalls++;
    clearTimeout(byeTimer);

    if (url.pathname === '/api/ping') return send(res, 200, { ok: true });
    // Novidades da versão em uso: embutidas no .exe; se faltarem, busca a descrição da release
    if (url.pathname === '/api/whatsnew') {
      let notes = APP_NOTES;
      if (!notes && process.pkg) notes = await releaseNotesOf(APP_VERSION);
      return send(res, 200, { version: APP_VERSION, notes, page: `https://github.com/${UPDATE_REPO}/releases/tag/v${APP_VERSION}` });
    }
    if (url.pathname === '/api/update' && req.method === 'GET') {
      if (url.searchParams.get('check') === '1') { await checkUpdate(); autoDownload(); }
      return send(res, 200, updateInfo());
    }
    if (url.pathname === '/api/update' && req.method === 'POST') {
      if (!updateAvailable()) return send(res, 400, { message: 'Você já está na versão mais recente.' });
      if (!(IS_WIN && process.pkg)) return send(res, 400, { message: 'A atualização automática só funciona no ApontadorHoras.exe.' });
      applyUpdate().catch((e) => { U.state = 'error'; U.error = e.message; });
      return send(res, 202, updateInfo());
    }
    if (url.pathname === '/api/status') {
      return send(res, 200, config && pat
        ? { configured: true, org: config.org, project: config.project, me: { email: config.email, name: config.name }, expiresAt: config.expiresAt || null, presence: PRESENCE_ON() }
        : { configured: false, org: config?.org || 'emr-cm', project: config?.project || 'EMR' });
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const org = String(body.org || '').trim();
      const project = String(body.project || '').trim();
      const token = String(body.pat || '').trim() || pat;
      if (!/^[A-Za-z0-9._-]+$/.test(org)) return send(res, 400, { message: 'Organização inválida.' });
      if (!project) return send(res, 400, { message: 'Informe o projeto.' });
      if (!token) return send(res, 400, { message: 'Cole o token (PAT).' });
      let me;
      try { me = await whoAmI(org, token); } catch (e) { return send(res, 400, { message: e.message }); }
      const sameToken = token === pat && config;
      const exp = /^\d{4}-\d{2}-\d{2}$/.test(String(body.expiresAt || '')) ? body.expiresAt : (sameToken ? config.expiresAt || null : null);
      const c = { org, project, email: me.email, name: me.name, token: protect(token), savedAt: sameToken && config.savedAt ? config.savedAt : new Date().toISOString(), expiresAt: exp };
      saveConfig(c); config = c; pat = token;
      log('Configuração salva para', me.email, org, project);
      return send(res, 200, { ok: true, me, org, project });
    }
    // Tela de configurações: mostrar/copiar o token salvo (só para a própria janela do app)
    if (url.pathname === '/api/token' && req.method === 'GET') {
      if (!config || !pat) return send(res, 404, { message: 'Nenhum token salvo.' });
      log('Token exibido nas configurações');
      return send(res, 200, { token: pat, org: config.org, project: config.project, email: config.email, name: config.name, savedAt: config.savedAt || null, expiresAt: config.expiresAt || null });
    }
    if (url.pathname === '/api/token-meta' && req.method === 'POST') {
      if (!config) return send(res, 404, { message: 'Nenhum token salvo.' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const exp = body.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(String(body.expiresAt)) ? String(body.expiresAt) : null;
      config = { ...config, expiresAt: exp }; saveConfig(config);
      return send(res, 200, { ok: true, expiresAt: exp });
    }
    if (url.pathname === '/api/test' && req.method === 'GET') {
      if (!config || !pat) return send(res, 404, { message: 'Nenhum token salvo.' });
      try { const me = await whoAmI(config.org, pat); return send(res, 200, { ok: true, me }); }
      catch (e) { return send(res, 400, { message: e.message }); }
    }
    if (url.pathname === '/api/atestados' && req.method === 'GET') return send(res, 200, { atestados: loadAtestados() });
    if (url.pathname === '/api/atestados' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      let list = loadAtestados();
      if (body.remove) { list = list.filter((a) => a.id !== String(body.remove)); saveAtestados(list); return send(res, 200, { atestados: list }); }
      const from = String(body.from || ''), to = String(body.to || body.from || ''), allDay = body.allDay !== false;
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return send(res, 400, { message: 'Datas inválidas.' });
      if (!allDay && (!TIME_RE.test(body.start || '') || !TIME_RE.test(body.end || '') || body.end <= body.start)) return send(res, 400, { message: 'Horário inválido.' });
      if (list.some((a) => a.from <= to && from <= (a.to || a.from))) return send(res, 409, { message: 'Já existe um atestado nesse período.' });
      list.push({ id: crypto.randomBytes(6).toString('hex'), from, to, allDay, start: allDay ? null : body.start, end: allDay ? null : body.end, note: String(body.note || '').slice(0, 80), createdAt: new Date().toISOString() });
      list.sort((a, b) => a.from.localeCompare(b.from));
      saveAtestados(list);
      return send(res, 200, { atestados: list });
    }
    if (url.pathname === '/api/holidays' && req.method === 'GET') {
      if (url.searchParams.get('refresh') === '1') await fetchTeamHolidays();
      return send(res, 200, holidaysPayload(loadHolidays()));
    }
    if (url.pathname === '/api/holidays' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.remove && DATE_RE.test(String(body.date))) {
        const list = loadHolidays().filter((x) => x.date !== body.date); saveHolidays(list);
        return send(res, 200, holidaysPayload(list));
      }
      if (!DATE_RE.test(String(body.date))) return send(res, 400, { message: 'Data inválida.' });
      const r = upsertHolidays([{ date: body.date, name: body.name, off: !!body.off }], 'manual');
      return send(res, 200, holidaysPayload(r.list));
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      try { fs.unlinkSync(CONFIG_FILE); } catch { /* já não existia */ }
      config = null; pat = null;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/quit' && req.method === 'POST') {
      send(res, 200, { ok: true });
      setTimeout(shutdown, 200);
      return;
    }
    if (url.pathname === '/api/presence' && req.method === 'GET') {
      if (!PRESENCE_ON()) return send(res, 404, { message: 'Não encontrado' });
      if (!config || !pat) return send(res, 401, { message: 'Configure seu token primeiro.' });
      try {
        const j = await adoJson(PRESENCE_URL());
        return send(res, 200, { now: new Date().toISOString(), me: config.email, users: (Array.isArray(j) ? j : j.value || []).map((d) => ({ email: d.email || d.id, name: d.name, version: d.version, lastSeen: d.lastSeen, startedAt: d.startedAt, closed: !!d.closed })) });
      } catch (e) { return send(res, e.status === 404 ? 200 : 502, e.status === 404 ? { now: new Date().toISOString(), me: config.email, users: [] } : { message: e.message }); }
    }
    if (url.pathname === '/api/index' || url.pathname.startsWith('/api/index/')) {
      // Lista de itens do Work Session Hub (Extension Data Service), só a coleção "userWorkSessionIndex"
      if (!config || !pat) return send(res, 401, { message: 'Configure seu token primeiro.' });
      if (!['GET', 'PUT'].includes(req.method)) return send(res, 405, { message: 'Método não permitido' });
      const sub = url.pathname.slice('/api/index'.length);
      if (sub && !/^\/[^/]+$/.test(sub)) return send(res, 400, { message: 'Caminho inválido' });
      const target = `https://extmgmt.dev.azure.com/${encodeURIComponent(config.org)}/_apis/ExtensionManagement/InstalledExtensions/SWProcessTools/philips-emr-workflow-ado/Data/Scopes/Default/Current/Collections/userWorkSessionIndex/Documents${sub}?api-version=7.1-preview.1`;
      const body = req.method === 'GET' ? undefined : await readBody(req);
      const upstream = await adoFetch(target, {
        method: req.method, body, redirect: 'manual',
        headers: { Authorization: authHeader(pat), Accept: 'application/json', 'Content-Type': 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      if ([401, 203, 302].includes(upstream.status) || (upstream.status === 403)) {
        log('Índice do hub recusado', upstream.status, buf.toString().slice(0, 300));
        return send(res, 403, { code: 'EXT_SCOPE', message: 'O token não tem a permissão "Extension Data (Read & write)".' });
      }
      return send(res, upstream.status, buf, upstream.headers.get('content-type') || 'application/json');
    }
    if (url.pathname.startsWith('/api/ado/')) {
      if (!config || !pat) return send(res, 401, { message: 'Configure seu token primeiro.' });
      const rest = url.pathname.slice('/api/ado'.length); // começa com /
      // DELETE só para excluir um card (vai para a Lixeira do Azure); o resto é leitura e gravação normal
      const okDelete = req.method === 'DELETE' && /^\/(?:[^/]+\/)?_apis\/wit\/workitems\/\d+$/.test(rest);
      if (!['GET', 'POST', 'PATCH'].includes(req.method) && !okDelete) return send(res, 405, { message: 'Método não permitido' });
      if (okDelete) log('Excluindo card', rest.match(/\d+$/)[0]);
      const target = new URL(`https://dev.azure.com/${encodeURIComponent(config.org)}${rest}${url.search}`);
      if (target.hostname !== 'dev.azure.com' || !target.pathname.startsWith(`/${config.org}/`) || target.pathname.includes('/../')) {
        return send(res, 400, { message: 'Caminho inválido' });
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
      const t0 = Date.now();
      const upstream = await adoFetch(target, {
        method: req.method,
        body,
        redirect: 'manual',
        headers: {
          Authorization: authHeader(pat),
          Accept: 'application/json',
          'X-TFS-FedAuthRedirect': 'Suppress',
          ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
        },
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const ms = Date.now() - t0;
      // Limite de uso do Azure DevOps (por pessoa): repassa o aviso para a janela pausar o automático
      const rlDelay = upstream.headers.get('x-ratelimit-delay'), rlRetry = upstream.headers.get('retry-after');
      const rlLeft = Number(upstream.headers.get('x-ratelimit-remaining')), rlMax = Number(upstream.headers.get('x-ratelimit-limit'));
      const rlInfo = rlDelay || rlRetry || upstream.status === 429 || (rlMax > 0 && rlLeft >= 0 && rlLeft < rlMax * 0.25)
        ? [rlDelay && `atraso ${rlDelay}s`, rlRetry && `tente em ${rlRetry}s`, rlMax > 0 && `restam ${rlLeft}/${rlMax}`, upstream.status === 429 && 'HTTP 429'].filter(Boolean).join(', ') || 'limite' : '';
      if (rlInfo) log(`Azure limitando o uso (${rlInfo}) · ${req.method} ${rest.slice(0, 60)}`);
      if (ms > 1500) log(`Azure lento: ${ms} ms · ${req.method} ${rest.slice(0, 70)} · ${url.search.includes('ids=') ? `${(url.search.match(/ids=([\d%C,]+)/) || ['', ''])[1].split(/,|%2C/i).length} itens · ` : ''}${Math.round(buf.length / 1024)} KB`);
      let status = upstream.status;
      if (status === 203 || status === 302) status = 401; // Azure responde assim quando o token não vale
      if (status === 401) return send(res, 401, { message: 'O Azure recusou o token (expirado ou sem permissão). Abra ⚙ e informe um novo.' });
      return send(res, status, buf, upstream.headers.get('content-type') || 'application/json', rlInfo ? { 'X-Apontador-RateLimit': rlInfo } : {});
    }
    return send(res, 404, { message: 'Não encontrado' });
  } catch (e) {
    log('Erro na requisição', req.method, req.url, e);
    if (!res.headersSent) send(res, 502, { message: e.message });
  }
});

// ───────── Janela ─────────
let windowProc = null;
function findEdge() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
function openWindow(url) {
  if (NO_WINDOW) return;
  if (!IS_WIN) { log('Abra no navegador:', url); return; }
  const edge = findEdge();
  if (edge) {
    // Perfil próprio do Edge: a janela vira um processo nosso e, quando fecha, o app encerra.
    windowProc = spawn(edge, [
      `--app=${url}`, `--user-data-dir=${path.join(DATA_DIR, 'janela')}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', '--disable-features=Translate',
    ], { stdio: 'ignore', windowsHide: false, detached: true }); // solto: a janela sobrevive ao reinício da atualização
    const spawnedAt = Date.now();
    windowProc.on('exit', () => {
      // Se o processo saiu logo de cara, o Edge reaproveitou outra instância: passa a vigiar pelo "ping" da página.
      if (Date.now() - spawnedAt < 8000) { log('Edge devolveu o controle cedo; usando ping'); windowProc = null; lastPing = Date.now(); return; }
      log('Janela fechada'); setTimeout(shutdown, 1500);
    });
    windowProc.on('error', (e) => { log('Edge falhou', e); windowProc = null; openDefaultBrowser(url); });
  } else openDefaultBrowser(url);
}
function openDefaultBrowser(url) {
  spawn('cmd.exe', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
}

function shutdown() {
  log('Encerrando');
  installOnExit();
  presenceBeat(true);
  try { server.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}
// Sem janela do Edge (navegador padrão), encerra se a página ficar 3 min sem dar sinal
setInterval(() => { if (!windowProc && !NO_WINDOW && IS_WIN && Date.now() - lastPing > 3 * 60e3) shutdown(); }, 30e3);

// ───────── Atualização automática (GitHub Releases) ─────────
// O app olha a última release do repositório. Se houver versão nova, a janela mostra o aviso; ao clicar em
// "Atualizar", ele baixa o .exe, confere tamanho e SHA-256, troca o arquivo (no Windows dá para renomear um
// .exe em uso) e sobe a versão nova. Se ela não responder em 30 s, volta para a versão anterior.
const U = { latest: null, tag: '', notes: '', url: '', sha256: '', size: 0, checkedAt: 0, checkError: '', state: 'idle', progress: 0, error: '' };
const verParts = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
function newer(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}
const updateAvailable = () => !!(U.latest && U.url && newer(U.latest, APP_VERSION));
function updateInfo() {
  return {
    current: APP_VERSION, latest: U.latest, available: updateAvailable(), notes: U.notes, state: U.state === 'ready' && readyVersion !== U.latest ? 'idle' : U.state, progress: U.progress, error: U.error,
    checkedAt: U.checkedAt || null, checkError: U.checkError, canApply: !!(IS_WIN && process.pkg),
    page: `https://github.com/${UPDATE_REPO}/releases/${U.tag ? `tag/${encodeURIComponent(U.tag)}` : 'latest'}`,
  };
}
const GH_HEADERS = { 'User-Agent': 'ApontadorHoras', Accept: 'application/vnd.github+json' };
const ghFetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(10000) }); // GitHub lento não trava nada
let checking = null;
function checkUpdate() {
  if (checking) return checking;
  checking = (async () => {
    try {
      let tag = '', notes = '', url = '', sha = '', size = 0;
      const r = await ghFetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: GH_HEADERS });
      if (r.ok) {
        const j = await r.json();
        tag = j.tag_name || ''; notes = j.body || '';
        const exe = (j.assets || []).find((a) => /^ApontadorHoras\.exe$/i.test(a.name));
        if (exe) { url = exe.browser_download_url; size = exe.size || 0; if (/^sha256:[a-f0-9]{64}$/i.test(exe.digest || '')) sha = exe.digest.slice(7).toLowerCase(); }
        const shaFile = (j.assets || []).find((a) => /^ApontadorHoras\.exe\.sha256$/i.test(a.name));
        if (!sha && shaFile) {
          try { sha = (((await (await ghFetch(shaFile.browser_download_url, { headers: GH_HEADERS })).text()).match(/\b[a-f0-9]{64}\b/i)) || [''])[0].toLowerCase(); } catch { /* ignore */ }
        }
      } else {
        // Limite da API do GitHub (muita gente na mesma rede): descobre a versão pelo redirecionamento da página
        const r2 = await ghFetch(`https://github.com/${UPDATE_REPO}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'ApontadorHoras' } });
        const m = (r2.headers.get('location') || '').match(/\/releases\/tag\/([^/?#]+)/);
        if (!m) throw new Error(`GitHub respondeu ${r.status}`);
        tag = decodeURIComponent(m[1]);
        url = `https://github.com/${UPDATE_REPO}/releases/download/${encodeURIComponent(tag)}/ApontadorHoras.exe`;
      }
      Object.assign(U, { latest: tag.replace(/^v/i, ''), tag, notes, url, sha256: sha, size, checkError: '' });
      log('Atualização: atual', APP_VERSION, '· última', U.latest || '?', url ? '' : '(release sem ApontadorHoras.exe)');
    } catch (e) { U.checkError = 'Não consegui consultar o GitHub agora.'; log('Atualização: não consegui verificar', e?.cause || e); }
    finally { U.checkedAt = Date.now(); checking = null; }
  })();
  return checking;
}
// Descrição de uma release no GitHub, sem o rodapé fixo (melhor esforço)
async function releaseNotesOf(version) {
  for (const tag of [`v${version}`, version]) {
    try {
      const r = await ghFetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers: GH_HEADERS });
      if (!r.ok) continue;
      const body = String((await r.json()).body || '');
      return body.split(/\n## Todos os commits|\nQuem já usa o app/)[0].replace(/^## O que mudou\s*/m, '').trim();
    } catch { /* sem rede */ }
  }
  return '';
}
async function downloadTo(url, file) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ApontadorHoras', Accept: 'application/octet-stream' } });
  if (!r.ok || !r.body) throw new Error(`Não consegui baixar a versão nova (HTTP ${r.status}).`);
  const total = Number(r.headers.get('content-length')) || U.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of r.body) {
      got += chunk.length; hash.update(chunk); U.progress = total ? Math.min(0.99, got / total) : 0;
      if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    }
  } finally { await new Promise((ok) => out.end(ok)); }
  return { size: got, sha256: hash.digest('hex') };
}
// Baixa e confere a versão nova sem trocar nada: fica pronta (state 'ready') para reiniciar agora
// ou ser instalada quando o app fechar.
const UPD_PATHS = () => {
  const exe = process.execPath, dir = path.dirname(exe), base = path.basename(exe, path.extname(exe));
  return { exe, dir, base, tmp: path.join(dir, `${base}.new.exe`) };
};
let readyVersion = null, lastAutoTry = { version: null, at: 0 };
async function downloadUpdate() {
  if (['downloading', 'restarting'].includes(U.state)) return;
  if (U.state === 'ready' && readyVersion === U.latest) return;
  const { dir, tmp } = UPD_PATHS();
  U.state = 'downloading'; U.progress = 0; U.error = ''; readyVersion = null;
  try {
    try { fs.writeFileSync(tmp, ''); } catch { throw new Error(`Sem permissão para gravar em ${dir}. Deixe o app numa pasta sua (ex.: C:\\ApontadorHoras) ou baixe a versão nova pelo GitHub.`); }
    log('Atualização: baixando', U.url);
    const got = await downloadTo(U.url, tmp);
    if (U.size && got.size !== U.size) throw new Error('O download veio incompleto. Tente de novo.');
    if (U.sha256 && got.sha256 !== U.sha256) throw new Error('O arquivo baixado não confere com o da release (SHA-256). Atualização cancelada.');
    const head = Buffer.alloc(2); const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    if (head.toString('latin1') !== 'MZ' || got.size < 5e6) throw new Error('O arquivo baixado não é um .exe válido.');
    U.progress = 1; U.state = 'ready'; readyVersion = U.latest;
    log('Atualização: versão', U.latest, 'baixada e conferida; pronta para instalar');
  } catch (e) {
    U.state = 'error'; U.error = e.message; log('Atualização falhou', e);
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}
// Troca o .exe em uso pelo baixado (no Windows dá para renomear um .exe em execução)
function swapExe() {
  const { exe, dir, base, tmp } = UPD_PATHS();
  let old = path.join(dir, `${base}.old.exe`);
  try { fs.rmSync(old, { force: true }); } catch { old = path.join(dir, `${base}.old-${Date.now()}.exe`); }
  fs.renameSync(exe, old);
  try { fs.renameSync(tmp, exe); } catch (e) { fs.renameSync(old, exe); throw e; }
  return { exe, old };
}
// "Reiniciar agora": baixa se ainda não baixou, troca o arquivo e sobe a versão nova
async function applyUpdate() {
  if (U.state === 'restarting') return;
  if (!(U.state === 'ready' && readyVersion === U.latest)) await downloadUpdate();
  if (U.state !== 'ready') return;
  U.state = 'restarting';
  try {
    const { exe, old } = swapExe();
    log('Atualização: arquivo trocado; reiniciando na versão', U.latest);
    setTimeout(() => restartInto(exe, old), 400); // deixa a resposta chegar na janela
  } catch (e) { U.state = 'error'; U.error = `Não consegui trocar o arquivo: ${e.message}`; log('Atualização falhou', e); }
}
// Ao fechar o app com uma versão pronta: instala para a próxima abertura já vir atualizada
function installOnExit() {
  if (U.state !== 'ready' || readyVersion !== U.latest) return;
  try { swapExe(); log('Atualização: versão', U.latest, 'instalada ao fechar; abre atualizada na próxima vez'); }
  catch (e) { log('Atualização: não consegui instalar ao fechar', e); }
}
// Achou versão nova: baixa sozinho (uma tentativa automática por versão a cada hora, se der erro)
function autoDownload() {
  if (!updateAvailable() || !(IS_WIN && process.pkg)) return;
  if (['downloading', 'restarting'].includes(U.state) || (U.state === 'ready' && readyVersion === U.latest)) return;
  if (lastAutoTry.version === U.latest && Date.now() - lastAutoTry.at < 3600e3) return;
  lastAutoTry = { version: U.latest, at: Date.now() };
  downloadUpdate();
}
function restartInto(exe, old) {
  try { server.close(); server.closeAllConnections?.(); } catch { /* ignore */ }
  // O pkg coloca PKG_EXECPATH=<este .exe> em todo processo filho, e um .exe do pkg que recebe o próprio
  // caminho ali se comporta como "node" (tentaria rodar "--after-update" como script). Como o .exe novo
  // fica no mesmo caminho, mandamos um valor qualquer: o pkg não sobrescreve e o filho roda o app normalmente.
  const env = { ...process.env, AH_CHILD: '1', PKG_EXECPATH: 'apontador-atualizacao' };
  let out = 'ignore';
  try { out = fs.openSync(path.join(DATA_DIR, 'atualizacao.log'), 'w'); } catch { /* sem log de saída */ }
  const child = spawn(exe, ['--after-update'], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env });
  child.on('error', (e) => log('Atualização: falha ao iniciar a versão nova', e));
  child.on('exit', (code) => log('Atualização: a versão nova saiu com código', code, '(saída em atualizacao.log)'));
  child.unref();
  if (typeof out === 'number') try { fs.closeSync(out); } catch { /* ignore */ }
  const t0 = Date.now();
  const poll = async () => {
    try {
      const j = await (await fetch(`http://${HOST}:${PORT}/api/version`)).json();
      if (j.pid !== process.pid) { log('Atualização: versão', j.version, 'no ar (pid', j.pid + '). Saindo.'); return process.exit(0); }
    } catch { /* ainda subindo */ }
    if (Date.now() - t0 < 30000) return setTimeout(poll, 700);
    // A versão nova não respondeu: volta a anterior e continua rodando
    log('Atualização: a versão nova não respondeu; voltando para', APP_VERSION);
    try { fs.renameSync(exe, exe.replace(/\.exe$/i, '.failed.exe')); fs.renameSync(old, exe); } catch (e) { log('Atualização: não consegui restaurar', e); }
    U.state = 'error'; U.error = 'A versão nova não iniciou. Continuei na versão atual; veja o log ou baixe pelo GitHub.';
    server.listen(PORT, HOST);
  };
  setTimeout(poll, 800);
}
// Limpa sobras de atualizações anteriores
if (process.pkg) setTimeout(() => {
  try {
    const dir = path.dirname(process.execPath), base = path.basename(process.execPath, path.extname(process.execPath));
    for (const f of fs.readdirSync(dir)) {
      if (U.state !== 'idle') return; // nunca durante uma atualização (o .old é o caminho de volta)
      if (!f.startsWith(base + '.') || !/\.(old(-\d+)?|failed|new)\.exe$/i.test(f)) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); log('Removido', f); } catch { /* ainda em uso */ }
    }
  } catch { /* ignore */ }
}, 20000);
// Procura versão nova ao abrir e a cada 15 min; achou, já baixa em segundo plano
const checkAndFetch = async () => { await checkUpdate(); autoDownload(); };
if (process.pkg) { setTimeout(checkAndFetch, 3000); setInterval(checkAndFetch, 15 * 60e3); }

// ───────── Presença: quem está usando o app ─────────
// Todo app, enquanto a janela está aberta, grava a cada 2 min "estou aberto" (nome, e-mail, versão, horário) numa
// coleção própria do Extension Data Service (o mesmo armazenamento da lista do hub) e marca a saída ao fechar.
// A tela 👥 com quem está ativo (e a leitura da lista) só aparece com o arquivo presenca.on em %APPDATA%\ApontadorHoras.
const PRESENCE_ON = () => fs.existsSync(path.join(APP_DIR, 'presenca.on'));
const PRESENCE_COLLECTION = 'apontadorHorasPresenca';
const PRESENCE_URL = (id) => `https://extmgmt.dev.azure.com/${encodeURIComponent(config.org)}/_apis/ExtensionManagement/InstalledExtensions/SWProcessTools/philips-emr-workflow-ado/Data/Scopes/Default/Current/Collections/${PRESENCE_COLLECTION}/Documents${id ? '/' + encodeURIComponent(id) : ''}?api-version=7.1-preview.1`;
const PRESENCE_STARTED = new Date().toISOString();
async function presenceBeat(closing) {
  if (!config || !pat || !config.email) return;
  const doc = { id: config.email, email: config.email, name: config.name || config.email, version: APP_VERSION, startedAt: PRESENCE_STARTED, lastSeen: new Date().toISOString(), closed: !!closing, __etag: -1 };
  try {
    const r = await adoFetch(PRESENCE_URL(), { method: 'PUT', body: JSON.stringify(doc), headers: { Authorization: authHeader(pat), Accept: 'application/json', 'Content-Type': 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' }, signal: AbortSignal.timeout(closing ? 2500 : 15000) });
    if (!r.ok) log('Presença: o Azure respondeu', r.status);
  } catch (e) { log('Presença: não consegui enviar', e?.cause || e); }
}
// a cada 5 min, só se a janela deu sinal nos últimos 6 min (evita "fantasma" com o app esquecido sem janela)
setTimeout(() => presenceBeat(false), 5000);
setInterval(() => { if (Date.now() - lastPing < 360e3) presenceBeat(false); }, 300e3);

// ───────── Início ─────────
loadConfig();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && AFTER_UPDATE && listenTries < 40) {
    // a versão anterior ainda está liberando a porta
    listenTries++; setTimeout(() => server.listen(PORT, HOST), 250); return;
  }
  if (e.code === 'EADDRINUSE') {
    // Já está aberto: só traz outra janela para o servidor que já roda
    log('Já existe uma instância; abrindo janela');
    openDefaultOrApp(`http://${HOST}:${PORT}/`);
    setTimeout(() => process.exit(0), 3000);
  } else { log('Erro do servidor', e); messageBox(`Não consegui iniciar: ${e.message}`); process.exit(1); }
});
function openDefaultOrApp(url) {
  const edge = IS_WIN && findEdge();
  if (edge) spawn(edge, [`--app=${url}`, `--user-data-dir=${path.join(DATA_DIR, 'janela')}`], { stdio: 'ignore', detached: true }).unref();
  else if (IS_WIN) openDefaultBrowser(url);
}
let listenTries = 0, apiCalls = 0, lastApiAt = 0;
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  log('Rodando em', url, 'configurado:', !!config);
  if (!AFTER_UPDATE) return openWindow(url);
  // Depois de atualizar, a janela que já estava aberta recarrega e manda sinal a cada 5 s. Nas versões
  // até a 1.1.5 o Edge ficava preso ao processo antigo e fechava junto com ele: se a janela ficar 8 s
  // sem dar sinal, abre uma nova.
  lastPing = Date.now();
  const t0 = Date.now();
  const watch = setInterval(() => {
    const now = Date.now();
    if (now - t0 > 90000) return clearInterval(watch);
    if (now - t0 > 6000 && now - (lastApiAt || t0) > 8000) {
      clearInterval(watch);
      log('Depois de atualizar: nenhuma janela ativa; abrindo uma nova');
      openWindow(url);
    }
  }, 1000);
});
