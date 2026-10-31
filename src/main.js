const path = require('node:path');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const net = require('node:net');
const {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  dialog,
  Menu,
  net: electronNet,
  clipboard,
  safeStorage,
  shell
} = require('electron');
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const PASSKEY_RP_ID = 'localhost';
const PASSKEY_HOST = PASSKEY_RP_ID;
const PASSWORD_UNLOCK_MS = 60_000;
const APP_ICON_PATH = path.join(__dirname, 'assets', 'aurabrowser.ico');
const SHELL_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const TRACKER_DOMAINS = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'connect.facebook.net',
  'pixel.facebook.com',
  'ads-twitter.com',
  'analytics.tiktok.com',
  'hotjar.com',
  'segment.io',
  'scorecardresearch.com',
  'quantserve.com'
];
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref_src'
]);

const DEFAULT_SHORTCUTS = {
  newTab: 'Ctrl+T',
  focusAddress: 'Ctrl+L',
  closeTab: 'Ctrl+W',
  reload: 'Ctrl+R',
  back: 'Alt+ArrowLeft',
  forward: 'Alt+ArrowRight',
  glance: 'Ctrl+Shift+G',
  split: 'Ctrl+Shift+S',
  settings: 'Ctrl+,',
  devtools: 'F12',
  find: 'Ctrl+F',
  zoomIn: 'Ctrl+Plus',
  zoomOut: 'Ctrl+-',
  zoomReset: 'Ctrl+0',
  nextTab: 'Ctrl+Tab',
  previousTab: 'Ctrl+Shift+Tab',
  reopenTab: 'Ctrl+Shift+T',
  fullscreen: 'F11'
};
// Always-on extras that mirror other browsers. User-assigned shortcuts take priority.
const BUILTIN_SHORTCUTS = { 'F5': 'reload', 'Ctrl+F5': 'hardReload', 'Ctrl+Shift+R': 'hardReload', 'Ctrl+PageDown': 'nextTab', 'Ctrl+PageUp': 'previousTab', 'Alt+Home': 'home', 'Escape': 'stop' };
const DEFAULT_PREFERENCES = {
  blockTrackers: true,
  httpsOnly: true,
  blockPopups: true,
  searchEngine: 'brave',
  interfaceSize: 'medium',
  pageZoom: 1,
  theme: 'dark',
  language: 'en',
  country: 'IN',
  profileName: 'Personal',
  reducedMotion: false,
  downloadDirectory: '',
  memorySaverMinutes: 1,
  setupComplete: false,
  shortcuts: { ...DEFAULT_SHORTCUTS }
};
const SUPPORTED_LANGUAGES = ['en', 'hi', 'es', 'fr', 'de', 'ja', 'pt'];
const SUPPORTED_COUNTRIES = ['IN', 'US', 'GB', 'CA', 'AU', 'NZ', 'DE', 'FR', 'JP', 'BR', 'SG'];
let mainWindow = null;
let tabs = [];
let bookmarks = [];
let importedBrowserData = { history: [], autofill: [] };
let savedPasswords = [];
let passwordPasskey = null;
let passwordVaultUnlockedUntil = 0;
let passwordVaultLockTimer = null;
let passkeyServer = null;
let passkeyServerV6 = null;
let passkeyServerPort = 0;
let passkeyWindow = null;
let pendingPasskeyFlow = null;
let pendingPasskeyChallenge = null;
let downloads = [];
let historySaveTimer = null;
let activeId = null;
let split = null;
let internalPage = null;
let tabDragActive = false;
let stageBounds = { x: 270, y: 138, width: 800, height: 600 };
let preferences = { ...DEFAULT_PREFERENCES, shortcuts: { ...DEFAULT_SHORTCUTS } };
let shortcutCapture = false;
let torProcess = null;
let torResources = null;
let torStatus = 'off';
let torPort = null;

function sanitizeProfileName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Personal';
}

function preferencesPath() {
  return path.join(app.getPath('userData'), 'aura-preferences.json');
}

function loadPreferences() {
  try {
    const stored = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
    preferences = {
      ...DEFAULT_PREFERENCES,
      blockTrackers: typeof stored.blockTrackers === 'boolean' ? stored.blockTrackers : DEFAULT_PREFERENCES.blockTrackers,
      httpsOnly: typeof stored.httpsOnly === 'boolean' ? stored.httpsOnly : DEFAULT_PREFERENCES.httpsOnly,
      blockPopups: typeof stored.blockPopups === 'boolean' ? stored.blockPopups : DEFAULT_PREFERENCES.blockPopups,
      searchEngine: Object.hasOwn(SEARCH_ENGINES, stored.searchEngine) ? stored.searchEngine : 'brave',
      interfaceSize: ['small', 'medium', 'large'].includes(stored.interfaceSize) ? stored.interfaceSize : 'medium',
      pageZoom: Number.isFinite(Number(stored.pageZoom)) ? Math.min(2, Math.max(0.5, Number(stored.pageZoom))) : 1,
      theme: ['dark', 'light'].includes(stored.theme) ? stored.theme : 'dark',
      language: SUPPORTED_LANGUAGES.includes(stored.language) ? stored.language : 'en',
      country: SUPPORTED_COUNTRIES.includes(stored.country) ? stored.country : 'IN',
      profileName: sanitizeProfileName(stored.profileName),
      reducedMotion: typeof stored.reducedMotion === 'boolean' ? stored.reducedMotion : false,
      downloadDirectory: typeof stored.downloadDirectory === 'string' && fs.existsSync(stored.downloadDirectory) && fs.statSync(stored.downloadDirectory).isDirectory() ? stored.downloadDirectory : '',
      memorySaverMinutes: [0, 1, 5, 15].includes(Number(stored.memorySaverMinutes)) ? Number(stored.memorySaverMinutes) : 1,
      setupComplete: typeof stored.setupComplete === 'boolean' ? stored.setupComplete : true,
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(stored.shortcuts || {}) }
    };
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
      if (typeof preferences.shortcuts[key] !== 'string' || preferences.shortcuts[key].length > 48) {
        preferences.shortcuts[key] = DEFAULT_SHORTCUTS[key];
      }
    }
  } catch {
    preferences = { ...DEFAULT_PREFERENCES, shortcuts: { ...DEFAULT_SHORTCUTS } };
  }
}

function savePreferences() {
  const file = preferencesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(preferences, null, 2), 'utf8');
}

function mergePreferences(update) {
  if (!update || typeof update !== 'object') return;
  if (typeof update.blockTrackers === 'boolean') preferences.blockTrackers = update.blockTrackers;
  if (typeof update.httpsOnly === 'boolean') preferences.httpsOnly = update.httpsOnly;
  if (typeof update.blockPopups === 'boolean') preferences.blockPopups = update.blockPopups;
  if (Object.hasOwn(SEARCH_ENGINES, update.searchEngine)) preferences.searchEngine = update.searchEngine;
  if (['small', 'medium', 'large'].includes(update.interfaceSize)) preferences.interfaceSize = update.interfaceSize;
  if (Number.isFinite(Number(update.pageZoom))) preferences.pageZoom = Math.min(2, Math.max(0.5, Number(update.pageZoom)));
  if (['dark', 'light'].includes(update.theme)) preferences.theme = update.theme;
  if (SUPPORTED_LANGUAGES.includes(update.language)) preferences.language = update.language;
  if (SUPPORTED_COUNTRIES.includes(update.country)) preferences.country = update.country;
  if (typeof update.profileName === 'string') preferences.profileName = sanitizeProfileName(update.profileName);
  if (typeof update.reducedMotion === 'boolean') preferences.reducedMotion = update.reducedMotion;
  if (typeof update.downloadDirectory === 'string' && (!update.downloadDirectory || (fs.existsSync(update.downloadDirectory) && fs.statSync(update.downloadDirectory).isDirectory()))) preferences.downloadDirectory = update.downloadDirectory;
  if ([0, 1, 5, 15].includes(Number(update.memorySaverMinutes))) preferences.memorySaverMinutes = Number(update.memorySaverMinutes);
  if (update.shortcuts && typeof update.shortcuts === 'object') {
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
      const value = update.shortcuts[key];
      if (typeof value === 'string' && value.length <= 48) preferences.shortcuts[key] = canonicalShortcut(value);
    }
  }
  savePreferences();
  for (const tab of tabs) {
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.setZoomFactor(preferences.pageZoom);
  }
}

const SEARCH_ENGINES = {
  brave: { home: 'https://search.brave.com/', query: 'https://search.brave.com/search?q=' },
  duckduckgo: { home: 'https://duckduckgo.com/', query: 'https://duckduckgo.com/?q=' },
  google: { home: 'https://www.google.com/', query: 'https://www.google.com/search?q=' },
  bing: { home: 'https://www.bing.com/', query: 'https://www.bing.com/search?q=' },
  startpage: { home: 'https://www.startpage.com/', query: 'https://www.startpage.com/do/search?q=' },
  ecosia: { home: 'https://www.ecosia.org/', query: 'https://www.ecosia.org/search?q=' }
};
function currentEngine() {
  return SEARCH_ENGINES[preferences.searchEngine] || SEARCH_ENGINES.brave;
}
function searchHomeUrl() {
  return currentEngine().home;
}

function searchUrl(query) {
  return currentEngine().query + encodeURIComponent(query);
}
function safeFavicon(raw, pageUrl) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  if (/^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp);base64,/i.test(raw)) return raw;
  try {
    const icon = new URL(raw, pageUrl);
    if (!['http:', 'https:'].includes(icon.protocol) || icon.username || icon.password) return null;
    return icon.href;
  } catch {}
  return null;
}

function isTrustedShell(sender, frame) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents && sender.getURL() === SHELL_URL && frame?.url === SHELL_URL);
}

function requireTrustedShell(event) {
  if (!isTrustedShell(event.sender, event.senderFrame)) throw new Error('Untrusted IPC sender');
}

function normalizeUrl(input, options = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return searchHomeUrl();

  let candidate = raw;
  if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
    if (/\s/.test(candidate) || !candidate.includes('.')) {
      return searchUrl(candidate);
    }
    candidate = 'https://' + candidate;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if ((options.httpsOnly ?? preferences.httpsOnly) && url.protocol === 'http:') {
    url.protocol = 'https:';
  }

  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) url.searchParams.delete(key);
  }
  return url.href;
}

function isTrackerUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return TRACKER_DOMAINS.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

function findTab(id) {
  return tabs.find((tab) => tab.id === id);
}

function bookmarksPath() {
  return path.join(app.getPath('userData'), 'aura-bookmarks.json');
}

function safeBookmarkUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function loadBookmarks() {
  try {
    const stored = JSON.parse(fs.readFileSync(bookmarksPath(), 'utf8'));
    bookmarks = (Array.isArray(stored) ? stored : []).map((item) => {
      const url = safeBookmarkUrl(item?.url);
      if (!url) return null;
      return {
        id: typeof item.id === 'string' ? item.id.slice(0, 80) : randomUUID(),
        title: String(item.title || new URL(url).hostname).slice(0, 300),
        url,
        folder: String(item.folder || '').slice(0, 300),
        source: String(item.source || 'AuraBrowser').slice(0, 80)
      };
    }).filter(Boolean);
  } catch { bookmarks = []; }
}

function saveBookmarks() {
  const file = bookmarksPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(bookmarks, null, 2), 'utf8');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(x[\da-f]+|\d+);?/gi, (_match, code) => {
      const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      try { return Number.isFinite(number) ? String.fromCodePoint(number) : ''; } catch { return ''; }
    });
}

