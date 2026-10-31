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
const state = {
  tabs: [],
  bookmarks: [],
  downloads: [],
  passwordVaultUnlocked: false,
  passwordPasskeyEnrolled: false,
  savedPasswordCount: 0,
  activeId: null,
  active: null,
  internalPage: null,
  split: null,
  tor: { available: false, active: false, status: 'off' },
  preferences: {
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
    setupComplete: false,
    memorySaverMinutes: 1,
    shortcuts: { ...DEFAULT_SHORTCUTS }
  }
};
let draggedId = null;
let tabDragInProgress = false;
let aliasStatusLoaded = false;
let aliases = [];
let aliasPage = 0;
let bookmarkDisplayLimit = 100;
let importedBrowserData = { history: [], autofill: [] };
let importedPasswords = [];
let passwordVaultStatus = { enrolled: false, unlocked: false, passwordCount: 0 };
let importListLimits = { history: 50, autofill: 50, passwords: 50 };
let toastTimer = null;

const byId = (id) => document.getElementById(id);
const tabList = byId('tabList');
const addressInput = byId('addressInput');
const splitMenu = byId('splitMenu');
const settingsPage = byId('settingsPage');
const welcomePage = byId('welcomePage');
const tabDropOverlay = byId('tabDropOverlay');
const shell = byId('browserShell');
const stage = byId('webStage');

function hostname(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ''); }
  catch { return 'New page'; }
}

function displayTitle(tab) {
  if (tab.loading) return tab.title && tab.title !== 'New tab' ? tab.title : 'Loading…';
  return tab.title || hostname(tab.url);
}

function renderTabs() {
  tabList.replaceChildren();
  for (const tab of state.tabs) {
    const row = document.createElement('div');
    row.className = 'tab-row' + (tab.id === state.activeId ? ' active' : '');
    row.dataset.id = tab.id;
    row.setAttribute('role', 'listitem');
    row.draggable = true;

    const favicon = document.createElement('span');
    favicon.className = 'tab-favicon';
    if (tab.favicon) {
      const image = document.createElement('img');
      image.src = tab.favicon;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        image.src = './assets/aurabrowser-logo.png';
        image.dataset.auraFallback = 'true';
      }, { once: true });
      favicon.append(image);
    } else {
      const image = document.createElement('img');
      image.src = './assets/aurabrowser-logo.png';
      image.alt = '';
      favicon.append(image);
    }

    const copy = document.createElement('span');
    copy.className = 'tab-copy';
    const title = document.createElement('strong');
    title.textContent = displayTitle(tab);
    const host = document.createElement('small');
    host.textContent = hostname(tab.url);
    copy.append(title, host);

    const indicators = document.createElement('span');
    indicators.className = 'tab-indicators';
    if (tab.hibernated) {
      const sleep = document.createElement('span');
      sleep.className = 'tab-sleep';
      sleep.textContent = '◌';
      sleep.title = 'Sleeping tab';
      indicators.append(sleep);
    }
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close tab');
    close.textContent = '×';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      window.aura.closeTab(tab.id);
    });
    row.append(favicon, copy, indicators, close);
    row.addEventListener('click', () => window.aura.selectTab(tab.id));
    row.addEventListener('dragstart', (event) => {
      draggedId = tab.id;
      tabDragInProgress = true;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tab.id);
      tabDropOverlay.classList.remove('hidden');
      window.aura.beginTabDrag(tab.id);
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('drag-over');
      const from = event.dataTransfer.getData('text/plain') || draggedId;
      if (from && from !== tab.id) window.aura.reorderTabs(from, tab.id);
      draggedId = null;
    });
    row.addEventListener('dragend', finishTabDrag);
    tabList.append(row);
  }
}

function finishTabDrag() {
  draggedId = null;
  tabDragInProgress = false;
  tabDropOverlay.classList.add('hidden');
  document.querySelectorAll('.tab-row').forEach((item) => item.classList.remove('drag-over'));
  byId('splitButton').classList.remove('drop-target');
  if (document.querySelector('.tab-row') && state.tabs.length) renderTabs();
  window.aura.endTabDrag();
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return amount.toFixed(amount >= 10 ? 0 : 1) + ' ' + units[index];
}

function renderDownloads() {
  const list = byId('downloadList');
  const items = state.downloads || [];
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'download-empty';
    empty.textContent = 'Downloads started in this session will appear here.';
    list.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'download-item';
    const details = document.createElement('div');
    details.className = 'download-details';
    const name = document.createElement('b'); name.textContent = item.filename || 'Download';
    const stateText = item.state === 'completed' ? 'Completed' : (item.state === 'cancelled' ? 'Cancelled' : (item.state === 'interrupted' ? 'Interrupted' : (item.paused ? 'Paused' : 'Downloading')));
    const total = Number(item.totalBytes) || 0;
    const received = Number(item.receivedBytes) || 0;
    const status = document.createElement('small');
    status.textContent = item.state === 'completed' ? stateText + ' · ' + formatBytes(received) : (total > 0 ? stateText + ' · ' + formatBytes(received) + ' of ' + formatBytes(total) : stateText + ' · ' + formatBytes(received));
    details.append(name, status);
    if (item.state === 'progressing' && total > 0) {
      const progress = document.createElement('progress'); progress.max = total; progress.value = Math.min(received, total); details.append(progress);
    }
    const actions = document.createElement('div'); actions.className = 'download-actions';
    const addAction = (label, action, title = label) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title + ' ' + (item.filename || 'download')); button.addEventListener('click', async () => { try { await window.aura.downloadAction(item.id, action); } catch (error) { showToast(error.message || 'Download action failed.'); } }); actions.append(button); };
    if (item.state === 'progressing') { addAction(item.paused ? 'Resume' : 'Pause', item.paused ? 'resume' : 'pause'); addAction('Cancel', 'cancel'); }
    if (item.state === 'completed') { addAction('Open', 'open'); addAction('Show', 'show', 'Show in folder'); }
    row.append(details, actions);
    list.append(row);
  }
}

