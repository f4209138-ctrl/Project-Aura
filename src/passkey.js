const title = document.getElementById('passkeyTitle');
const description = document.getElementById('passkeyDescription');
const status = document.getElementById('passkeyStatus');
const proceed = document.getElementById('passkeyContinue');
const cancel = document.getElementById('passkeyCancel');
const choice = document.getElementById('passkeyChoice');
const pinForm = document.getElementById('pinForm');
const pinInput = document.getElementById('pinInput');
const pinConfirm = document.getElementById('pinConfirm');
const pinSubmit = document.getElementById('pinSubmit');
const usePinInstead = document.getElementById('usePinInstead');
const usePasskeyInstead = document.getElementById('usePasskeyInstead');
let mode = new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'authenticate';

function showPinForm() {
  choice.hidden = true;
  pinForm.hidden = false;
  pinConfirm.hidden = mode !== 'register';
  usePasskeyInstead.hidden = mode !== 'register';
  pinSubmit.textContent = mode === 'register' ? 'Save PIN and unlock' : 'Unlock';
  status.textContent = mode === 'register' ? 'Pick a PIN or passphrase (at least 4 characters). AuraBrowser cannot recover it if you forget it.' : 'Enter your vault PIN.';
  pinInput.focus();
}
function showPasskeyChoice() {
  pinForm.hidden = true;
  choice.hidden = false;
  usePinInstead.hidden = mode !== 'register';
  status.textContent = 'Your passwords stay on this device.';
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - String(value).length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function encodeBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function prepareOptions(options) {
  const prepared = { ...options, challenge: decodeBase64Url(options.challenge) };
  if (options.user) prepared.user = { ...options.user, id: decodeBase64Url(options.user.id) };
  for (const key of ['allowCredentials', 'excludeCredentials']) {
    if (Array.isArray(options[key])) prepared[key] = options[key].map((item) => ({ ...item, id: decodeBase64Url(item.id) }));
  }
  return prepared;
}
function credentialJson(credential, kind) {
  const response = credential.response;
  const json = {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || null,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: { clientDataJSON: encodeBase64Url(response.clientDataJSON) }
  };
  if (kind === 'register') {
    json.response.attestationObject = encodeBase64Url(response.attestationObject);
    json.response.transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
    if (typeof response.getPublicKey === 'function' && response.getPublicKey()) {
      json.response.publicKey = encodeBase64Url(response.getPublicKey());
      json.response.publicKeyAlgorithm = response.getPublicKeyAlgorithm();
    }
  } else {
    json.response.authenticatorData = encodeBase64Url(response.authenticatorData);
    json.response.signature = encodeBase64Url(response.signature);
    if (response.userHandle) json.response.userHandle = encodeBase64Url(response.userHandle);
  }
  return json;
}
proceed.addEventListener('click', async () => {
  if (!navigator.credentials || !window.PublicKeyCredential) {
    status.textContent = 'Passkeys are not available on this PC. Use a vault PIN instead.';
    if (mode === 'register') usePinInstead.hidden = false;
    return;
  }
  proceed.disabled = true;
  status.textContent = mode === 'register' ? 'Follow the Windows prompt to create your passkey…' : 'Follow the Windows prompt to verify it’s you…';
  try {
    const options = prepareOptions(await window.auraPasskey.getOptions(mode));
    const credential = mode === 'register'
      ? await navigator.credentials.create({ publicKey: options })
      : await navigator.credentials.get({ publicKey: options });
    if (!credential) throw new Error('The passkey operation was cancelled.');
    await window.auraPasskey.complete(mode, credentialJson(credential, mode));
    status.textContent = 'Verified. Returning to AuraBrowser…';
  } catch (error) {
    status.textContent = (error?.message || 'The passkey could not be verified.') + (mode === 'register' ? ' You can use a vault PIN instead.' : ' Try again.');
    proceed.disabled = false;
  }
});
pinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = pinInput.value;
  if (mode === 'register') {
    if (pin.length < 4) { status.textContent = 'Use at least 4 characters.'; return; }
    if (pin !== pinConfirm.value) { status.textContent = 'The two entries do not match.'; return; }
  }
  pinSubmit.disabled = true;
  try {
    if (mode === 'register') await window.auraPasskey.setupPin(pin);
    else await window.auraPasskey.verifyPin(pin);
    status.textContent = 'Verified. Returning to AuraBrowser…';
  } catch (error) {
    status.textContent = String(error?.message || 'Could not verify the PIN.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    pinInput.value = '';
    pinInput.focus();
    pinSubmit.disabled = false;
  }
});
usePinInstead.addEventListener('click', showPinForm);
usePasskeyInstead.addEventListener('click', showPasskeyChoice);
cancel.addEventListener('click', () => window.auraPasskey.cancel());

window.auraPasskey.info().then((info) => {
  mode = info.mode;
  if (mode === 'register') {
    title.textContent = 'Protect your saved passwords';
    description.textContent = 'Choose how AuraBrowser should check it’s you every time you open saved passwords.';
    proceed.textContent = 'Create a passkey';
    showPasskeyChoice();
  } else if (info.kind === 'pin') {
    title.textContent = 'Unlock saved passwords';
    description.textContent = 'Enter the vault PIN you set up.';
    showPinForm();
  } else {
    title.textContent = 'Unlock saved passwords';
    description.textContent = 'Confirm it’s you with the passkey you set up.';
    showPasskeyChoice();
  }
}).catch(() => { status.textContent = 'This request expired. Close this window and try again.'; });