function normalizeImportedBookmark(title, rawUrl, folder, source) {
  const url = safeBookmarkUrl(decodeHtmlEntities(rawUrl));
  if (!url) return null;
  const cleanTitle = decodeHtmlEntities(String(title || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return {
    id: randomUUID(),
    title: (cleanTitle || new URL(url).hostname).slice(0, 300),
    url,
    folder: String(folder || '').slice(0, 300),
    source
  };
}

function parseChromiumBookmarks(content, source) {
  const data = JSON.parse(content);
  const found = [];
  const roots = data.roots || data.bookmarks?.roots || {};
  function walk(node, folder = '') {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url' && node.url) {
      const bookmark = normalizeImportedBookmark(node.name, node.url, folder, source);
      if (bookmark) found.push(bookmark);
      return;
    }
    const nextFolder = [folder, node.name].filter(Boolean).join(' / ');
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, nextFolder);
  }
  for (const root of Object.values(roots)) walk(root);
  return found;
}

function parseBookmarkHtml(content, source) {
  const found = [];
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchors.exec(content))) {
    const attributes = match[1];
    const href = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!href) continue;
    const bookmark = normalizeImportedBookmark(match[2], href[1] || href[2] || href[3], '', source);
    if (bookmark) found.push(bookmark);
  }
  return found;
}

function browserBookmarkRoots(browser) {
  const home = app.getPath('home');
  const platform = process.platform;
  const roots = {
    chrome: platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')]
      : (platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')] : [path.join(home, '.config', 'google-chrome'), path.join(home, '.config', 'chromium')]),
    edge: platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data')]
      : (platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', 'Microsoft Edge')] : [path.join(home, '.config', 'microsoft-edge')]),
    brave: platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'BraveSoftware', 'Brave-Browser', 'User Data')]
      : (platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')] : [path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'), path.join(home, '.config', 'brave-browser')])
  };
  return roots[browser] || [];
}

function findChromiumBookmarksFiles(browser) {
  const candidates = [];
  for (const root of browserBookmarkRoots(browser)) {
    if (!fs.existsSync(root)) continue;
    const direct = path.join(root, 'Bookmarks');
    if (fs.existsSync(direct)) candidates.push(direct);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !(/^(Default|Profile\s+\d+)$/i.test(entry.name))) continue;
      const file = path.join(root, entry.name, 'Bookmarks');
      if (fs.existsSync(file)) candidates.push(file);
    }
  }
  return [...new Set(candidates)].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function importBookmarkFile(filePath, source) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Choose a bookmark file smaller than 25 MB.');
  const content = fs.readFileSync(filePath, 'utf8');
  const trimmed = content.trimStart();
  let incoming;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) incoming = parseChromiumBookmarks(content, source);
  else incoming = parseBookmarkHtml(content, source);
  const known = new Set(bookmarks.map((item) => item.url));
  const unique = incoming.filter((item) => !known.has(item.url) && known.add(item.url));
  const added = unique;
  bookmarks.push(...added);
  saveBookmarks();
  return { imported: added.length, total: bookmarks.length };
}

function toggleActiveBookmark() {
  const tab = findTab(activeId);
  const url = safeBookmarkUrl(tab?.view?.webContents.getURL() || tab?.url);
  if (!url) return { saved: false, total: bookmarks.length };
  const existing = bookmarks.findIndex((bookmark) => bookmark.url === url);
  if (existing >= 0) bookmarks.splice(existing, 1);
  else bookmarks.unshift({ id: randomUUID(), title: String(tab.view?.webContents.getTitle() || tab.title || new URL(url).hostname).slice(0, 300), url, folder: '', source: 'AuraBrowser' });
  saveBookmarks();
  sendState();
  return { saved: existing < 0, total: bookmarks.length };
}