function renderBookmarkButton() {
  const button = byId('bookmarkPageButton');
  const currentUrl = state.active?.url || '';
  const canBookmark = /^https?:\/\//i.test(currentUrl) && state.internalPage !== 'settings';
  const saved = canBookmark && (state.bookmarks || []).some((bookmark) => bookmark.url === currentUrl);
  button.disabled = !canBookmark;
  button.textContent = saved ? '★' : '☆';
  button.classList.toggle('is-bookmarked', saved);
  button.title = saved ? 'Remove bookmark' : 'Bookmark this page';
  button.setAttribute('aria-label', button.title);
}

function renderImportedBookmarks() {
  const list = byId('importedBookmarkList');
  if (!list) return;
  const saved = state.bookmarks || [];
  byId('bookmarkCount').textContent = String(saved.length);
  list.replaceChildren();
  if (!saved.length) {
    const empty = document.createElement('div');
    empty.className = 'bookmark-empty-state';
    empty.textContent = 'No bookmarks yet. Import from a browser or save the page you are viewing with the star button.';
    list.append(empty);
    return;
  }
  for (const bookmark of saved.slice(0, bookmarkDisplayLimit)) {
    const row = document.createElement('article');
    row.className = 'imported-bookmark-row';
    const details = document.createElement('div');
    details.className = 'imported-bookmark-details';
    const title = document.createElement('b');
    title.textContent = bookmark.title || hostname(bookmark.url);
    const address = document.createElement('small');
    address.textContent = bookmark.folder ? bookmark.folder + ' · ' + hostname(bookmark.url) : hostname(bookmark.url);
    details.append(title, address);
    const actions = document.createElement('div');
    actions.className = 'imported-bookmark-actions';
    const open = document.createElement('button');
    open.className = 'alias-small-action';
    open.textContent = 'Open';
    open.addEventListener('click', () => window.aura.navigate(bookmark.url));
    const remove = document.createElement('button');
    remove.className = 'alias-small-action danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => window.aura.removeBookmark(bookmark.id));
    actions.append(open, remove);
    row.append(details, actions);
    list.append(row);
  }
  byId('showMoreBookmarks').classList.toggle('hidden', saved.length <= bookmarkDisplayLimit);
}

function clearImportedPrivateView() {
  importedBrowserData = { history: [], autofill: [] };
  importedPasswords = [];
  importListLimits = { history: 50, autofill: 50, passwords: 50 };
  ['importedHistoryList','importedAutofillList','importedPasswordList'].forEach((id) => byId(id)?.replaceChildren());
}

async function refreshImportedBrowserData() {
  try {
    const data = await window.aura.getImportedData();
    if (!document.querySelector('[data-settings-section="import"].active')) return;
    const vault = await window.aura.passwordVaultStatus();
    if (!document.querySelector('[data-settings-section="import"].active')) return;
    let passwords = [];
    if (vault.unlocked) {
      try { passwords = await window.aura.getPasswords(); }
      catch { vault.unlocked = false; }
    }
    importedBrowserData = data;
    passwordVaultStatus = vault;
    importedPasswords = passwords;
    renderImportedBrowserData();
  } catch (error) {
    byId('bookmarkImportStatus').textContent = error?.message || 'Could not load imported browser data.';
  }
}

function importedDataRow(collection, item, options = {}) {
  const row = document.createElement('article');
  row.className = 'imported-bookmark-row';
  const details = document.createElement('div');
  details.className = 'imported-bookmark-details';
  const title = document.createElement('b');
  title.textContent = options.title || item.title || item.name || hostname(item.url || '');
  details.append(title);
  if (options.secret) {
    const value = document.createElement('input');
    value.className = 'imported-value-field';
    value.type = 'password';
    value.value = String(options.secret);
    value.readOnly = true;
    const reveal = document.createElement('button');
    reveal.className = 'alias-small-action';
    reveal.textContent = 'Show';
    reveal.type = 'button';
    reveal.addEventListener('click', () => {
      value.type = value.type === 'password' ? 'text' : 'password';
      reveal.textContent = value.type === 'password' ? 'Show' : 'Hide';
    });
    details.append(value, reveal);
  }
  const address = document.createElement('small');
  address.textContent = options.detail || item.folder || item.url || item.source || '';
  if (address.textContent) details.append(address);
  const actions = document.createElement('div');
  actions.className = 'imported-bookmark-actions';
  if (options.open) {
    const open = document.createElement('button');
    open.className = 'alias-small-action';
    open.textContent = 'Open';
    open.type = 'button';
    open.addEventListener('click', () => window.aura.navigate(item.url));
    actions.append(open);
  }
  const remove = document.createElement('button');
  remove.className = 'alias-small-action danger';
  remove.textContent = 'Remove';
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    try { await window.aura.removeImportedItem(collection, item.id); await refreshImportedBrowserData(); }
    catch (error) { showToast(error?.message || 'Could not remove imported item.'); }
  });
  actions.append(remove);
  row.append(details, actions);
  return row;
}

function renderImportedBrowserData() {
  const historyList = byId('importedHistoryList');
  const autofillList = byId('importedAutofillList');
  const passwordList = byId('importedPasswordList');
  if (!historyList || !autofillList || !passwordList) return;
  byId('historyCount').textContent = String(importedBrowserData.history.length);
  byId('autofillCount').textContent = String(importedBrowserData.autofill.length);
  const gate = byId('passwordVaultGate');
  const vaultData = byId('passwordVaultData');
  const enrolled = Boolean(passwordVaultStatus.enrolled);
  const unlocked = Boolean(passwordVaultStatus.unlocked);
  gate.classList.toggle('hidden', unlocked);
  vaultData.classList.toggle('hidden', !unlocked);
  byId('passwordVaultTitle').textContent = enrolled ? 'Saved passwords are locked' : 'Protect passwords with a passkey';
  byId('passwordVaultMessage').textContent = enrolled
    ? 'Verify with your passkey or vault PIN. The vault locks again after one minute or when you leave this page.'
    : 'Set up a passkey (Windows Hello, an Android or iPhone passkey, or a security key) or a vault PIN. AuraBrowser will ask for it every time before showing saved passwords.';
  byId('unlockPasswordVault').textContent = enrolled ? 'Unlock' : 'Set up protection';
  byId('passwordCount').textContent = String(passwordVaultStatus.passwordCount);
  if (!unlocked) importedPasswords = [];
  historyList.replaceChildren();
  for (const item of importedBrowserData.history.slice(0, importListLimits.history)) {
    const when = Number(item.visitedAt) ? new Date(item.visitedAt).toLocaleString() : '';
    historyList.append(importedDataRow('history', item, { open: true, detail: when + (when ? ' · ' : '') + item.url }));
  }
  byId('showMoreHistory').classList.toggle('hidden', importedBrowserData.history.length <= importListLimits.history);
  if (!importedBrowserData.history.length) historyList.append(emptyImportedData('History from AuraBrowser and imported profiles will appear here.'));
  autofillList.replaceChildren();
  for (const item of importedBrowserData.autofill.slice(0, importListLimits.autofill)) autofillList.append(importedDataRow('autofill', item, { title: item.name, detail: item.source, secret: item.value }));
  byId('showMoreAutofill').classList.toggle('hidden', importedBrowserData.autofill.length <= importListLimits.autofill);
  if (!importedBrowserData.autofill.length) autofillList.append(emptyImportedData('No imported autofill values yet.'));
  passwordList.replaceChildren();
  for (const item of importedPasswords.slice(0, importListLimits.passwords)) passwordList.append(importedDataRow('passwords', item, { title: hostname(item.url), detail: item.username || item.url, secret: item.password }));
  byId('showMorePasswords').classList.toggle('hidden', importedPasswords.length <= importListLimits.passwords);
  if (!importedPasswords.length) passwordList.append(emptyImportedData('No saved passwords imported yet.'));
}

