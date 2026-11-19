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
const LOG_FILE = path.join(DATA_DIR, 'app.log');
const APP_TOKEN = crypto.randomBytes(24).toString('hex');
const NO_WINDOW = process.argv.includes('--no-window');
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
log(`Iniciando (pid ${process.pid}, node ${process.version}${process.env.AH_CHILD ? ', processo em segundo plano' : ''})`);

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
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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

    // Ponte para o Clockin: só responde a quem manda o cabeçalho próprio (páginas comuns não conseguem
    // mandar cabeçalho customizado para cá sem CORS, e este endpoint não libera CORS).
    if (url.pathname === '/api/export' && req.method === 'GET') {
      if (req.headers['x-apontador-bridge'] !== 'clockin') return send(res, 403, { message: 'Acesso negado' });
      if (!config || !pat) return send(res, 409, { message: 'Abra o Apontador de Horas e conecte seu token do Azure primeiro.' });
      const from = new Date(url.searchParams.get('from') || ''), to = new Date(url.searchParams.get('to') || '');
      if (isNaN(from) || isNaN(to) || to <= from || to - from > 62 * 864e5) return send(res, 400, { message: 'Período inválido (máx. 62 dias).' });
      try {
        const sessions = await exportSessions(from, to);
        log('Exportadas', sessions.length, 'sessões para o Clockin');
        return send(res, 200, { email: config.email, sessions });
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
    lastPing = Date.now();
    clearTimeout(byeTimer);

    if (url.pathname === '/api/ping') return send(res, 200, { ok: true });
    if (url.pathname === '/api/status') {
      return send(res, 200, config && pat
        ? { configured: true, org: config.org, project: config.project, me: { email: config.email, name: config.name }, expiresAt: config.expiresAt || null }
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
      if (!['GET', 'POST', 'PATCH'].includes(req.method)) return send(res, 405, { message: 'Método não permitido' });
      const rest = url.pathname.slice('/api/ado'.length); // começa com /
      const target = new URL(`https://dev.azure.com/${encodeURIComponent(config.org)}${rest}${url.search}`);
      if (target.hostname !== 'dev.azure.com' || !target.pathname.startsWith(`/${config.org}/`) || target.pathname.includes('/../')) {
        return send(res, 400, { message: 'Caminho inválido' });
      }
      const body = req.method === 'GET' ? undefined : await readBody(req);
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
      let status = upstream.status;
      if (status === 203 || status === 302) status = 401; // Azure responde assim quando o token não vale
      if (status === 401) return send(res, 401, { message: 'O Azure recusou o token (expirado ou sem permissão). Abra ⚙ e informe um novo.' });
      return send(res, status, buf, upstream.headers.get('content-type') || 'application/json');
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
    ], { stdio: 'ignore', windowsHide: false, detached: false });
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
  try { server.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}
// Sem janela do Edge (navegador padrão), encerra se a página ficar 3 min sem dar sinal
setInterval(() => { if (!windowProc && !NO_WINDOW && IS_WIN && Date.now() - lastPing > 3 * 60e3) shutdown(); }, 30e3);

// ───────── Início ─────────
loadConfig();
server.on('error', (e) => {
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
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  log('Rodando em', url, 'configurado:', !!config);
  openWindow(url);
});