function privateBrowserDataPath() { return path.join(app.getPath('userData'), 'aura-browser-data.enc'); }
function passwordVaultPath() { return path.join(app.getPath('userData'), 'aura-passwords.enc'); }
function saveEncryptedJson(file, value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure local storage is unavailable on this device.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(value)));
}
function loadPrivateBrowserData() {
  try {
    const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(privateBrowserDataPath())));
    importedBrowserData = { history: Array.isArray(value.history) ? value.history : [], autofill: Array.isArray(value.autofill) ? value.autofill : [] };
  } catch { importedBrowserData = { history: [], autofill: [] }; }
  try {
    const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(passwordVaultPath())));
    savedPasswords = Array.isArray(value) ? value : [];
  } catch { savedPasswords = []; }
  try { passwordPasskey = JSON.parse(safeStorage.decryptString(fs.readFileSync(passwordPasskeyPath()))); }
  catch { passwordPasskey = null; }
}
function savePrivateBrowserData() { saveEncryptedJson(privateBrowserDataPath(), importedBrowserData); }
function savePasswordVault() { saveEncryptedJson(passwordVaultPath(), savedPasswords); }
function passwordPasskeyPath() { return path.join(app.getPath('userData'), 'aura-password-passkey.enc'); }
function passkeyOrigin() {
  if (!passkeyServerPort) throw new Error('The local passkey service is not ready. Restart AuraBrowser and try again.');
  return 'http://' + PASSKEY_HOST + ':' + passkeyServerPort;
}
function passwordVaultStatus() {
  return { enrolled: Boolean(passwordPasskey), unlocked: isPasswordVaultUnlocked(), passwordCount: savedPasswords.length };
}
function isPasswordVaultUnlocked() {
  if (passwordVaultUnlockedUntil && Date.now() >= passwordVaultUnlockedUntil) lockPasswordVault();
  return Date.now() < passwordVaultUnlockedUntil;
}
function lockPasswordVault() {
  const wasUnlocked = passwordVaultUnlockedUntil > Date.now();
  passwordVaultUnlockedUntil = 0;
  if (passwordVaultLockTimer) clearTimeout(passwordVaultLockTimer);
  passwordVaultLockTimer = null;
  if (wasUnlocked && mainWindow && !mainWindow.isDestroyed()) publishState();
}
function unlockPasswordVault() {
  passwordVaultUnlockedUntil = Date.now() + PASSWORD_UNLOCK_MS;
  if (passwordVaultLockTimer) clearTimeout(passwordVaultLockTimer);
  passwordVaultLockTimer = setTimeout(() => lockPasswordVault(), PASSWORD_UNLOCK_MS);
  passwordVaultLockTimer.unref?.();
  publishState();
}
function isTrustedPasskeyWindow(event) {
  if (!passkeyWindow || passkeyWindow.isDestroyed() || event.sender !== passkeyWindow.webContents) return false;
  try {
    const current = new URL(event.sender.getURL());
    const frame = new URL(event.senderFrame?.url || 'about:blank');
    return current.origin === passkeyOrigin() && current.pathname === '/passkey.html'
      && frame.origin === current.origin && frame.pathname === current.pathname;
  } catch { return false; }
}
function requireTrustedPasskeyWindow(event) {
  if (!isTrustedPasskeyWindow(event)) throw new Error('Untrusted password-vault window.');
}
function startPasskeyOriginServer() {
  return new Promise((resolve, reject) => {
    const files = {
      '/passkey.html': ['passkey.html', 'text/html; charset=utf-8'],
      '/passkey.js': ['passkey.js', 'text/javascript; charset=utf-8'],
      '/passkey.css': ['passkey.css', 'text/css; charset=utf-8'],
      '/assets/aurabrowser-logo.png': ['assets/aurabrowser-logo.png', 'image/png']
    };
    const handleRequest = (request, response) => {
      const remote = request.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const expectedHost = PASSKEY_HOST + ':' + passkeyServerPort;
      if (String(request.headers.host || '').toLowerCase() !== expectedHost || request.method !== 'GET') {
        response.writeHead(404).end('Not found');
        return;
      }
      let pathname;
      try { pathname = new URL(request.url || '/', 'http://' + expectedHost).pathname; }
      catch { response.writeHead(400).end('Bad request'); return; }
      const entry = files[pathname];
      if (!entry) { response.writeHead(404).end('Not found'); return; }
      response.writeHead(200, {
        'Content-Type': entry[1],
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      });
      fs.createReadStream(path.join(__dirname, entry[0])).pipe(response);
    };
    passkeyServer = http.createServer(handleRequest);
    passkeyServer.once('error', reject);
    passkeyServer.listen(0, '127.0.0.1', () => {
      passkeyServerPort = passkeyServer.address().port;
      passkeyServerV6 = http.createServer(handleRequest);
      passkeyServerV6.once('error', () => { passkeyServerV6 = null; resolve(passkeyServerPort); });
      passkeyServerV6.listen(passkeyServerPort, '::1', () => resolve(passkeyServerPort));
    });
  });
}
// Vault PIN: a fallback "passkey" for PCs without Windows Hello, a phone or a security key.
const VAULT_PIN_MIN = 4;
const VAULT_PIN_MAX_FAILURES = 5;
const VAULT_PIN_LOCKOUT_MS = 30_000;
let vaultPinFailures = 0;
let vaultPinLockedUntil = 0;
function hashVaultPin(pin, salt) {
  return scryptSync(String(pin).normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
}
function getPasskeyInfo(event) {
  requireTrustedPasskeyWindow(event);
  const flow = pendingPasskeyFlow;
  if (!flow) throw new Error('This passkey request is no longer active.');
  return { mode: flow.mode, kind: passwordPasskey?.kind === 'pin' ? 'pin' : (passwordPasskey ? 'passkey' : null) };
}
function completeVaultUnlock() {
  unlockPasswordVault();
  const flow = pendingPasskeyFlow;
  pendingPasskeyFlow = null;
  flow?.resolve({ ok: true });
  setTimeout(() => { if (passkeyWindow && !passkeyWindow.isDestroyed()) passkeyWindow.close(); }, 100);
  return { ok: true };
}
function setupVaultPin(event, pin) {
  requireTrustedPasskeyWindow(event);
  if (pendingPasskeyFlow?.mode !== 'register') throw new Error('This passkey request is no longer active.');
  if (passwordPasskey) throw new Error('A password-vault passkey is already set up.');
  if (typeof pin !== 'string' || pin.length < VAULT_PIN_MIN || pin.length > 128) throw new Error('Use at least ' + VAULT_PIN_MIN + ' characters for your vault PIN.');
  const salt = randomBytes(16);
  const record = { kind: 'pin', salt: salt.toString('base64url'), hash: hashVaultPin(pin, salt).toString('base64url'), createdAt: new Date().toISOString() };
  saveEncryptedJson(passwordPasskeyPath(), record);
  passwordPasskey = record;
  return completeVaultUnlock();
}
function verifyVaultPin(event, pin) {
  requireTrustedPasskeyWindow(event);
  if (pendingPasskeyFlow?.mode !== 'authenticate') throw new Error('This passkey request is no longer active.');
  if (passwordPasskey?.kind !== 'pin') throw new Error('This vault uses a passkey, not a PIN.');
  if (Date.now() < vaultPinLockedUntil) throw new Error('Too many wrong attempts. Wait ' + Math.ceil((vaultPinLockedUntil - Date.now()) / 1000) + ' seconds.');
  const expected = Buffer.from(passwordPasskey.hash, 'base64url');
  const actual = hashVaultPin(typeof pin === 'string' ? pin : '', Buffer.from(passwordPasskey.salt, 'base64url'));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    vaultPinFailures += 1;
    if (vaultPinFailures >= VAULT_PIN_MAX_FAILURES) { vaultPinFailures = 0; vaultPinLockedUntil = Date.now() + VAULT_PIN_LOCKOUT_MS; }
    throw new Error('That PIN is not correct.');
  }
  vaultPinFailures = 0;
  return completeVaultUnlock();
}
async function getPasskeyOptions(event, mode) {
  requireTrustedPasskeyWindow(event);
  if (passwordPasskey?.kind === 'pin') throw new Error('This vault is protected with a PIN.');
  const flow = pendingPasskeyFlow;
  if (!flow || !['register', 'authenticate'].includes(mode) || flow.mode !== mode) throw new Error('This passkey request is no longer active.');
  if (mode === 'register') {
    if (passwordPasskey) throw new Error('A password-vault passkey is already set up.');
    const options = await generateRegistrationOptions({
      rpName: 'AuraBrowser Password Vault',
      rpID: PASSKEY_RP_ID,
      userName: os.userInfo().username || 'AuraBrowser user',
      userDisplayName: preferences.profileName || os.userInfo().username || 'AuraBrowser user',
      userID: randomBytes(16),
      timeout: 120000,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }
    });
    pendingPasskeyChallenge = { mode, challenge: options.challenge, expiresAt: Date.now() + 120000 };
    return options;
  }
  if (!passwordPasskey) throw new Error('Set up a passkey before opening saved passwords.');
  const options = await generateAuthenticationOptions({
    rpID: PASSKEY_RP_ID,
    timeout: 120000,
    userVerification: 'required',
    allowCredentials: [{ id: passwordPasskey.id, transports: passwordPasskey.transports || [] }]
  });
  pendingPasskeyChallenge = { mode, challenge: options.challenge, expiresAt: Date.now() + 120000 };
  return options;
}
async function completePasskeyOperation(event, mode, response) {
  requireTrustedPasskeyWindow(event);
  const pending = pendingPasskeyChallenge;
  if (!pending || pending.mode !== mode || pending.expiresAt < Date.now()) throw new Error('Passkey request expired. Try again.');
  pendingPasskeyChallenge = null;
  if (!response || typeof response !== 'object') throw new Error('The authenticator did not return a credential.');
  if (mode === 'register') {
    if (passwordPasskey) throw new Error('A password-vault passkey is already set up.');
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: passkeyOrigin(),
      expectedRPID: PASSKEY_RP_ID,
      requireUserVerification: true
    });
    if (!result.verified || !result.registrationInfo?.userVerified) throw new Error('The passkey could not verify your identity.');
    const credential = result.registrationInfo.credential;
    const newPasskey = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports || []
    };
    saveEncryptedJson(passwordPasskeyPath(), newPasskey);
    passwordPasskey = newPasskey;
  } else {
    if (!passwordPasskey || response.id !== passwordPasskey.id) throw new Error('That passkey is not registered for this password vault.');
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: passkeyOrigin(),
      expectedRPID: PASSKEY_RP_ID,
      credential: {
        id: passwordPasskey.id,
        publicKey: Buffer.from(passwordPasskey.publicKey, 'base64url'),
        counter: passwordPasskey.counter,
        transports: passwordPasskey.transports || []
      },
      requireUserVerification: true
    });
    if (!result.verified || !result.authenticationInfo.userVerified) throw new Error('The passkey could not verify your identity.');
    const updatedPasskey = { ...passwordPasskey, counter: result.authenticationInfo.newCounter };
    saveEncryptedJson(passwordPasskeyPath(), updatedPasskey);
    passwordPasskey = updatedPasskey;
  }
  return completeVaultUnlock();
}
function finishPasskeyFlow(result) {
  pendingPasskeyChallenge = null;
  const flow = pendingPasskeyFlow;
  pendingPasskeyFlow = null;
  flow?.resolve(result);
  if (passkeyWindow && !passkeyWindow.isDestroyed()) passkeyWindow.close();
}
function openPasswordPasskeyFlow() {
  if (!passkeyServerPort) throw new Error('The local passkey service is unavailable. Restart AuraBrowser and try again.');
  if (passkeyWindow && !passkeyWindow.isDestroyed()) throw new Error('A passkey prompt is already open.');
  const mode = passwordPasskey ? 'authenticate' : 'register';
  return new Promise((resolve) => {
    pendingPasskeyFlow = { mode, resolve };
    const child = new BrowserWindow({
      parent: mainWindow,
      modal: true,
      width: 460,
      height: 520,
      minWidth: 420,
      minHeight: 480,
      resizable: true,
      show: false,
      title: mode === 'register' ? 'Set up password passkey' : 'Unlock saved passwords',
      icon: APP_ICON_PATH,
      autoHideMenuBar: true,
      backgroundColor: '#0c1112',
      webPreferences: {
        preload: path.join(__dirname, 'passkey-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });
    passkeyWindow = child;
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event, target) => {
      try { if (new URL(target).origin !== passkeyOrigin()) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
    child.once('ready-to-show', () => child.show());
    child.once('closed', () => {
      passkeyWindow = null;
      pendingPasskeyChallenge = null;
      const flow = pendingPasskeyFlow;
      pendingPasskeyFlow = null;
      flow?.resolve({ ok: false, cancelled: true });
    });
    child.loadURL(passkeyOrigin() + '/passkey.html?mode=' + mode).catch((error) => {
      const flow = pendingPasskeyFlow;
      pendingPasskeyFlow = null;
      pendingPasskeyChallenge = null;
      flow?.resolve({ ok: false, error: error.message });
      if (!child.isDestroyed()) child.destroy();
    });
  });
}

function importHttpUrl(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function mergeImportedHistory(rows) {
  const known = new Set(importedBrowserData.history.map((item) => item.key)); let added = 0;
  for (const row of rows) {
    const url = importHttpUrl(row.url); if (!url) continue;
    const visitedAt = Number(row.visitedAt) || Date.now();
    const key = url + '\u0000' + visitedAt;
    if (known.has(key)) continue;
    known.add(key);
    importedBrowserData.history.push({ id: randomUUID(), key, url, title: String(row.title || url).slice(0, 500), visitedAt });
    added += 1;
  }
  importedBrowserData.history.sort((a, b) => b.visitedAt - a.visitedAt);
  return added;
}
function mergeImportedAutofill(rows) {
  const known = new Set(importedBrowserData.autofill.map((item) => item.key)); let added = 0;
  for (const row of rows) {
    const name = String(row.name || '').slice(0, 200), value = String(row.value || '').slice(0, 4000);
    if (!name || !value || /(pass(word|wd)|credit.?card|card.?number|cardholder|^cc[-_]|cvv|cvc|iban|security.?code)/i.test(name)) continue;
    const key = name.toLowerCase() + '\u0000' + value.toLowerCase(); if (known.has(key)) continue;
    known.add(key); importedBrowserData.autofill.push({ id: randomUUID(), key, name, value, source: String(row.source || 'Imported browser data').slice(0, 80) }); added += 1;
  }
  return added;
}
function queueHistorySave() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => { try { savePrivateBrowserData(); } catch {} }, 350);
  historySaveTimer.unref?.();
}
function recordBrowserHistory(url, title) {
  const safeUrl = importHttpUrl(url); if (!safeUrl) return;
  mergeImportedHistory([{ url: safeUrl, title, visitedAt: Date.now() }]);
  queueHistorySave();
}
function sqliteTableExists(db, table) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function sqliteColumns(db, table) { return db.prepare('PRAGMA table_info(' + JSON.stringify(table) + ')').all().map((item) => item.name); }
function readOnlySqlite(file, callback) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true, timeout: 3000 }); return callback(db); }
  finally { try { db?.close(); } catch {} }
}
function readChromiumHistory(file) {
  return readOnlySqlite(file, (db) => {
    if (!sqliteTableExists(db, 'urls')) return [];
    if (sqliteTableExists(db, 'visits')) return db.prepare("SELECT u.url,u.title,v.visit_time AS visitedAt FROM visits v JOIN urls u ON u.id=v.url WHERE v.visit_time>0 AND u.url LIKE 'http%' ORDER BY v.visit_time DESC").all().map((row) => ({ url: row.url, title: row.title || row.url, visitedAt: Math.floor((Number(row.visitedAt) - 11644473600000000) / 1000) }));
    return db.prepare("SELECT url,title,last_visit_time AS visitedAt FROM urls WHERE last_visit_time>0 AND url LIKE 'http%' ORDER BY last_visit_time DESC").all().map((row) => ({ url: row.url, title: row.title || row.url, visitedAt: Math.floor((Number(row.visitedAt) - 11644473600000000) / 1000) }));
  });
}
function readFirefoxHistory(file) {
  return readOnlySqlite(file, (db) => {
    if (!sqliteTableExists(db, 'moz_places')) return [];
    if (sqliteTableExists(db, 'moz_historyvisits')) return db.prepare("SELECT p.url,p.title,v.visit_date AS visitedAt FROM moz_historyvisits v JOIN moz_places p ON p.id=v.place_id WHERE v.visit_date>0 AND p.url LIKE 'http%' ORDER BY v.visit_date DESC").all().map((row) => ({ url: row.url, title: row.title || row.url, visitedAt: Math.floor(Number(row.visitedAt) / 1000) }));
    return db.prepare("SELECT url,title,last_visit_date AS visitedAt FROM moz_places WHERE last_visit_date>0 AND url LIKE 'http%' ORDER BY last_visit_date DESC").all().map((row) => ({ url: row.url, title: row.title || row.url, visitedAt: Math.floor(Number(row.visitedAt) / 1000) }));
  });
}
function readAutofillDatabase(file, firefox = false) {
  return readOnlySqlite(file, (db) => {
    const result = [];
    if (firefox && sqliteTableExists(db, 'moz_formhistory')) return db.prepare("SELECT fieldname AS name,value FROM moz_formhistory WHERE value!='' ORDER BY timesUsed DESC").all().map((row) => ({ name: row.name, value: row.value, source: 'Firefox form history' }));
    if (sqliteTableExists(db, 'autofill')) {
      const columns = sqliteColumns(db, 'autofill');
      if (columns.includes('name') && columns.includes('value')) result.push(...db.prepare("SELECT name,value FROM autofill WHERE value!='' ORDER BY count DESC").all().map((row) => ({ name: row.name, value: row.value, source: 'Browser autofill' })));
    }
    if (sqliteTableExists(db, 'autofill_profiles')) {
      const columns = sqliteColumns(db, 'autofill_profiles');
      for (const row of db.prepare('SELECT * FROM autofill_profiles').all()) for (const column of columns) {
        if (['guid','label','use_count','use_date','date_modified'].includes(column)) continue;
        if (typeof row[column] === 'string' && row[column].trim()) result.push({ name: column, value: row[column].trim(), source: 'Address profile' });
      }
    }
    return result;
  });
}
function readProfileCookies(file, firefox = false) {
  return readOnlySqlite(file, (db) => {
    if (!sqliteTableExists(db, firefox ? 'moz_cookies' : 'cookies')) return { rows: [], encrypted: 0 };
    if (firefox) {
      const rows = db.prepare("SELECT host,name,value,path,expiry,isSecure,isHttpOnly,sameSite FROM moz_cookies WHERE value!=''").all();
      return { rows: rows.map((row) => {
        const host = String(row.host || '').trim(), secure = Boolean(row.isSecure); let url;
        try { url = new URL((secure ? 'https://' : 'http://') + host.replace(/^\./, '') + (row.path || '/')).href; } catch { return null; }
        const cookie = { url, name: row.name, value: row.value, path: row.path || '/', secure, httpOnly: Boolean(row.isHttpOnly), sameSite: Number(row.sameSite) === 1 ? 'lax' : Number(row.sameSite) === 2 ? 'strict' : 'unspecified' };
        if (host.startsWith('.')) cookie.domain = host;
        if (Number(row.expiry) > Date.now() / 1000) cookie.expirationDate = Number(row.expiry);
        return cookie;
      }).filter(Boolean), encrypted: 0 };
    }
    const columns = sqliteColumns(db, 'cookies'); if (!columns.includes('host_key')) return { rows: [], encrypted: 0 };
    const rows = db.prepare('SELECT * FROM cookies').all(); let encrypted = 0;
    const cookies = rows.map((row) => {
      if (!row.value && row.encrypted_value?.length) { encrypted += 1; return null; }
      if (!row.value) return null;
      const host = String(row.host_key || '').trim(), secure = Boolean(row.is_secure); let url;
      try { url = new URL((secure ? 'https://' : 'http://') + host.replace(/^\./, '') + (row.path || '/')).href; } catch { return null; }
      const sameSite = Number(row.samesite) === 1 ? 'lax' : Number(row.samesite) === 2 ? 'strict' : Number(row.samesite) === 3 ? 'no_restriction' : 'unspecified';
      const cookie = { url, name: row.name, value: row.value, path: row.path || '/', secure, httpOnly: Boolean(row.is_httponly), sameSite };
      if (host.startsWith('.')) cookie.domain = host;
      const expiry = (Number(row.expires_utc || 0) - 11644473600000000) / 1000000;
      if (expiry > Date.now() / 1000) cookie.expirationDate = Math.floor(expiry);
      return cookie;
    }).filter(Boolean);
    return { rows: cookies, encrypted };
  });
}
function firefoxBookmarkRows(file, source) {
  return readOnlySqlite(file, (db) => {
    if (!sqliteTableExists(db, 'moz_bookmarks') || !sqliteTableExists(db, 'moz_places')) return [];
    return db.prepare("SELECT b.title AS title,p.url AS url,f.title AS folder FROM moz_bookmarks b JOIN moz_places p ON p.id=b.fk LEFT JOIN moz_bookmarks f ON f.id=b.parent WHERE b.type=1 AND p.url LIKE 'http%' ORDER BY b.id").all().map((row) => normalizeImportedBookmark(row.title || row.url, row.url, row.folder || '', source)).filter(Boolean);
  });
}
function browserProfileRoots(browser) {
  const home = app.getPath('home'), local = process.env.LOCALAPPDATA || path.join(home,'AppData','Local'), roaming = process.env.APPDATA || path.join(home,'AppData','Roaming');
  if (browser === 'chrome') return process.platform === 'win32' ? [path.join(local,'Google','Chrome','User Data')] : process.platform === 'darwin' ? [path.join(home,'Library','Application Support','Google','Chrome')] : [path.join(home,'.config','google-chrome'),path.join(home,'.config','chromium')];
  if (browser === 'edge') return process.platform === 'win32' ? [path.join(local,'Microsoft','Edge','User Data')] : process.platform === 'darwin' ? [path.join(home,'Library','Application Support','Microsoft Edge')] : [path.join(home,'.config','microsoft-edge')];
  if (browser === 'brave') return process.platform === 'win32' ? [path.join(local,'BraveSoftware','Brave-Browser','User Data')] : process.platform === 'darwin' ? [path.join(home,'Library','Application Support','BraveSoftware','Brave-Browser')] : [path.join(home,'.config','BraveSoftware','Brave-Browser'),path.join(home,'.config','brave-browser')];
  if (browser === 'firefox') return process.platform === 'win32' ? [path.join(roaming,'Mozilla','Firefox','Profiles')] : process.platform === 'darwin' ? [path.join(home,'Library','Application Support','Firefox','Profiles')] : [path.join(home,'.mozilla','firefox')];
  return [];
}
function findBrowserProfiles(browser) {
  const profiles = [], seen = new Set();
  const add = (name, dir) => {
    const resolved = path.resolve(dir);
    const valid = browser === 'firefox' ? fs.existsSync(path.join(resolved,'places.sqlite')) : ['Bookmarks','History','Web Data','Preferences'].some((file) => fs.existsSync(path.join(resolved,file)));
    if (valid && !seen.has(resolved)) { seen.add(resolved); profiles.push({ name: name || path.basename(resolved), path: resolved }); }
  };
  for (const root of browserProfileRoots(browser)) {
    if (!fs.existsSync(root)) continue;
    if (browser === 'firefox') {
      const ini = path.join(path.dirname(root),'profiles.ini');
      try { for (const section of fs.readFileSync(ini,'utf8').split(/(?=^\[)/m)) {
        if (!/^\[Profile\d+\]/m.test(section)) continue;
        const profilePath = section.match(/^Path=(.+)$/m)?.[1]?.trim(); if (!profilePath) continue;
        const relative = section.match(/^IsRelative=(\d+)/m)?.[1] !== '0';
        add(path.basename(profilePath), relative ? path.resolve(path.dirname(ini),profilePath) : path.resolve(profilePath));
      } } catch {}
      const scan = (dir) => { let entries=[]; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; } for(const entry of entries){ if(!entry.isDirectory())continue; const child=path.join(dir,entry.name); if(fs.existsSync(path.join(child,'places.sqlite')))add(entry.name,child); else if(entry.name==='Profiles')scan(child); } };
      scan(root); continue;
    }
    let entries=[]; try { entries=fs.readdirSync(root,{withFileTypes:true}); } catch { continue; }
    const dirs=[root,...entries.filter((entry)=>entry.isDirectory()).map((entry)=>path.join(root,entry.name))];
    for(const dir of dirs){const name=path.basename(dir), isProfile=['Default','Profile ','Guest Profile'].some((prefix)=>name.startsWith(prefix))||dir===root;if(isProfile)add(name,dir);}
  }
  return profiles;
}
function readImportedSearchEngine(profile,browser) {
  try {
    if(browser==='firefox'){const prefs=fs.readFileSync(path.join(profile.path,'prefs.js'),'utf8'),name=prefs.match(/browser\.search\.defaultenginename[^\n]*?"([^"]+)"/)?.[1]?.toLowerCase()||'';if(name.includes('duckduckgo'))return'duckduckgo';if(name.includes('google'))return'google';if(name.includes('brave'))return'brave';return null;}
    const prefs=JSON.parse(fs.readFileSync(path.join(profile.path,'Preferences'),'utf8')),text=JSON.stringify(prefs.default_search_provider_data||{}).toLowerCase();if(text.includes('duckduckgo'))return'duckduckgo';if(text.includes('google'))return'google';if(text.includes('brave'))return'brave';
  } catch {}
  return null;
}
function parsePasswordCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=c;}
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}if(!rows.length)return[];
  const headers=rows.shift().map((item)=>item.trim().toLowerCase()),ui=headers.indexOf('url'),ni=headers.findIndex((item)=>['username','user name','login'].includes(item)),pi=headers.indexOf('password');if(ui<0||ni<0||pi<0)throw new Error('CSV needs url, username, and password columns.');
  return rows.map((values)=>({url:importHttpUrl(values[ui]),username:String(values[ni]||'').slice(0,1000),password:String(values[pi]||'').slice(0,4000)})).filter((item)=>item.url&&item.password);
}
function importPasswordRows(rows) {
  const known=new Set(savedPasswords.map((item)=>item.url+'\u0000'+item.username+'\u0000'+item.password));let added=0;
  for(const row of rows){const key=row.url+'\u0000'+row.username+'\u0000'+row.password;if(known.has(key))continue;known.add(key);savedPasswords.push({id:randomUUID(),...row});added++;}
  if(added)savePasswordVault();return added;
}
function mergeBrowserBookmarks(rows) {
  const known=new Set(bookmarks.map((item)=>item.url+'\u0000'+item.folder));const added=[];
  for(const item of rows){const key=item.url+'\u0000'+item.folder;if(known.has(key))continue;known.add(key);added.push(item);}
  bookmarks.push(...added);if(added.length)saveBookmarks();return added.length;
}
async function importBrowserProfile(browser) {
  const profiles=findBrowserProfiles(browser);if(!profiles.length)throw new Error('No '+browser+' profile was found on this device.');
  const result={browser,profiles:profiles.length,bookmarks:0,history:0,autofill:0,cookies:0,encryptedCookies:0,searchEngine:null,skipped:[]};
  for(const profile of profiles){try{
    if(browser==='firefox'){
      const places=path.join(profile.path,'places.sqlite');if(fs.existsSync(places)){result.bookmarks+=mergeBrowserBookmarks(firefoxBookmarkRows(places,'Mozilla Firefox'));result.history+=mergeImportedHistory(readFirefoxHistory(places));}
      const form=path.join(profile.path,'formhistory.sqlite');if(fs.existsSync(form))result.autofill+=mergeImportedAutofill(readAutofillDatabase(form,true));
      const cookieFile=path.join(profile.path,'cookies.sqlite');if(fs.existsSync(cookieFile)){const data=readProfileCookies(cookieFile,true);result.encryptedCookies+=data.encrypted;for(const cookie of data.rows){try{await session.defaultSession.cookies.set(cookie);result.cookies++;}catch{}}}
    } else {
      const bookmarkFile=path.join(profile.path,'Bookmarks'),historyFile=path.join(profile.path,'History'),webData=path.join(profile.path,'Web Data');
      if(fs.existsSync(bookmarkFile))result.bookmarks+=mergeBrowserBookmarks(parseChromiumBookmarks(fs.readFileSync(bookmarkFile,'utf8'),({chrome:'Google Chrome',edge:'Microsoft Edge',brave:'Brave'})[browser]));
      if(fs.existsSync(historyFile))result.history+=mergeImportedHistory(readChromiumHistory(historyFile));
      if(fs.existsSync(webData))result.autofill+=mergeImportedAutofill(readAutofillDatabase(webData));
      const networkCookies=path.join(profile.path,'Network','Cookies'),cookieFile=fs.existsSync(networkCookies)?networkCookies:path.join(profile.path,'Cookies');
      if(fs.existsSync(cookieFile)){const data=readProfileCookies(cookieFile);result.encryptedCookies+=data.encrypted;for(const cookie of data.rows){try{await session.defaultSession.cookies.set(cookie);result.cookies++;}catch{}}}
    }
    const engine=readImportedSearchEngine(profile,browser);if(engine&&!result.searchEngine)result.searchEngine=engine;
  }catch{result.skipped.push(profile.name);}}
  if(result.searchEngine&&!preferences.setupComplete){preferences.searchEngine=result.searchEngine;savePreferences();}else result.searchEngine=null;
  savePrivateBrowserData();savePreferences();saveBookmarks();
  return result;
}
function visibleTabIds() {
  if (split) return new Set(split.ids.filter(Boolean));
  return new Set(activeId ? [activeId] : []);
}