function emptyImportedData(text) {
  const empty = document.createElement('div');
  empty.className = 'bookmark-empty-state';
  empty.textContent = text;
  return empty;
}

function migrationResultText(result) {
  const name = ({ chrome: 'Chrome', edge: 'Edge', brave: 'Brave', firefox: 'Firefox' })[result.browser] || result.browser;
  const search = result.searchEngine ? ' Search engine set to ' + result.searchEngine + '.' : '';
  const cookieText = result.cookies ? ' ' + result.cookies + ' readable cookies restored.' : '';
  const locked = result.encryptedCookies ? ' ' + result.encryptedCookies + ' encrypted cookies could not be read.' : '';
  const cookieMerge = result.profiles > 1 && result.cookies ? ' Cookies from multiple profiles share Aura’s single cookie store.' : '';
  const skipped = result.skipped?.length ? ' ' + result.skipped.length + ' profile(s) could not be read; close that browser and retry.' : '';
  return name + ': imported ' + result.bookmarks + ' bookmarks, ' + result.history + ' visits, and ' + result.autofill + ' autofill values from ' + result.profiles + ' profile(s).' + cookieText + locked + cookieMerge + search + skipped + ' Export passwords as CSV to import them.';
}
function updateConnection() {
  const pill = byId('connectionPill');
  const label = byId('connectionText');
  const lock = byId('addressLock');
  const isInternalPage = ['settings', 'onboarding'].includes(state.internalPage);
  const url = state.internalPage === 'onboarding' ? 'aurabrowser://setup' : (isInternalPage ? 'aurabrowser://settings' : (state.active?.url || ''));
  const isHttps = url.startsWith('https://');
  const hasError = !isInternalPage && Boolean(state.active?.error);
  pill.classList.toggle('error', hasError);
  pill.classList.toggle('insecure', !isInternalPage && !hasError && Boolean(url) && !isHttps);
  lock.classList.toggle('error', hasError);
  lock.classList.toggle('unencrypted', !isInternalPage && !hasError && Boolean(url) && !isHttps);
  if (state.internalPage === 'settings') label.textContent = 'Settings';
  else if (state.internalPage === 'onboarding') label.textContent = 'Welcome';
  else label.textContent = state.active?.loading ? 'Connecting…' : (hasError ? 'Load failed' : (isHttps ? 'HTTPS' : (url ? 'HTTP' : 'Waiting')));
  lock.textContent = isInternalPage ? '⚙' : (isHttps ? '⌑' : '◇');
  byId('blockedCount').textContent = (state.active?.blockedCount || 0) + ' requests filtered';
  byId('pageTitle').textContent = state.internalPage === 'settings' ? 'Settings' : (state.internalPage === 'onboarding' ? 'Welcome' : (state.active?.title || 'AuraBrowser'));
}

function renderTor() {
  const button = byId('torToggle');
  const status = byId('torStatus');
  if (!state.tor?.available) {
    button.disabled = true;
    button.textContent = 'Not bundled';
    status.textContent = 'This development copy has no Tor bundle yet.';
    return;
  }
  button.disabled = state.tor.status === 'starting';
  button.textContent = state.tor.active ? 'Disconnect' : (state.tor.status === 'starting' ? 'Starting…' : 'Connect');
  status.textContent = state.tor.active
    ? 'Browser traffic is routed through the bundled Tor daemon.'
    : (state.tor.status === 'error' ? 'Tor could not connect. Check your network.' : 'Bundled and ready when you need it.');
}