function serializableState() {
  const active = findTab(activeId);
  return {
    tabs: tabs.map(({ id, title, url, loading, hibernated, blockedCount, error, favicon }) => ({
      id, title, url, loading, hibernated, blockedCount, error, favicon
    })),
    activeId,
    bookmarks: bookmarks.map((bookmark) => ({ ...bookmark })),
    downloads: downloads.map(({ item, ...record }) => ({ ...record })),
    internalPage,
    split: split ? { mode: split.mode, ratio: split.ratio, ids: [...split.ids] } : null,
    preferences: { ...preferences, shortcuts: { ...preferences.shortcuts } },
    passwordVaultUnlocked: isPasswordVaultUnlocked(),
    passwordPasskeyEnrolled: Boolean(passwordPasskey),
    savedPasswordCount: savedPasswords.length,
    sitePermissions: sitePermissionList(),
    appVersion: app.getVersion(),
    tor: { available: Boolean(torResources), active: torStatus === 'connected', status: torStatus },
    active: active ? {
      url: active.url,
      title: active.title,
      loading: active.loading,
      blockedCount: active.blockedCount,
      error: active.error,
      favicon: active.favicon
    } : null
  };
}

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser:state', serializableState());
  }
}

function boundsForSlot(slot, count, ratio) {
  const gap = 1;
  if (count === 1) return { ...stageBounds };
  if (count === 2) {
    const leftWidth = Math.max(1, Math.floor((stageBounds.width - gap) * ratio));
    return slot === 0
      ? { x: stageBounds.x, y: stageBounds.y, width: leftWidth, height: stageBounds.height }
      : { x: stageBounds.x + leftWidth + gap, y: stageBounds.y, width: Math.max(1, stageBounds.width - leftWidth - gap), height: stageBounds.height };
  }
  const colWidth = Math.max(1, Math.floor((stageBounds.width - gap * 2) / 3));
  return {
    x: stageBounds.x + slot * (colWidth + gap),
    y: stageBounds.y,
    width: slot === 2 ? Math.max(1, stageBounds.width - 2 * (colWidth + gap) + gap) : colWidth,
    height: stageBounds.height
  };
}

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const visible = ['settings', 'onboarding'].includes(internalPage) || tabDragActive ? new Set() : visibleTabIds();
  for (const tab of tabs) {
    if (!tab.view || tab.view.webContents.isDestroyed()) continue;
    const slot = split ? split.ids.indexOf(tab.id) : (tab.id === activeId ? 0 : -1);
    if (!visible.has(tab.id) || slot < 0) {
      // Truly hide background tabs so Chromium throttles their timers and stops painting them.
      tab.view.setVisible(false);
      tab.view.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
      continue;
    }
    tab.view.setBounds(boundsForSlot(slot, split ? split.mode : 1, split?.ratio ?? 1));
    tab.view.setVisible(true);
  }
}

function publishState() {
  layoutViews();
  sendState();
}

async function discoverFavicon(tab) {
  const contents = tab.view?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const pageUrl = contents.getURL() || tab.url;
  try {
    const raw = await contents.executeJavaScript(`(() => {
      const icon = [...document.querySelectorAll('link[rel]')]
        .filter((item) => /(^|\s)icon(\s|$)/i.test(item.rel || ''))
        .map((item) => item.href).find(Boolean);
      return icon || new URL('/favicon.ico', location.href).href;
    })()`);
    const icon = safeFavicon(raw, pageUrl);
    if (icon && tab.view?.webContents === contents && (contents.getURL() || tab.url) === pageUrl && tab.favicon !== icon) {
      tab.favicon = icon;
      sendState();
    }
  } catch {}
}

function addWebContentsHandlers(tab) {
  const contents = tab.view.webContents;
  contents.on('before-input-event', handleBeforeInput);
  contents.on('found-in-page', (_event, result) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:find-result', { activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches });
  });
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.setWindowOpenHandler(({ url }) => {
    if (preferences.blockPopups) return { action: 'deny' };
    const safeUrl = normalizeUrl(url);
    if (safeUrl) createTab(safeUrl);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, targetUrl) => {
    const safeUrl = normalizeUrl(targetUrl);
    if (!safeUrl) {
      event.preventDefault();
      return;
    }
    if (safeUrl !== targetUrl) {
      event.preventDefault();
      contents.loadURL(safeUrl).catch(() => {});
    }
  });
  contents.on('will-redirect', (event, targetUrl) => {
    const safeUrl = normalizeUrl(targetUrl);
    if (!safeUrl) {
      event.preventDefault();
      return;
    }
    if (safeUrl !== targetUrl) {
      event.preventDefault();
      contents.loadURL(safeUrl).catch(() => {});
    }
  });
  contents.on('page-favicon-updated', (_event, favicons) => {
    const pageUrl = contents.getURL() || tab.url;
    const icon = (favicons || []).map((value) => safeFavicon(value, pageUrl)).find(Boolean) || null;
    if (icon && icon !== tab.favicon) {
      tab.favicon = icon;
      sendState();
    }
  });
  contents.on('did-start-loading', () => {
    tab.error = false;
    tab.favicon = null;
    tab.loading = true;
    publishState();
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    tab.error = true;
    tab.loading = false;
    tab.title = errorDescription || 'Could not load page';
    publishState();
  });
  contents.on('did-stop-loading', () => {
    tab.loading = false;
    tab.url = contents.getURL() || tab.url;
    tab.title = contents.getTitle() || tab.title;
    publishState();
    discoverFavicon(tab);
  });
  contents.on('did-navigate', (_event, url) => {
    tab.url = url;
    tab.title = contents.getTitle() || tab.title;
    recordBrowserHistory(url, tab.title);
    publishState();
    discoverFavicon(tab);
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = url;
    tab.title = contents.getTitle() || tab.title;
    recordBrowserHistory(url, tab.title);
    publishState();
  });
  contents.on('page-title-updated', (_event, title) => {
    tab.title = title || tab.url;
    sendState();
  });
  contents.on('render-process-gone', () => {
    tab.loading = false;
    tab.title = (tab.title || 'Page') + ' (crashed)';
    publishState();
  });
}

function newWebView() {
  const view = new WebContentsView({
    webPreferences: {
      session: session.defaultSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  view.webContents.setZoomFactor(preferences.pageZoom);
  return view;
}

function createTab(inputUrl = searchHomeUrl(), options = {}) {
  if (preferences.setupComplete) internalPage = null;
  const safeUrl = normalizeUrl(inputUrl);
  if (!safeUrl) throw new Error('Only web pages using HTTP or HTTPS can be opened.');
  const view = newWebView();
  const tab = {
    id: randomUUID(),
    title: 'New tab',
    url: safeUrl,
    view,
    loading: true,
    hibernated: false,
    blockedCount: 0,
    error: false,
    lastActive: Date.now()
  };
  tabs.push(tab);
  mainWindow.contentView.addChildView(view);
  addWebContentsHandlers(tab);
  if (options.activate !== false) {
    activeId = tab.id;
    if (split && !split.ids.includes(tab.id)) split = null;
  }
  layoutViews();
  view.webContents.loadURL(safeUrl).catch(() => {
    tab.loading = false;
    tab.title = 'Could not load page';
    publishState();
  });
  publishState();
  return tab;
}

function destroyTab(tab) {
  if (!tab) return;
  if (tab.view && !tab.view.webContents.isDestroyed()) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(tab.view);
    tab.view.webContents.destroy();
  }
}

function restoreTab(tab) {
  if (!tab?.hibernated || !mainWindow) return;
  tab.view = newWebView();
  tab.hibernated = false;
  tab.error = false;
  tab.loading = true;
  mainWindow.contentView.addChildView(tab.view);
  addWebContentsHandlers(tab);
  tab.view.webContents.loadURL(normalizeUrl(tab.url) || searchHomeUrl()).catch(() => {});
}

function activateTab(id) {
  if (!preferences.setupComplete) { internalPage = 'onboarding'; return; }
  internalPage = null;
  const tab = findTab(id);
  if (!tab) return;
  if (tab.hibernated) restoreTab(tab);
  activeId = tab.id;
  tab.lastActive = Date.now();
  if (split && !split.ids.includes(tab.id)) split = null;
  publishState();
}

const recentlyClosedUrls = [];
function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  try {
    const closedUrl = tab.view?.webContents?.getURL() || tab.url;
    if (/^https?:/i.test(closedUrl)) { recentlyClosedUrls.push(closedUrl); if (recentlyClosedUrls.length > 25) recentlyClosedUrls.shift(); }
  } catch {}
  destroyTab(tab);
  if (split) {
    split.ids = split.ids.filter((tabId) => tabId !== id);
    if (split.ids.length < split.mode) split = null;
  }
  if (activeId === id) {
    const next = tabs[Math.max(0, index - 1)] || tabs[0];
    activeId = next?.id ?? null;
  }
  if (!tabs.length) createTab(searchHomeUrl());
  else publishState();
}

function isFunctionKey(key) { return /^F([1-9]|1[0-2])$/.test(key); }
// One spelling per shortcut, so "Ctrl+=", "Ctrl+Shift+Plus" and numpad "+" all mean zoom in.
function canonicalShortcut(value) {
  const parts = String(value || '').split('+');
  let key = parts.pop();
  if (key === '' && parts[parts.length - 1] === '') { parts.pop(); key = 'Plus'; }
  if (key === '=' || key === '+' || key === 'Add') key = 'Plus';
  if (key === 'Subtract' || key === '_') key = '-';
  if (key === 'Esc') key = 'Escape';
  const modifiers = ['Ctrl', 'Meta', 'Alt', 'Shift'].filter((name) => parts.includes(name) && !(name === 'Shift' && (key === 'Plus' || key === '-')));
  if (key.length === 1) key = key.toUpperCase();
  return modifiers.concat(key).join('+');
}
function shortcutFromInput(input) {
  if (!input || !input.key || ['Control', 'Shift', 'Alt', 'Meta'].includes(input.key)) return null;
  const modifiers = [];
  if (input.control) modifiers.push('Ctrl');
  if (input.meta) modifiers.push('Meta');
  if (input.alt) modifiers.push('Alt');
  if (input.shift) modifiers.push('Shift');
  if (!modifiers.length && !isFunctionKey(input.key) && input.key !== 'Escape') return null;
  const key = input.key === '+' ? 'Plus' : (input.key === ' ' ? 'Space' : input.key);
  return canonicalShortcut(modifiers.concat(key).join('+'));
}

function applySplit(mode, ratio = 0.5, draggedTabId = null) {
  if (!preferences.setupComplete) { internalPage = 'onboarding'; publishState(); return; }
  internalPage = null;
  tabDragActive = false;
  if (mode === 0) {
    split = null;
    publishState();
    return;
  }
  if (![2, 3].includes(mode)) return;
  if (mode === 2 && draggedTabId) {
    const draggedTab = findTab(draggedTabId);
    let firstTab = findTab(activeId);
    if (!draggedTab) return;
    if (!firstTab || firstTab.id === draggedTab.id) firstTab = tabs.find((tab) => tab.id !== draggedTab.id);
    if (!firstTab) {
      firstTab = createTab(searchHomeUrl(), { activate: false });
    }
    split = { mode: 2, ratio: Number(ratio) === 0.6 ? 0.6 : 0.5, ids: [firstTab.id, draggedTab.id] };
    activeId = firstTab.id;
    for (const id of split.ids) {
      const tab = findTab(id);
      if (tab) tab.lastActive = Date.now();
    }
    publishState();
    return;
  }
  while (tabs.length < mode) createTab(searchHomeUrl(), { activate: false });
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));
  const ordered = [...tabs.slice(activeIndex), ...tabs.slice(0, activeIndex)];
  split = {
    mode,
    ratio: mode === 2 && Number(ratio) === 0.6 ? 0.6 : (mode === 2 ? 0.5 : 1 / 3),
    ids: ordered.slice(0, mode).map((tab) => tab.id)
  };
  activeId = split.ids[0];
  for (const id of split.ids) {
    const tab = findTab(id);
    if (tab) tab.lastActive = Date.now();
  }
  publishState();
}