function render() {
  passwordVaultStatus.enrolled = Boolean(state.passwordPasskeyEnrolled);
  passwordVaultStatus.unlocked = Boolean(state.passwordVaultUnlocked);
  passwordVaultStatus.passwordCount = Number(state.savedPasswordCount) || 0;
  if (!passwordVaultStatus.unlocked) importedPasswords = [];
  if (!tabDragInProgress) renderTabs();
  const isSettings = state.internalPage === 'settings';
  const isSetup = state.internalPage === 'onboarding';
  settingsPage.classList.toggle('hidden', !isSettings);
  welcomePage.classList.toggle('hidden', !isSetup);
  if (isSetup && !welcomePage.dataset.initialized) {
    const setupPrefs = state.preferences;
    byId('setupProfileName').value = setupPrefs.profileName || 'Personal';
    byId('setupCountry').value = setupPrefs.country || 'IN';
    byId('setupLanguage').value = setupPrefs.language || 'en';
    byId('setupTheme').value = setupPrefs.theme || 'dark';
    byId('setupInterfaceSize').value = setupPrefs.interfaceSize || 'medium';
    byId('setupSearchEngine').value = setupPrefs.searchEngine || 'brave';
    byId('setupPageZoom').value = String(setupPrefs.pageZoom ?? 1);
    byId('setupPageZoomValue').textContent = Math.round((setupPrefs.pageZoom ?? 1) * 100) + '%';
    welcomePage.dataset.initialized = 'true';
  }
  tabDropOverlay.classList.toggle('hidden', !tabDragInProgress);
  if (isSettings) addressInput.value = 'aurabrowser://settings';
  else if (isSetup) addressInput.value = 'aurabrowser://setup';
  else if (state.active && document.activeElement !== addressInput) addressInput.value = state.active.url || '';
  updateConnection();
  renderTor();
  const prefs = state.preferences;
  document.documentElement.dataset.textSize = prefs.interfaceSize || 'medium';
  document.documentElement.dataset.theme = prefs.theme || 'dark';
  document.documentElement.dataset.reducedMotion = String(Boolean(prefs.reducedMotion));
  byId('profileNameLabel').textContent = (prefs.profileName || 'Personal').toLocaleUpperCase();
  if (document.activeElement !== byId('profileName')) byId('profileName').value = prefs.profileName || 'Personal';
  byId('country').value = prefs.country || 'IN';
  byId('language').value = prefs.language || 'en';
  byId('theme').value = prefs.theme || 'dark';
  byId('trackerToggle').checked = Boolean(prefs.blockTrackers);
  byId('httpsToggle').checked = Boolean(prefs.httpsOnly);
  byId('popupToggle').checked = Boolean(prefs.blockPopups);
  byId('reducedMotionToggle').checked = Boolean(prefs.reducedMotion);
  byId('downloadDirectoryLabel').textContent = prefs.downloadDirectory || 'Ask where to save each file';
  byId('interfaceSize').value = prefs.interfaceSize || 'medium';
  byId('pageZoom').value = String(prefs.pageZoom ?? 1);
  byId('pageZoomValue').textContent = Math.round((prefs.pageZoom ?? 1) * 100) + '%';
  byId('searchEngine').value = prefs.searchEngine || 'brave';
  byId('memorySaver').value = String(prefs.memorySaverMinutes ?? 1);
  byId('hibernationNote').innerHTML = prefs.memorySaverMinutes === 0
    ? 'Background tabs stay <b>awake</b>'
    : 'Quiet tabs sleep after <b>' + prefs.memorySaverMinutes + ' min</b>'; 
  document.querySelectorAll('.shortcut-input').forEach((input) => {
    if (document.activeElement !== input) input.value = prefs.shortcuts?.[input.dataset.shortcut] || DEFAULT_SHORTCUTS[input.dataset.shortcut];
  });
  renderBookmarkButton();
  renderImportedBookmarks();
  renderDownloads();
  const splitOn = Boolean(state.split);
  byId('splitIndicator').classList.toggle('hidden', !splitOn);
  if (splitOn) {
    const names = state.split.ids.map((id) => {
      const tab = state.tabs.find((item) => item.id === id);
      return tab ? displayTitle(tab) : '';
    });
    byId('splitLabel').textContent = state.split.mode === 3
      ? 'Three page view'
      : (state.split.ratio === 0.6 ? 'Wide + narrow' : 'Side by side') + ' · ' + names.filter(Boolean).join(' / ');
  }
  if (isSettings && !aliasStatusLoaded) loadAliasStatus();
  requestAnimationFrame(updateStageBounds);
}

function updateStageBounds() {
  const rect = stage.getBoundingClientRect();
  window.aura.setStageBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4200);
}

function expandSidebarForPanel() {
  shell.classList.remove('sidebar-collapsed');
  document.body.classList.remove('focus-mode');
  requestAnimationFrame(updateStageBounds);
}

function showSettings(section = 'appearance') {
  if (!state.preferences.setupComplete) return;
  expandSidebarForPanel();
  splitMenu.classList.add('hidden');
  selectSettingsSection(section);
  if (state.internalPage !== 'settings') window.aura.toggleSettings();
  if (!aliasStatusLoaded) loadAliasStatus();
}

function hideSettings() {
  window.aura.lockPasswordVault();
  window.aura.closeSettings();
  passwordVaultStatus.unlocked = false;
  clearImportedPrivateView();
}

function selectSettingsSection(name) {
  document.querySelectorAll('.settings-nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.settingsTarget === name);
  });
  document.querySelectorAll('.settings-section').forEach((section) => {
    section.classList.toggle('active', section.dataset.settingsSection === name);
  });
  if (name === 'import') void refreshImportedBrowserData();
  else { window.aura.lockPasswordVault(); passwordVaultStatus.unlocked = false; clearImportedPrivateView(); }
}
async function submitAddress(event) {
  event.preventDefault();
  const value = addressInput.value.trim();
  if (value) await window.aura.navigate(value);
  addressInput.blur();
}