function executeShortcut(action) {
  const tab = findTab(activeId);
  if (action === 'newTab') createTab(searchHomeUrl());
  else if (action === 'focusAddress' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
    mainWindow.webContents.send('browser:command', 'focus-address');
  } else if (action === 'closeTab' && tab) closeTab(tab.id);
  else if (action === 'reload' && tab?.view) tab.view.webContents.reload();
  else if (action === 'back' && !preferences.setupComplete) return;
  else if (action === 'back' && internalPage) { internalPage = null; publishState(); }
  else if (action === 'back' && tab?.view && tab.view.webContents.canGoBack()) tab.view.webContents.goBack();
  else if (action === 'forward' && tab?.view && tab.view.webContents.canGoForward()) tab.view.webContents.goForward();
  else if (action === 'glance' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
    mainWindow.webContents.send('browser:command', 'glance');
  }
  else if (action === 'split') applySplit(2, 0.5);
  else if (action === 'settings' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
    mainWindow.webContents.send('browser:command', 'settings');
  }
  else if (action === 'devtools') toggleDeveloperTools();
  else if (action === 'find' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
    mainWindow.webContents.send('browser:command', 'find-page');
  }
  else if (action === 'zoomIn' && tab?.view) tab.view.webContents.setZoomFactor(Math.min(2, Math.round((tab.view.webContents.getZoomFactor() + 0.1) * 100) / 100));
  else if (action === 'zoomOut' && tab?.view) tab.view.webContents.setZoomFactor(Math.max(0.5, Math.round((tab.view.webContents.getZoomFactor() - 0.1) * 100) / 100));
  else if (action === 'zoomReset' && tab?.view) tab.view.webContents.setZoomFactor(1);
  else if (action === 'nextTab' || action === 'previousTab') {
    if (tabs.length < 2) return;
    const index = Math.max(0, tabs.findIndex((item) => item.id === activeId));
    const next = tabs[(index + (action === 'nextTab' ? 1 : tabs.length - 1)) % tabs.length];
    activateTab(next.id);
  }
  else if (action === 'reopenTab') { const url = recentlyClosedUrls.pop(); if (url) createTab(url); }
  else if (action === 'fullscreen' && mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  else if (action === 'hardReload' && tab?.view) tab.view.webContents.reloadIgnoringCache();
  else if (action === 'home' && tab?.view) { tab.url = searchHomeUrl(); tab.view.webContents.loadURL(tab.url).catch(() => {}); }
  else if (action === 'stop') {
    if (mainWindow?.isFullScreen()) mainWindow.setFullScreen(false);
    else if (tab?.view && tab.view.webContents.isLoading()) tab.view.webContents.stop();
    else return false;
  }
  else if (/^tab[1-9]$/.test(action) && tabs.length) {
    const number = Number(action.slice(3));
    activateTab((number === 9 ? tabs[tabs.length - 1] : tabs[number - 1])?.id ?? activeId);
  }
  return true;
}

function toggleDeveloperTools() {
  const contents = findTab(activeId)?.view?.webContents;
  if (!contents || contents.isDestroyed()) return false;
  if (contents.isDevToolsOpened()) contents.closeDevTools();
  else contents.openDevTools({ mode: 'detach' });
  return true;
}

function handleBeforeInput(event, input, fromShell = false) {
  if (input.type !== 'keyDown') return;
  // Recording a new shortcut in Settings pauses shortcuts only for the settings page, so it can never get stuck for webpages.
  if (shortcutCapture && fromShell) return;
  const shortcut = shortcutFromInput(input);
  if (!shortcut) return;
  let action = Object.keys(DEFAULT_SHORTCUTS).find((key) => canonicalShortcut(preferences.shortcuts[key]) === shortcut)
    || BUILTIN_SHORTCUTS[shortcut]
    || (/^Ctrl\+[1-9]$/.test(shortcut) ? 'tab' + shortcut.slice(-1) : null);
  if (!action) return;
  if (input.isAutoRepeat && !['zoomIn', 'zoomOut', 'nextTab', 'previousTab'].includes(action)) { event.preventDefault(); return; }
  if (action === 'stop' && fromShell) return;
  if (executeShortcut(action) !== false) event.preventDefault();
}
function platformTorKey() {
  const platform = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
  const arch = process.arch === 'x64' ? 'x86_64' : (process.arch === 'arm64' ? 'aarch64' : process.arch);
  return platform + '-' + arch;
}

function findTorFile(root, name) {
  if (!root || !fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    }
  }
  return null;
}

function locateTorResources() {
  const binaryName = process.platform === 'win32' ? 'tor.exe' : 'tor';
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'tor') : null,
    path.resolve(__dirname, '..', 'vendor', 'tor', platformTorKey())
  ].filter(Boolean);
  for (const root of roots) {
    const binary = findTorFile(root, binaryName);
    const geoip = findTorFile(root, 'geoip');
    const geoip6 = findTorFile(root, 'geoip6');
    if (binary && geoip && geoip6) return { binary, geoip, geoip6, cwd: path.dirname(binary) };
  }
  return null;
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForTorBootstrap(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Tor bootstrap timed out.')), 120000);
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-12000);
      if (output.includes('Bootstrapped 100%')) finish();
    };
    const onExit = (code) => finish(new Error('Tor exited before connecting (code ' + code + ').'));
    const onError = (error) => finish(error);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    }
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function startTor() {
  if (!torResources) {
    torStatus = 'unavailable';
    sendState();
    return false;
  }
  torStatus = 'starting';
  sendState();
  try {
    torPort = await reserveLocalPort();
    const dataDirectory = path.join(app.getPath('userData'), 'tor-state');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const args = [
      '--SocksPort', '127.0.0.1:' + torPort,
      '--DataDirectory', dataDirectory,
      '--GeoIPFile', torResources.geoip,
      '--GeoIPv6File', torResources.geoip6,
      '--ClientOnly', '1',
      '--AvoidDiskWrites', '1',
      '--Log', 'notice stdout'
    ];
    const child = spawn(torResources.binary, args, {
      cwd: torResources.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    torProcess = child;
    child.once('exit', () => {
      if (torProcess !== child) return;
      torProcess = null;
      torPort = null;
      torStatus = 'error';
      session.defaultSession.setProxy({ mode: 'direct' })
        .then(() => session.defaultSession.closeAllConnections())
        .finally(sendState)
        .catch(() => sendState());
    });
    await waitForTorBootstrap(child);
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:' + torPort,
      proxyBypassRules: ''
    });
    await session.defaultSession.closeAllConnections();
    torStatus = 'connected';
    sendState();
    return true;
  } catch {
    const child = torProcess;
    torProcess = null;
    torPort = null;
    if (child && !child.killed) child.kill();
    await session.defaultSession.setProxy({ mode: 'direct' }).catch(() => {});
    await session.defaultSession.closeAllConnections().catch(() => {});
    torStatus = 'error';
    sendState();
    return false;
  }
}

async function stopTor() {
  const child = torProcess;
  torProcess = null;
  torPort = null;
  await session.defaultSession.setProxy({ mode: 'direct' }).catch(() => {});
  await session.defaultSession.closeAllConnections().catch(() => {});
  if (child && !child.killed) child.kill();
  torStatus = 'off';
  sendState();
}
function registerDownload(item, savePath, notice = '') {
  const record = {
    id: randomUUID(),
    filename: String(item.getFilename() || 'download').slice(0, 260),
    url: String(item.getURL() || '').slice(0, 4096),
    savePath,
    receivedBytes: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes(),
    state: 'progressing',
    paused: item.isPaused(),
    startedAt: Date.now(),
    item
  };
  downloads.unshift(record);
  downloads = downloads.slice(0, 100);
  const update = (_event, state) => {
    record.receivedBytes = item.getReceivedBytes();
    record.totalBytes = item.getTotalBytes();
    record.paused = item.isPaused();
    if (state) record.state = state;
    record.savePath = item.getSavePath() || savePath;
    sendState();
  };
  item.on('updated', update);
  item.once('done', (_event, state) => {
    record.state = state;
    record.receivedBytes = item.getReceivedBytes();
    record.totalBytes = item.getTotalBytes();
    record.paused = false;
    record.item = null;
    record.finishedAt = Date.now();
    sendState();
    const message = state === 'completed'
      ? 'Saved ' + path.basename(record.savePath) + (notice ? '. ' + notice : '.')
      : 'Download ' + state + '.';
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:toast', message);
  });
  sendState();
  return record;
}

function uniqueDownloadPath(directory, rawFilename) {
  const filename = path.basename(String(rawFilename || 'download'));
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = path.join(directory, filename);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, stem + ' (' + suffix++ + ')' + extension);
  }
  return candidate;
}

// Site permissions: ask the user, remember per site, deny everything we don't recognise.
const PROMPTED_PERMISSIONS = { camera: 'use your camera', microphone: 'use your microphone', geolocation: 'know your location', notifications: 'show notifications', 'clipboard-read': 'read your clipboard' };
const AUTO_ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);
let sitePermissions = {};
const pendingPermissionPrompts = new Map();
function sitePermissionsPath() { return path.join(app.getPath('userData'), 'aura-site-permissions.json'); }
function loadSitePermissions() {
  try {
    const stored = JSON.parse(fs.readFileSync(sitePermissionsPath(), 'utf8'));
    sitePermissions = {};
    for (const [origin, rules] of Object.entries(stored || {})) {
      if (!/^https?:\/\/[^/]+$/.test(origin) || !rules || typeof rules !== 'object') continue;
      for (const [name, value] of Object.entries(rules)) {
        if (Object.hasOwn(PROMPTED_PERMISSIONS, name) && ['allow', 'block'].includes(value)) (sitePermissions[origin] ||= {})[name] = value;
      }
    }
  } catch { sitePermissions = {}; }
}
function saveSitePermissions() {
  fs.mkdirSync(path.dirname(sitePermissionsPath()), { recursive: true });
  fs.writeFileSync(sitePermissionsPath(), JSON.stringify(sitePermissions, null, 2), 'utf8');
}
function permissionOrigin(url) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null; } catch { return null; }
}
function requestedPermissionNames(permission, details) {
  if (permission === 'media') {
    const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const names = [];
    if (types.includes('video')) names.push('camera');
    if (types.includes('audio')) names.push('microphone');
    return names.length ? names : null;
  }
  return Object.hasOwn(PROMPTED_PERMISSIONS, permission) ? [permission] : null;
}
async function askSitePermission(origin, names) {
  const key = origin + '|' + names.join(',');
  if (pendingPermissionPrompts.has(key)) return pendingPermissionPrompts.get(key);
  const prompt = (async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const what = names.map((name) => PROMPTED_PERMISSIONS[name]).join(' and ');
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Site permission',
      message: new URL(origin).host + ' wants to ' + what + '.',
      detail: torProcess && names.includes('geolocation') ? 'Tor mode is on. Sharing your location can identify you.' : 'You can change this later in Settings → Privacy and security.',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: 'Remember my choice for this site',
      checkboxChecked: true,
      noLink: true
    });
    const allowed = response === 0;
    if (checkboxChecked) {
      for (const name of names) (sitePermissions[origin] ||= {})[name] = allowed ? 'allow' : 'block';
      saveSitePermissions();
      sendState();
    }
    return allowed;
  })().finally(() => pendingPermissionPrompts.delete(key));
  pendingPermissionPrompts.set(key, prompt);
  return prompt;
}
function sitePermissionList() {
  return Object.entries(sitePermissions).flatMap(([origin, rules]) => Object.entries(rules).map(([name, value]) => ({ origin, name, value })));
}

function setupSession() {
  const ses = session.defaultSession;
  loadSitePermissions();
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (AUTO_ALLOWED_PERMISSIONS.has(permission)) return callback(true);
    const origin = permissionOrigin(details?.requestingUrl || contents?.getURL());
    const names = requestedPermissionNames(permission, details);
    if (!origin || !names) return callback(false);
    const stored = names.map((name) => sitePermissions[origin]?.[name]);
    if (stored.every((value) => value === 'allow')) return callback(true);
    if (stored.some((value) => value === 'block')) return callback(false);
    askSitePermission(origin, names).then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (AUTO_ALLOWED_PERMISSIONS.has(permission)) return true;
    const origin = permissionOrigin(requestingOrigin);
    if (!origin) return false;
    const names = permission === 'media' ? (details?.mediaType === 'video' ? ['camera'] : details?.mediaType === 'audio' ? ['microphone'] : ['camera', 'microphone']) : [permission];
    return names.some((name) => sitePermissions[origin]?.[name] === 'allow');
  });
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const blocked = preferences.blockTrackers && isTrackerUrl(details.url);
    if (blocked) {
      const tab = tabs.find((candidate) => candidate.view?.webContents.id === details.webContentsId);
      if (tab) {
        tab.blockedCount += 1;
        if (tab.id === activeId) sendState();
      }
    }
    callback({ cancel: blocked });
  });
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const locale = preferences.language + '-' + preferences.country;
    const headers = { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1', 'Accept-Language': locale + ',' + preferences.language + ';q=0.9,en;q=0.8' };
    callback({ requestHeaders: headers });
  });
  ses.on('will-download', async (event, item) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      event.preventDefault();
      return;
    }
    if (preferences.downloadDirectory && fs.existsSync(preferences.downloadDirectory)) {
      const targetPath = uniqueDownloadPath(preferences.downloadDirectory, item.getFilename());
      item.setSavePath(targetPath);
      registerDownload(item, targetPath);
      return;
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save download',
      defaultPath: item.getFilename(),
      buttonLabel: 'Save (not scanned)'
    });
    if (result.canceled || !result.filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(result.filePath);
    registerDownload(item, result.filePath, 'This prototype did not scan it.');
  });
}

function sessionStatePath() {
  return path.join(app.getPath('userData'), 'aura-session.json');
}