byId('addressForm').addEventListener('submit', (event) => {
  if (addressInput.value.trim().toLowerCase() === 'aurabrowser://settings') { event.preventDefault(); showSettings(); return; }
  submitAddress(event);
});
byId('backButton').addEventListener('click', () => ['settings', 'onboarding'].includes(state.internalPage) ? hideSettings() : window.aura.goBack());
byId('forwardButton').addEventListener('click', () => window.aura.goForward());
byId('reloadButton').addEventListener('click', () => window.aura.reload());
byId('newTab').addEventListener('click', () => window.aura.createTab());
byId('newTabLarge').addEventListener('click', () => window.aura.createTab());
byId('glanceButton').addEventListener('click', () => window.aura.openGlance(addressInput.value.trim() || state.active?.url));
byId('collapseSidebar').addEventListener('click', () => {
  shell.classList.toggle('sidebar-collapsed');
  requestAnimationFrame(updateStageBounds);
});
byId('focusButton').addEventListener('click', () => {
  document.body.classList.toggle('focus-mode');
  requestAnimationFrame(updateStageBounds);
});
byId('splitButton').addEventListener('click', () => {
  expandSidebarForPanel();
  splitMenu.classList.toggle('hidden');
});
tabDropOverlay.addEventListener('dragover', (event) => {
  if (!draggedId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});
tabDropOverlay.addEventListener('drop', (event) => {
  event.preventDefault();
  const tabId = event.dataTransfer.getData('text/plain') || draggedId;
  if (tabId && tabId !== state.activeId) {
    splitMenu.classList.add('hidden');
    window.aura.setSplit(2, 0.5, tabId);
    showToast('Split view opened with the dragged tab.');
  }
});
byId('splitButton').addEventListener('dragover', (event) => {
  if (!draggedId) return;
  event.preventDefault();
  byId('splitButton').classList.add('drop-target');
});
byId('splitButton').addEventListener('dragleave', () => byId('splitButton').classList.remove('drop-target'));
byId('splitButton').addEventListener('drop', (event) => {
  event.preventDefault();
  const tabId = event.dataTransfer.getData('text/plain') || draggedId;
  byId('splitButton').classList.remove('drop-target');
  if (tabId && tabId !== state.activeId) {
    splitMenu.classList.add('hidden');
    window.aura.setSplit(2, 0.5, tabId);
    showToast('Split view opened with the dragged tab.');
  }
  draggedId = null;
});
byId('showMoreBookmarks').addEventListener('click', () => { bookmarkDisplayLimit += 100; renderImportedBookmarks(); });
byId('bookmarkPageButton').addEventListener('click', async () => {
  const result = await window.aura.toggleBookmark();
  showToast(result.saved ? 'Page bookmarked.' : 'Bookmark removed.');
});
document.querySelectorAll('[data-import-source]').forEach((button) => {
  button.addEventListener('click', async () => {
    const source = button.dataset.importSource;
    button.disabled = true;
    byId('bookmarkImportStatus').textContent = source === 'file' ? 'Choose a bookmark export…' : 'Looking for bookmarks…';
    try {
      const result = await window.aura.importBookmarks(source);
      if (result.canceled) {
        byId('bookmarkImportStatus').textContent = 'Import cancelled.';
      } else if (!result.imported) {
        byId('bookmarkImportStatus').textContent = 'No new bookmarks found. Existing bookmarks were kept.';
      } else {
        byId('bookmarkImportStatus').textContent = 'Imported ' + result.imported + ' bookmark' + (result.imported === 1 ? '' : 's') + ' from ' + result.source + '.';
      }
    } catch (error) {
      byId('bookmarkImportStatus').textContent = error.message || 'Could not import that bookmark file.';
    } finally {
      button.disabled = false;
    }
  });
});

document.querySelectorAll('[data-migrate-source]').forEach((button) => {
  button.addEventListener('click', async () => {
    const source = button.dataset.migrateSource;
    const buttons = [...document.querySelectorAll('[data-migrate-source]')];
    buttons.forEach((item) => { item.disabled = true; });
    byId('bookmarkImportStatus').textContent = 'Scanning every detected ' + source + ' profile…';
    try {
      const result = await window.aura.importProfile(source);
      byId('bookmarkImportStatus').textContent = migrationResultText(result);
      await refreshImportedBrowserData();
      byId('bookmarkImportStatus').textContent = migrationResultText(result);
    } catch (error) {
      byId('bookmarkImportStatus').textContent = error.message || 'Could not import browser data. Close the source browser and retry.';
    } finally { buttons.forEach((item) => { item.disabled = false; }); }
  });
});
byId('unlockPasswordVault').addEventListener('click', async () => {
  const button = byId('unlockPasswordVault');
  button.disabled = true;
  try {
    const result = await window.aura.unlockPasswordVault();
    if (result?.ok) {
      passwordVaultStatus = await window.aura.passwordVaultStatus();
      await refreshImportedBrowserData();
      showToast('Password vault unlocked for one minute.');
    } else if (result?.error) showToast(result.error);
  } catch (error) { showToast(error.message || 'Could not open the passkey prompt.'); }
  finally { button.disabled = false; }
});
byId('lockPasswordVault').addEventListener('click', async () => {
  await window.aura.lockPasswordVault();
  passwordVaultStatus.unlocked = false;
  importedPasswords = [];
  renderImportedBrowserData();
  showToast('Password vault locked.');
});
byId('importPasswordCsv').addEventListener('click', async () => {
  byId('bookmarkImportStatus').textContent = 'Choose a saved-password CSV exported from Chrome, Edge, Brave, or Firefox.';
  try {
    const result = await window.aura.importPasswordCsv();
    if (result.canceled) return;
    byId('bookmarkImportStatus').textContent = result.added + ' passwords imported into AuraBrowser’s encrypted local vault. Delete the plaintext CSV export afterward.' + (result.ignored ? ' ' + result.ignored + ' duplicate rows were skipped.' : '');
    await refreshImportedBrowserData();
  } catch (error) { byId('bookmarkImportStatus').textContent = error.message || 'Could not import the password CSV.'; }
});
byId('clearImportedHistory').addEventListener('click', async () => {
  if (!window.confirm('Clear all AuraBrowser and imported browsing history?')) return;
  try { await window.aura.clearHistory(); await refreshImportedBrowserData(); }
  catch (error) { showToast(error.message || 'Could not clear browsing history.'); }
});
[['history', 'showMoreHistory'], ['autofill', 'showMoreAutofill'], ['passwords', 'showMorePasswords']].forEach(([kind, id]) => {
  byId(id).addEventListener('click', () => {
    importListLimits[kind] += 50;
    renderImportedBrowserData();
  });
});
byId('settingsButton').addEventListener('click', () => {
  if (!state.preferences.setupComplete) return;
  if (state.internalPage !== 'settings') showSettings();
  else hideSettings();
});
byId('privacyButton').addEventListener('click', () => showSettings('privacy'));
byId('downloadsButton').addEventListener('click', () => showSettings('downloads'));
byId('closeSettings').addEventListener('click', hideSettings);
byId('torToggle').addEventListener('click', () => window.aura.toggleTor());

function setAliasMessage(message, isError = false) {
  const box = byId('aliasMessage');
  box.textContent = message || '';
  box.classList.toggle('error', isError);
}

async function loadAliasStatus() {
  aliasStatusLoaded = true;
  try {
    const result = await window.aura.aliasesStatus();
    byId('aliasConnectPanel').classList.toggle('hidden', result.connected);
    byId('aliasManager').classList.toggle('hidden', !result.connected);
    if (!result.encryptionAvailable && !result.connected) {
      byId('connectAliases').disabled = true;
      setAliasMessage('OS credential encryption is not available, so AuraBrowser cannot safely store an API key.', true);
    }
    if (result.connected) {
      byId('aliasAccountEmail').textContent = 'SimpleLogin account connected';
      await loadAliases(0, false);
    }
  } catch (error) {
    aliasStatusLoaded = false;
    setAliasMessage(error.message || 'Could not check the alias connection.', true);
  }
}

async function loadAliases(page = 0, append = false) {
  setAliasMessage(page === 0 ? 'Loading aliases…' : 'Loading more aliases…');
  byId('loadMoreAliases').disabled = true;
  try {
    const result = await window.aura.aliasesList(page);
    aliasPage = page;
    if (!append) aliases = [];
    const knownIds = new Set(aliases.map((item) => String(item.id)));
    aliases.push(...result.aliases.filter((item) => !knownIds.has(String(item.id))));
    renderAliasList();
    byId('loadMoreAliases').classList.toggle('hidden', !result.hasMore);
    setAliasMessage(aliases.length ? '' : 'No aliases yet. Create one for your next sign-up.');
  } catch (error) {
    setAliasMessage(error.message || 'Could not load aliases.', true);
  } finally {
    byId('loadMoreAliases').disabled = false;
  }
}

function renderAliasList() {
  const list = byId('aliasList');
  list.replaceChildren();
  for (const alias of aliases) {
    const card = document.createElement('article');
    card.className = 'alias-card' + (alias.enabled ? '' : ' disabled');
    const addressRow = document.createElement('div');
    addressRow.className = 'alias-address-row';
    const address = document.createElement('code');
    address.textContent = alias.email || 'Alias';
    const copy = document.createElement('button');
    copy.className = 'alias-small-action';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await window.aura.copyText(alias.email || '');
        setAliasMessage('Alias copied to clipboard.');
      } catch {
        setAliasMessage('Clipboard access is unavailable.', true);
      }
    });
    addressRow.append(address, copy);
    const noteRow = document.createElement('div');
    noteRow.className = 'alias-note-row';
    const note = document.createElement('input');
    note.type = 'text';
    note.maxLength = 100;
    note.value = alias.note || '';
    note.placeholder = 'Add a note';
    const saveNote = document.createElement('button');
    saveNote.className = 'alias-small-action';
    saveNote.textContent = 'Save note';
    saveNote.addEventListener('click', async () => {
      saveNote.disabled = true;
      try {
        await window.aura.aliasesUpdateNote(alias.id, note.value);
        alias.note = note.value.trim();
        setAliasMessage('Alias note saved.');
      } catch (error) {
        setAliasMessage(error.message || 'Could not save the note.', true);
      } finally { saveNote.disabled = false; }
    });
    noteRow.append(note, saveNote);
    const actions = document.createElement('div');
    actions.className = 'alias-card-actions';
    const toggle = document.createElement('button');
    toggle.className = 'alias-small-action';
    toggle.textContent = alias.enabled ? 'Turn off' : 'Turn on';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try { await window.aura.aliasesToggle(alias.id); await loadAliases(0, false); }
      catch (error) { setAliasMessage(error.message || 'Could not update the alias.', true); }
      finally { toggle.disabled = false; }
    });
    const remove = document.createElement('button');
    remove.className = 'alias-small-action danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Delete this email alias? Messages sent to it will no longer be forwarded.')) return;
      remove.disabled = true;
      try { await window.aura.aliasesDelete(alias.id); aliases = aliases.filter((item) => item.id !== alias.id); renderAliasList(); setAliasMessage('Alias deleted.'); }
      catch (error) { setAliasMessage(error.message || 'Could not delete the alias.', true); }
      finally { remove.disabled = false; }
    });
    actions.append(toggle, remove);
    card.append(addressRow, noteRow, actions);
    list.append(card);
  }
}

byId('connectAliases').addEventListener('click', async () => {
  const input = byId('simpleLoginApiKey');
  const key = input.value.trim();
  if (!key) { setAliasMessage('Paste a SimpleLogin API key first.', true); input.focus(); return; }
  byId('connectAliases').disabled = true;
  setAliasMessage('Checking your SimpleLogin account…');
  try {
    const result = await window.aura.aliasesConnect(key);
    input.value = '';
    byId('aliasConnectPanel').classList.add('hidden');
    byId('aliasManager').classList.remove('hidden');
    byId('aliasAccountEmail').textContent = result.email || 'SimpleLogin account connected';
    await loadAliases(0, false);
  } catch (error) {
    setAliasMessage(error.message || 'Could not connect to SimpleLogin.', true);
  } finally { byId('connectAliases').disabled = false; }
});
byId('createAlias').addEventListener('click', async () => {
  const button = byId('createAlias');
  button.disabled = true;
  setAliasMessage('Creating a forwarding alias…');
  try {
    const result = await window.aura.aliasesCreate(byId('aliasNote').value);
    const alias = result.alias || result;
    byId('aliasNote').value = '';
    await loadAliases(0, false);
    setAliasMessage(alias.email ? 'Created ' + alias.email : 'Alias created.');
  } catch (error) {
    setAliasMessage(error.message || 'Could not create the alias.', true);
  } finally { button.disabled = false; }
});
byId('loadMoreAliases').addEventListener('click', () => loadAliases(aliasPage + 1, true));
byId('disconnectAliases').addEventListener('click', async () => {
  await window.aura.aliasesDisconnect();
  aliases = [];
  renderAliasList();
  aliasStatusLoaded = true;
  byId('aliasManager').classList.add('hidden');
  byId('aliasConnectPanel').classList.remove('hidden');
  showToast('SimpleLogin disconnected. Existing aliases remain in your account.');
});