function saveSessionState() {
  try {
    const state = {
      tabs: tabs.map((tab) => ({ url: normalizeUrl(tab.view?.webContents?.getURL() || tab.url, { httpsOnly: false }) || searchHomeUrl(), title: String(tab.view?.webContents?.getTitle() || tab.title || '').slice(0, 300) })),
      activeIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeId)),
      split: split ? { mode: split.mode, ratio: split.ratio, indices: split.ids.map((id) => tabs.findIndex((tab) => tab.id === id)).filter((index) => index >= 0) } : null
    };
    if (!state.tabs.length) return;
    const file = sessionStatePath();
    const temp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
    fs.renameSync(temp, file);
  } catch {}
}

function restoreSessionState() {
  if (!preferences.setupComplete) return false;
  try {
    const stored = JSON.parse(fs.readFileSync(sessionStatePath(), 'utf8'));
    if (!Array.isArray(stored.tabs)) return false;
    const records = stored.tabs.slice(0, 30);
    // Restored tabs start asleep and only load when opened, which keeps startup fast and light.
    for (const record of records) {
      const url = normalizeUrl(record.url, { httpsOnly: false });
      if (!url) continue;
      tabs.push({ id: randomUUID(), title: String(record.title || url).slice(0, 300), url, view: null, loading: false, hibernated: true, blockedCount: 0, error: false, lastActive: Date.now() });
    }
    if (!tabs.length) return false;
    activeId = tabs[Math.max(0, Math.min(tabs.length - 1, Number(stored.activeIndex) || 0))].id;
    if ([2, 3].includes(stored.split?.mode) && Array.isArray(stored.split.indices)) {
      const ids = stored.split.indices.map((index) => tabs[index]?.id).filter(Boolean).slice(0, stored.split.mode);
      if (ids.length === stored.split.mode) split = { mode: stored.split.mode, ratio: stored.split.ratio === 0.6 ? 0.6 : (stored.split.mode === 3 ? 1 / 3 : 0.5), ids };
    }
    for (const id of split ? split.ids : [activeId]) restoreTab(findTab(id));
    layoutViews();
    publishState();
    return true;
  } catch { return false; }
}

function createShell() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#0c1112',
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.webContents.on('before-input-event', (event, input) => handleBeforeInput(event, input, true));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== SHELL_URL) event.preventDefault();
  });
  mainWindow.on('resize', layoutViews);
  mainWindow.on('closed', () => {
    for (const tab of tabs) destroyTab(tab);
    tabs = [];
    activeId = null;
    split = null;
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html')).then(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    if (!tabs.length && !restoreSessionState()) createTab(searchHomeUrl());
  });
}

function aliasCredentialPath() {
  return path.join(app.getPath('userData'), 'simplelogin-api-key.bin');
}

function readAliasApiKey() {
  const file = aliasCredentialPath();
  if (!fs.existsSync(file)) throw new Error('Connect your SimpleLogin account first.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable on this device.');
  return safeStorage.decryptString(fs.readFileSync(file));
}