byId('trackerToggle').addEventListener('change', () => {
  window.aura.updatePreferences({ blockTrackers: byId('trackerToggle').checked });
});
byId('httpsToggle').addEventListener('change', () => {
  window.aura.updatePreferences({ httpsOnly: byId('httpsToggle').checked });
});
byId('interfaceSize').addEventListener('change', () => {
  window.aura.updatePreferences({ interfaceSize: byId('interfaceSize').value });
});
byId('searchEngine').addEventListener('change', async () => {
  const selected = byId('searchEngine').value;
  try {
    const prefs = await window.aura.updatePreferences({ searchEngine: selected });
    state.preferences = { ...state.preferences, ...prefs };
    render();
    const label = ({ brave: 'Brave Search', duckduckgo: 'DuckDuckGo', google: 'Google', bing: 'Bing', startpage: 'Startpage', ecosia: 'Ecosia' })[selected] || 'your selected engine';
    showToast(label + ' is now the default for address-bar searches and new tabs.');
  } catch (error) { showToast(error.message || 'Could not update the search engine.'); }
});
byId('memorySaver').addEventListener('change', () => {
  window.aura.updatePreferences({ memorySaverMinutes: Number(byId('memorySaver').value) });
});
byId('popupToggle').addEventListener('change', () => window.aura.updatePreferences({ blockPopups: byId('popupToggle').checked }));
byId('theme').addEventListener('change', () => window.aura.updatePreferences({ theme: byId('theme').value }));
byId('language').addEventListener('change', () => window.aura.updatePreferences({ language: byId('language').value }));
byId('country').addEventListener('change', () => window.aura.updatePreferences({ country: byId('country').value }));
byId('profileName').addEventListener('change', () => window.aura.updatePreferences({ profileName: byId('profileName').value }));
byId('reducedMotionToggle').addEventListener('change', () => window.aura.updatePreferences({ reducedMotion: byId('reducedMotionToggle').checked }));
byId('pageZoom').addEventListener('input', () => { byId('pageZoomValue').textContent = Math.round(Number(byId('pageZoom').value) * 100) + '%'; });
byId('pageZoom').addEventListener('change', () => window.aura.updatePreferences({ pageZoom: Number(byId('pageZoom').value) }));
byId('chooseDownloadDirectory').addEventListener('click', async () => {
  try { const directory = await window.aura.chooseDownloadDirectory(); if (directory) showToast('Download folder updated.'); }
  catch (error) { showToast(error.message || 'Could not choose a download folder.'); }
});
byId('clearDownloadDirectory').addEventListener('click', () => window.aura.updatePreferences({ downloadDirectory: '' }));
byId('clearSiteData').addEventListener('click', async () => {
  if (!window.confirm('Clear cookies, site storage, and cached files? This signs you out of websites.')) return;
  try { await window.aura.clearSiteData(); showToast('Site data and cache cleared.'); }
  catch (error) { showToast(error.message || 'Could not clear site data.'); }
});
byId('openDevTools').addEventListener('click', () => window.aura.openDevTools());
const findInput = byId('findInput');
function runFind(direction = 'forward', newSearch = false) { window.aura.findText(findInput.value, direction, newSearch); }
function openFindBar() {
  byId('findBar').classList.remove('hidden');
  findInput.focus(); findInput.select();
  if (findInput.value) runFind('forward', true);
}
function closeFindBar() {
  byId('findBar').classList.add('hidden');
  byId('findMatchCount').textContent = '';
  window.aura.stopFind();
  addressInput.focus();
}
findInput.addEventListener('input', () => runFind('forward', true));
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeFindBar(); }
  if (event.key === 'Enter') { event.preventDefault(); runFind(event.shiftKey ? 'backward' : 'forward'); }
});
byId('findPrevious').addEventListener('click', () => runFind('backward'));
byId('findNext').addEventListener('click', () => runFind('forward'));
byId('closeFind').addEventListener('click', closeFindBar);
byId('setupPageZoom').addEventListener('input', () => { byId('setupPageZoomValue').textContent = Math.round(Number(byId('setupPageZoom').value) * 100) + '%'; });
byId('finishSetup').addEventListener('click', async () => {
  const button = byId('finishSetup');
  button.disabled = true;
  try {
    const completed = await window.aura.completeSetup({ profileName: byId('setupProfileName').value, country: byId('setupCountry').value, language: byId('setupLanguage').value, theme: byId('setupTheme').value, interfaceSize: byId('setupInterfaceSize').value, searchEngine: byId('setupSearchEngine').value, pageZoom: Number(byId('setupPageZoom').value) });
    if (completed) showToast('AuraBrowser is ready.');
  } catch (error) { showToast(error.message || 'Could not save first-run settings.'); }
  finally { button.disabled = false; }
});
document.querySelector('[data-first-run-password-import]').addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true;
  byId('setupImportStatus').textContent = 'Choose a password CSV exported from another browser…';
  try {
    const result = await window.aura.importPasswordCsv();
    if (!result.canceled) byId('setupImportStatus').textContent = result.added + ' saved password(s) imported.' + (result.ignored ? ' ' + result.ignored + ' duplicate rows skipped.' : '');
  } catch (error) { byId('setupImportStatus').textContent = error.message || 'Could not import password CSV.'; }
  finally { button.disabled = false; }
});
document.querySelector('[data-first-run-bookmark-import]').addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true;
  byId('setupImportStatus').textContent = 'Choose a Firefox HTML or Chromium JSON bookmark export…';
  try {
    const result = await window.aura.importBookmarks('file');
    if (result.canceled) byId('setupImportStatus').textContent = 'Bookmark import cancelled.';
    else byId('setupImportStatus').textContent = 'Imported ' + result.imported + ' bookmark(s).';
  } catch (error) { byId('setupImportStatus').textContent = error.message || 'Could not import the bookmark file.'; }
  finally { button.disabled = false; }
});
document.querySelectorAll('[data-first-run-import]').forEach((button) => button.addEventListener('click', async () => {
  const source = button.dataset.firstRunImport;
  const buttons = [...document.querySelectorAll('[data-first-run-import]')];
  buttons.forEach((item) => { item.disabled = true; });
  byId('setupImportStatus').textContent = 'Scanning every detected ' + source + ' profile…';
  try {
    const result = await window.aura.importProfile(source);
    byId('setupImportStatus').textContent = migrationResultText(result);
    if (result.searchEngine) byId('setupSearchEngine').value = result.searchEngine;
  } catch (error) { byId('setupImportStatus').textContent = error.message || 'Import failed. Close the source browser and retry.'; }
  finally { buttons.forEach((item) => { item.disabled = false; }); }
}));

document.querySelectorAll('[data-split]').forEach((button) => {
  button.addEventListener('click', () => {
    const choice = button.dataset.split;
    splitMenu.classList.add('hidden');
    if (choice === 'off') window.aura.setSplit(0, 0);
    if (choice === 'half') window.aura.setSplit(2, 0.5);
    if (choice === 'wide') window.aura.setSplit(2, 0.6);
    if (choice === 'three') window.aura.setSplit(3, 1 / 3);
  });
});

function canonicalShortcutParts(event) {
  const key = event.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.metaKey) modifiers.push('Meta');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (!modifiers.length && !/^F([1-9]|1[0-2])$/.test(key)) return null;
  let normalizedKey = key === ' ' ? 'Space' : (['+', '=', 'Add'].includes(key) ? 'Plus' : key);
  if (normalizedKey === 'Plus' || normalizedKey === '-') { const shiftIndex = modifiers.indexOf('Shift'); if (shiftIndex >= 0) modifiers.splice(shiftIndex, 1); }
  if (normalizedKey.length === 1) normalizedKey = normalizedKey.toUpperCase();
  return modifiers.concat(normalizedKey).join('+');
}

document.querySelectorAll('.shortcut-input').forEach((input) => {
  input.addEventListener('focus', () => {
    input.dataset.previous = input.value;
    input.value = 'Press keys…';
    window.aura.setShortcutCapture(true);
  });
  input.addEventListener('keydown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      input.value = input.dataset.previous || '';
      window.aura.setShortcutCapture(false);
      input.blur();
      return;
    }
    const combo = canonicalShortcutParts(event);
    if (!combo) return;
    const action = input.dataset.shortcut;
    const conflict = Object.entries(state.preferences.shortcuts || {}).find(([other, value]) => other !== action && value === combo);
    if (conflict) {
      showToast('That shortcut is already used by “' + (document.querySelector('.shortcut-input[data-shortcut="' + conflict[0] + '"]')?.closest('.shortcut-row')?.querySelector('span')?.textContent || conflict[0]) + '”.');
      return;
    }
    window.aura.updatePreferences({ shortcuts: { [action]: combo } });
    window.aura.setShortcutCapture(false);
    input.blur();
  });
  input.addEventListener('blur', () => window.aura.setShortcutCapture(false));
});
byId('resetShortcuts').addEventListener('click', () => window.aura.updatePreferences({ shortcuts: { ...DEFAULT_SHORTCUTS } }));
byId('resetBrowserSettings').addEventListener('click', () => {
  if (window.confirm('Restore all AuraBrowser preferences to their defaults?')) window.aura.updatePreferences({ blockTrackers: true, httpsOnly: true, blockPopups: true, searchEngine: 'brave', interfaceSize: 'medium', pageZoom: 1, theme: 'dark', language: 'en', country: 'IN', profileName: 'Personal', reducedMotion: false, downloadDirectory: '', memorySaverMinutes: 1, shortcuts: { ...DEFAULT_SHORTCUTS } });
});

byId('minimizeWindow').addEventListener('click', () => window.aura.minimize());
byId('maximizeWindow').addEventListener('click', () => window.aura.toggleMaximize());
byId('closeWindow').addEventListener('click', () => window.aura.closeWindow());

document.querySelectorAll('.settings-nav-item').forEach((button) => button.addEventListener('click', () => selectSettingsSection(button.dataset.settingsTarget)));
byId('settingsSearch').addEventListener('input', () => {
  const query = byId('settingsSearch').value.trim().toLowerCase();
  let firstMatch = null;
  document.querySelectorAll('.settings-nav-item').forEach((button) => {
    const section = document.querySelector('[data-settings-section="' + button.dataset.settingsTarget + '"]');
    const matched = !query || (button.textContent + ' ' + (section?.textContent || '')).toLowerCase().includes(query);
    button.classList.toggle('filtered-out', !matched);
    if (matched && !firstMatch) firstMatch = button.dataset.settingsTarget;
  });
  if (query && firstMatch) selectSettingsSection(firstMatch);
});
window.addEventListener('resize', updateStageBounds);
new ResizeObserver(updateStageBounds).observe(stage);
const PERMISSION_LABELS = { camera: 'Camera', microphone: 'Microphone', geolocation: 'Location', notifications: 'Notifications', 'clipboard-read': 'Clipboard' };
function renderSitePermissions() {
  const list = byId('sitePermissionList');
  if (!list) return;
  const items = Array.isArray(state.sitePermissions) ? state.sitePermissions : [];
  const signature = JSON.stringify(items);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'site-permission-empty';
    empty.textContent = 'No sites have asked yet.';
    list.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'setting-row informational';
    const copy = document.createElement('span');
    copy.className = 'setting-copy';
    const name = document.createElement('b');
    name.textContent = item.origin.replace(/^https?:\/\//, '');
    const detail = document.createElement('small');
    detail.textContent = (PERMISSION_LABELS[item.name] || item.name) + ': ' + (item.value === 'allow' ? 'Allowed' : 'Blocked');
    copy.append(name, detail);
    const remove = document.createElement('button');
    remove.className = 'setting-action';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => window.aura.removeSitePermission(item.origin, item.name));
    row.append(copy, remove);
    list.append(row);
  }
}
window.aura.onState((nextState) => {
  Object.assign(state, nextState);
  render();
  renderSitePermissions();
  if (state.appVersion) byId('aboutVersion').textContent = 'AuraBrowser ' + state.appVersion;
});
byId('resetSitePermissions').addEventListener('click', async () => {
  await window.aura.resetSitePermissions();
  showToast('Site permissions reset. Sites will ask again.');
});
byId('copyFeedbackEmail').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('13teamsaura@gmail.com'); showToast('Feedback email copied.'); }
  catch { showToast('Feedback email: 13teamsaura@gmail.com'); }
});
window.aura.onToast(showToast);
window.aura.onFindResult((result) => {
  byId('findMatchCount').textContent = result.matches ? result.activeMatchOrdinal + ' of ' + result.matches : 'No matches';
});
window.aura.onCommand((command) => {
  if (command === 'focus-address') {
    addressInput.focus();
    addressInput.select();
  }
  if (command === 'settings') {
    if (!state.preferences.setupComplete) return;
    if (state.internalPage !== 'settings') showSettings();
    else hideSettings();
  }
  if (command === 'glance') window.aura.openGlance(addressInput.value.trim() || state.active?.url);
  if (command === 'find-page') openFindBar();
});
window.aura.getState().then((initialState) => {
  Object.assign(state, initialState);
  render();
});