async function simpleLoginRequest(apiPath, options = {}, apiKey = null) {
  const key = apiKey || readAliasApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await electronNet.fetch('https://app.simplelogin.io/api' + apiPath, {
      ...options,
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}), Authentication: key }
    });
    const bodyText = await response.text();
    let data = {};
    try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { data = { error: bodyText }; }
    if (!response.ok) {
      let message = String(data.error || data.message || 'SimpleLogin request failed (' + response.status + ').');
      if (key) message = message.split(key).join('[hidden]');
      throw new Error(message.slice(0, 280));
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('SimpleLogin did not respond in time.');
    if (error instanceof TypeError) throw new Error('Could not reach SimpleLogin. Check your internet connection.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function aliasApiPath(id) {
  const value = String(id ?? '');
  if (!/^\d{1,16}$/.test(value)) throw new Error('Invalid alias id.');
  return '/aliases/' + encodeURIComponent(value);
}

function registerIpc() {
  ipcMain.handle('browser:get-imported-data', (event) => {
    requireTrustedShell(event);
    return { history: importedBrowserData.history, autofill: importedBrowserData.autofill };
  });
  ipcMain.handle('browser:password-vault-status', (event) => {
    requireTrustedShell(event);
    return passwordVaultStatus();
  });
  ipcMain.handle('browser:unlock-password-vault', (event) => {
    requireTrustedShell(event);
    return openPasswordPasskeyFlow();
  });
  ipcMain.handle('browser:lock-password-vault', (event) => {
    requireTrustedShell(event);
    lockPasswordVault();
    return true;
  });
  ipcMain.handle('browser:remove-site-permission', (event, origin, name) => {
    requireTrustedShell(event);
    if (typeof origin !== 'string' || !sitePermissions[origin]) return false;
    if (name === '*') delete sitePermissions[origin];
    else { delete sitePermissions[origin][name]; if (!Object.keys(sitePermissions[origin]).length) delete sitePermissions[origin]; }
    saveSitePermissions(); sendState(); return true;
  });
  ipcMain.handle('browser:reset-site-permissions', (event) => {
    requireTrustedShell(event);
    sitePermissions = {}; saveSitePermissions(); sendState(); return true;
  });
  ipcMain.handle('vault:passkey-info', (event) => getPasskeyInfo(event));
  ipcMain.handle('vault:pin-setup', (event, pin) => setupVaultPin(event, pin));
  ipcMain.handle('vault:pin-verify', (event, pin) => verifyVaultPin(event, pin));
  ipcMain.handle('vault:passkey-options', (event, mode) => getPasskeyOptions(event, mode));
  ipcMain.handle('vault:passkey-complete', (event, mode, response) => completePasskeyOperation(event, mode, response));
  ipcMain.handle('vault:passkey-cancel', (event) => {
    requireTrustedPasskeyWindow(event);
    finishPasskeyFlow({ ok: false, cancelled: true });
    return true;
  });
  ipcMain.handle('browser:get-passwords', (event) => {
    requireTrustedShell(event);
    if (!isPasswordVaultUnlocked()) throw new Error('Verify your passkey to open saved passwords.');
    return savedPasswords.map(({ id, url, username, password }) => ({ id, url, username, password }));
  });
  ipcMain.handle('browser:import-profile', async (event, browser) => {
    requireTrustedShell(event);
    if (!['chrome', 'edge', 'brave', 'firefox'].includes(browser)) throw new Error('Unsupported browser source.');
    const result = await importBrowserProfile(browser);
    sendState();
    return result;
  });
  ipcMain.handle('browser:import-password-csv', async (event) => {
    requireTrustedShell(event);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Import saved passwords', properties: ['openFile'], filters: [{ name: 'CSV password export', extensions: ['csv'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, added: 0 };
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 100 * 1024 * 1024) throw new Error('Password export is larger than 100 MB.');
    const records = parsePasswordCsv(fs.readFileSync(file, 'utf8'));
    const added = importPasswordRows(records);
    publishState();
    return { canceled: false, added, ignored: Math.max(0, records.length - added) };
  });
  ipcMain.handle('browser:remove-imported-item', (event, collection, id) => {
    requireTrustedShell(event);
    if (collection === 'passwords') {
      if (!isPasswordVaultUnlocked()) throw new Error('Verify your passkey to change saved passwords.');
      savedPasswords = savedPasswords.filter((item) => item.id !== id); savePasswordVault(); publishState(); return true;
    }
    if (!['history', 'autofill'].includes(collection)) return false;
    importedBrowserData[collection] = importedBrowserData[collection].filter((item) => item.id !== id);
    savePrivateBrowserData();
    return true;
  });
  ipcMain.handle('browser:clear-history', (event) => {
    requireTrustedShell(event);
    importedBrowserData.history = [];
    savePrivateBrowserData();
    return true;
  });  ipcMain.handle('browser:complete-setup', (event, update) => {
    requireTrustedShell(event);
    if (preferences.setupComplete) return false;
    mergePreferences(update || {});
    preferences.setupComplete = true;
    savePreferences();
    internalPage = null;
    publishState();
    return true;
  });
  ipcMain.handle('browser:download-action', async (event, id, action) => {
    requireTrustedShell(event);
    const record = downloads.find((item) => item.id === id);
    if (!record || !['pause', 'resume', 'cancel', 'open', 'show'].includes(action)) return false;
    if (action === 'pause' && record.item && !record.item.isPaused()) record.item.pause();
    else if (action === 'resume' && record.item && record.item.isPaused()) record.item.resume();
    else if (action === 'cancel' && record.item) record.item.cancel();
    else if (action === 'open' && record.state === 'completed' && fs.existsSync(record.savePath)) {
      const error = await shell.openPath(record.savePath);
      if (error) throw new Error(error);
    }
    else if (action === 'show' && record.state === 'completed' && fs.existsSync(record.savePath)) shell.showItemInFolder(record.savePath);
    sendState();
    return true;
  });
  ipcMain.handle('browser:choose-download-directory', async (event) => {
    requireTrustedShell(event);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose download folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    mergePreferences({ downloadDirectory: result.filePaths[0] });
    publishState();
    return preferences.downloadDirectory;
  });
  ipcMain.handle('browser:clear-site-data', async (event) => {
    requireTrustedShell(event);
    await session.defaultSession.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'] });
    await session.defaultSession.clearCache();
    return true;
  });
  ipcMain.handle('browser:open-devtools', (event) => {
    requireTrustedShell(event);
    return toggleDeveloperTools();
  });
  ipcMain.handle('browser:find-text', (event, text, direction = 'forward', newSearch = false) => {
    requireTrustedShell(event);
    const contents = findTab(activeId)?.view?.webContents;
    const query = String(text || '').slice(0, 500);
    if (!contents || contents.isDestroyed()) return false;
    if (!query) { contents.stopFindInPage('clearSelection'); return true; }
    contents.findInPage(query, { forward: direction !== 'backward', findNext: Boolean(newSearch) });
    return true;
  });
  ipcMain.handle('browser:stop-find', (event) => {
    requireTrustedShell(event);
    const contents = findTab(activeId)?.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.stopFindInPage('clearSelection');
    return true;
  });
  ipcMain.handle('browser:get-state', (event) => {
    requireTrustedShell(event);
    return serializableState();
  });
  ipcMain.handle('browser:create-tab', (event, url) => {
    requireTrustedShell(event);
    return createTab(url || searchHomeUrl()).id;
  });
  ipcMain.handle('browser:select-tab', (event, id) => {
    requireTrustedShell(event);
    activateTab(id);
  });
  ipcMain.handle('browser:close-tab', (event, id) => {
    requireTrustedShell(event);
    closeTab(id);
  });
  ipcMain.handle('browser:reorder-tabs', (event, fromId, toId) => {
    requireTrustedShell(event);
    const from = tabs.findIndex((tab) => tab.id === fromId);
    const to = tabs.findIndex((tab) => tab.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const moved = tabs.splice(from, 1)[0];
    tabs.splice(to, 0, moved);
    publishState();
  });
  ipcMain.handle('browser:navigate', (event, input) => {
    requireTrustedShell(event);
    if (String(input || '').trim().toLowerCase() === 'aurabrowser://settings') { if (!preferences.setupComplete) { internalPage = 'onboarding'; publishState(); return true; } internalPage = 'settings'; publishState(); return true; }
    if (!preferences.setupComplete) { internalPage = 'onboarding'; publishState(); return false; }
    internalPage = null;
    const tab = findTab(activeId);
    const url = normalizeUrl(input);
    if (!tab || !url) return false;
    if (tab.hibernated) restoreTab(tab);
    tab.url = url;
    tab.title = 'Loading…';
    tab.error = false;
    tab.loading = true;
    tab.lastActive = Date.now();
    tab.view.webContents.loadURL(url).catch(() => {});
    publishState();
    return true;
  });
  ipcMain.handle('browser:back', (event) => {
    requireTrustedShell(event);
    if (!preferences.setupComplete) { internalPage = 'onboarding'; publishState(); return; }
    if (internalPage) { internalPage = null; publishState(); return; }
    const tab = findTab(activeId);
    if (tab?.view && tab.view.webContents.canGoBack()) tab.view.webContents.goBack();
  });
  ipcMain.handle('browser:forward', (event) => {
    requireTrustedShell(event);
    const tab = findTab(activeId);
    if (tab?.view && tab.view.webContents.canGoForward()) tab.view.webContents.goForward();
  });
  ipcMain.handle('browser:reload', (event) => {
    requireTrustedShell(event);
    const tab = findTab(activeId);
    if (tab?.view) tab.view.webContents.reload();
  });
  ipcMain.handle('browser:set-split', (event, mode, ratio, draggedTabId) => {
    requireTrustedShell(event);
    if (!preferences.setupComplete) { internalPage = 'onboarding'; publishState(); return; }
    applySplit(mode, ratio, draggedTabId);
  });
  ipcMain.handle('browser:toggle-settings', (event) => {
    requireTrustedShell(event);
    if (!preferences.setupComplete) { internalPage = 'onboarding'; publishState(); return internalPage; }
    internalPage = internalPage === 'settings' ? null : 'settings';
    tabDragActive = false;
    publishState();
    return internalPage;
  });
  ipcMain.handle('browser:close-settings', (event) => {
    requireTrustedShell(event);
    if (!preferences.setupComplete) { internalPage = 'onboarding'; publishState(); return; }
    internalPage = null;
    publishState();
  });
  ipcMain.on('browser:begin-tab-drag', (event, id) => {
    if (!isTrustedShell(event.sender, event.senderFrame) || !findTab(id)) return;
    tabDragActive = true;
    layoutViews();
  });
  ipcMain.on('browser:end-tab-drag', (event) => {
    if (!isTrustedShell(event.sender, event.senderFrame)) return;
    tabDragActive = false;
    layoutViews();
  });
  ipcMain.handle('browser:open-glance', (event, input) => {
    requireTrustedShell(event);
    const url = normalizeUrl(input || findTab(activeId)?.url);
    if (!url) return false;
    const glanceSession = session.fromPartition('aura-glance-' + randomUUID(), { cache: false });
    glanceSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    glanceSession.setPermissionCheckHandler(() => false);
    glanceSession.on('will-download', (_event, item) => item.cancel());
    glanceSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      callback({ cancel: preferences.blockTrackers && isTrackerUrl(details.url) });
    });
    glanceSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } });
    });
    const glance = new BrowserWindow({
      width: 720,
      height: 520,
      parent: mainWindow,
      modal: false,
      frame: true,
      alwaysOnTop: true,
      backgroundColor: '#101718',
      title: 'Aura Glance',
      webPreferences: {
        session: glanceSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });
    glance.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    glance.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    glance.webContents.on('will-navigate', (navigationEvent, targetUrl) => {
      const safeUrl = normalizeUrl(targetUrl);
      if (!safeUrl) {
        navigationEvent.preventDefault();
        return;
      }
      if (safeUrl !== targetUrl) {
        navigationEvent.preventDefault();
        glance.loadURL(safeUrl).catch(() => {});
      }
    });
    glance.webContents.on('will-redirect', (navigationEvent, targetUrl) => {
      const safeUrl = normalizeUrl(targetUrl);
      if (!safeUrl) {
        navigationEvent.preventDefault();
        return;
      }
      if (safeUrl !== targetUrl) {
        navigationEvent.preventDefault();
        glance.loadURL(safeUrl).catch(() => {});
      }
    });
    glance.loadURL(url);
    glance.on('closed', () => Promise.all([glanceSession.clearStorageData(), glanceSession.clearCache()]).catch(() => {}));
    return true;
  });
  ipcMain.handle('browser:update-preferences', (event, update) => {
    requireTrustedShell(event);
    const previousSearchEngine = preferences.searchEngine;
    const previousSearchHome = searchHomeUrl();
    mergePreferences(update);
    if (preferences.searchEngine !== previousSearchEngine) {
      for (const tab of tabs) {
        let currentUrl = tab.url;
        try { currentUrl = tab.view?.webContents?.getURL() || currentUrl; } catch {}
        if (currentUrl === previousSearchHome && tab.view && !tab.view.webContents.isDestroyed()) {
          tab.url = searchHomeUrl(); tab.loading = true; tab.view.webContents.loadURL(tab.url).catch(() => {});
        }
      }
    }
    publishState();
    return { ...preferences, shortcuts: { ...preferences.shortcuts } };
  });
  ipcMain.on('browser:set-shortcut-capture', (event, enabled) => {
    if (isTrustedShell(event.sender, event.senderFrame)) shortcutCapture = Boolean(enabled);
  });
  ipcMain.handle('browser:toggle-tor', async (event) => {
    requireTrustedShell(event);
    if (torProcess) await stopTor();
    else await startTor();
    return serializableState().tor;
  });
  ipcMain.handle('browser:toggle-bookmark', (event) => {
    requireTrustedShell(event);
    return toggleActiveBookmark();
  });
  ipcMain.handle('browser:remove-bookmark', (event, id) => {
    requireTrustedShell(event);
    const before = bookmarks.length;
    bookmarks = bookmarks.filter((bookmark) => bookmark.id !== String(id));
    if (bookmarks.length !== before) saveBookmarks();
    sendState();
    return bookmarks.length !== before;
  });
  ipcMain.handle('browser:import-bookmarks', async (event, requestedSource = 'file') => {
    requireTrustedShell(event);
    const source = ['chrome', 'edge', 'brave'].includes(requestedSource) ? requestedSource : 'file';
    let filePaths = source === 'file' ? [] : findChromiumBookmarksFiles(source);
    let resolvedSource = source;
    if (!filePaths.length) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: source === 'file' ? 'Import browser bookmarks' : 'Choose a bookmarks export',
        properties: ['openFile'],
        filters: [{ name: 'Bookmark files', extensions: ['html', 'htm', 'json'] }, { name: 'All files', extensions: ['*'] }]
      });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      filePaths = [result.filePaths[0]];
      resolvedSource = 'file';
    }
    const sourceName = resolvedSource === 'file' ? path.basename(filePaths[0]) : ({ chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave' }[resolvedSource]);
    let importedCount = 0;
    let total = bookmarks.length;
    for (const filePath of filePaths) {
      const imported = importBookmarkFile(filePath, sourceName);
      importedCount += imported.imported;
      total = imported.total;
    }
    sendState();
    return { imported: importedCount, total, source: sourceName };
  });
  ipcMain.handle('aliases:copy', (event, value) => {
    requireTrustedShell(event);
    const text = String(value || '');
    if (text.length > 320) throw new Error('Text is too long to copy.');
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('aliases:status', (event) => {
    requireTrustedShell(event);
    return { connected: fs.existsSync(aliasCredentialPath()), encryptionAvailable: safeStorage.isEncryptionAvailable() };
  });
  ipcMain.handle('aliases:connect', async (event, suppliedKey) => {
    requireTrustedShell(event);
    const key = String(suppliedKey || '').trim();
    if (!key || key.length > 2048 || /[\r\n]/.test(key)) throw new Error('Enter a valid SimpleLogin API key.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable on this device.');
    const user = await simpleLoginRequest('/user_info', {}, key);
    const encrypted = safeStorage.encryptString(key);
    fs.mkdirSync(path.dirname(aliasCredentialPath()), { recursive: true });
    fs.writeFileSync(aliasCredentialPath(), encrypted);
    return { connected: true, email: String(user.email || user.name || 'Account connected').slice(0, 160) };
  });
  ipcMain.handle('aliases:list', async (event, requestedPage = 0) => {
    requireTrustedShell(event);
    const page = Math.max(0, Math.min(10000, Math.floor(Number(requestedPage) || 0)));
    const data = await simpleLoginRequest('/v2/aliases?page_id=' + page);
    const aliases = Array.isArray(data) ? data : (Array.isArray(data.aliases) ? data.aliases : []);
    return { aliases: aliases.map(({ id, email, enabled, note, name }) => ({ id, email, enabled: Boolean(enabled), note: String(note || name || '').slice(0, 200) })), page, hasMore: aliases.length >= 20 };
  });
  ipcMain.handle('aliases:create', async (event, suppliedNote) => {
    requireTrustedShell(event);
    const note = String(suppliedNote || '').trim().slice(0, 100);
    return simpleLoginRequest('/alias/random/new', { method: 'POST', body: JSON.stringify(note ? { note } : {}) });
  });
  ipcMain.handle('aliases:update-note', async (event, id, suppliedNote) => {
    requireTrustedShell(event);
    const note = String(suppliedNote || '').trim().slice(0, 100);
    return simpleLoginRequest(aliasApiPath(id), { method: 'PATCH', body: JSON.stringify({ note }) });
  });
  ipcMain.handle('aliases:toggle', async (event, id) => {
    requireTrustedShell(event);
    return simpleLoginRequest(aliasApiPath(id) + '/toggle', { method: 'POST' });
  });
  ipcMain.handle('aliases:delete', async (event, id) => {
    requireTrustedShell(event);
    return simpleLoginRequest(aliasApiPath(id), { method: 'DELETE' });
  });
  ipcMain.handle('aliases:disconnect', (event) => {
    requireTrustedShell(event);
    const file = aliasCredentialPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { connected: false };
  });
  ipcMain.on('browser:set-stage-bounds', (event, bounds) => {
    if (!isTrustedShell(event.sender, event.senderFrame) || !bounds) return;
    const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(bounds[key]));
    if (numbers.some((value) => !Number.isFinite(value))) return;
    stageBounds = {
      x: Math.round(numbers[0]),
      y: Math.round(numbers[1]),
      width: Math.max(1, Math.round(numbers[2])),
      height: Math.max(1, Math.round(numbers[3]))
    };
    layoutViews();
  });
  ipcMain.on('window:minimize', (event) => {
    if (isTrustedShell(event.sender, event.senderFrame)) mainWindow.minimize();
  });
  ipcMain.on('window:toggle-maximize', (event) => {
    if (!isTrustedShell(event.sender, event.senderFrame)) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', (event) => {
    if (isTrustedShell(event.sender, event.senderFrame)) mainWindow.close();
  });
}

app.on('before-quit', () => {
  lockPasswordVault();
  try { passkeyServer?.close(); } catch {}
  try { passkeyServerV6?.close(); } catch {}
});

// Speed and privacy: turn off Chromium background services AuraBrowser doesn't use.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-features', 'MediaRouter,OptimizationHints,AutofillServerCommunication,Translate,InterestFeedContentSuggestions,SpareRendererForSitePerProcess');
app.commandLine.appendSwitch('enable-features', 'IntensiveWakeUpThrottling,BackForwardCache');

// One AuraBrowser at a time, so two copies never write to the same profile.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  app.setAppUserModelId('com.aurabrowser.prototype');
  Menu.setApplicationMenu(null);
  loadPreferences();
  loadBookmarks();
  loadPrivateBrowserData();
  try { await startPasskeyOriginServer(); }
  catch (error) { console.error('Password passkey service unavailable:', error.message); }
  internalPage = preferences.setupComplete ? null : 'onboarding';
  torResources = locateTorResources();
  if (!torResources) torStatus = 'unavailable';
  setupSession();
  registerIpc();
  createShell();
  setInterval(saveSessionState, 20_000).unref();
  setInterval(() => {
    const visible = visibleTabIds();
    const sleepAfter = preferences.memorySaverMinutes * 60 * 1000;
    for (const tab of tabs) {
      if (sleepAfter > 0 && !tab.hibernated && !visible.has(tab.id) && Date.now() - tab.lastActive >= sleepAfter) {
        const url = tab.view.webContents.getURL() || tab.url;
        tab.url = normalizeUrl(url) || tab.url;
        tab.title = tab.view.webContents.getTitle() || tab.title;
        mainWindow.contentView.removeChildView(tab.view);
        tab.view.webContents.destroy();
        tab.view = null;
        tab.hibernated = true;
      }
    }
    sendState();
  }, 30_000).unref();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createShell();
});

app.on('before-quit', () => {
  saveSessionState();
  if (torProcess && !torProcess.killed) torProcess.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});