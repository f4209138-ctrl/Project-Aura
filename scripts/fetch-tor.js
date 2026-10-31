const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const openpgp = require('openpgp');
const tar = require('tar');

const TOR_VERSION = '15.0.26';
const TOR_SIGNING_FINGERPRINT = 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290';
const TOR_SIGNING_KEY_URL = 'https://keys.openpgp.org/vks/v1/by-fingerprint/' + TOR_SIGNING_FINGERPRINT;

function getTarget() {
  const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (!platform || !arch || (platform === 'windows' && arch !== 'x86_64') || (platform === 'linux' && arch !== 'x86_64')) {
    throw new Error('Tor Expert Bundle is not published for this build target: ' + process.platform + '/' + process.arch);
  }
  return { platform, arch, name: platform + '-' + arch };
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error('Download failed (' + response.status + '): ' + url);
  await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(destination, { flags: 'wx' }));
}

function containsRequiredFiles(root, binaryName) {
  if (!fsSync.existsSync(root)) return false;
  const found = new Set();
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile()) found.add(entry.name.toLowerCase());
    }
  }
  return found.has(binaryName.toLowerCase()) && found.has('geoip') && found.has('geoip6');
}

function removeTemporaryDirectory(directory) {
  if (!directory) return Promise.resolve();
  const base = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a temporary directory outside the temporary folder.');
  }
  return fs.rm(resolved, { recursive: true, force: true });
}

async function fetchTor() {
  const target = getTarget();
  const projectRoot = path.resolve(__dirname, '..');
  const targetDirectory = path.join(projectRoot, 'vendor', 'tor', target.name);
  const binaryName = process.platform === 'win32' ? 'tor.exe' : 'tor';
  const versionMarker = path.join(targetDirectory, '.verified-tor-version');
  if (fsSync.existsSync(versionMarker) && fsSync.readFileSync(versionMarker, 'utf8').trim() === TOR_VERSION && containsRequiredFiles(targetDirectory, binaryName)) {
    console.log('Using cached Tor Expert Bundle ' + TOR_VERSION + ' for ' + target.name + '.');
    return targetDirectory;
  }
  const fileName = 'tor-expert-bundle-' + target.name + '-' + TOR_VERSION + '.tar.gz';
  const baseUrl = 'https://dist.torproject.org/torbrowser/' + TOR_VERSION + '/' + fileName;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aurabrowser-tor-'));
  try {
    const archivePath = path.join(tempDirectory, fileName);
    const signaturePath = archivePath + '.asc';
    await Promise.all([download(baseUrl, archivePath), download(baseUrl + '.asc', signaturePath)]);

    const keyResponse = await fetch(TOR_SIGNING_KEY_URL, { redirect: 'follow' });
    if (!keyResponse.ok) throw new Error('Could not download the pinned Tor signing key.');
    const publicKey = await openpgp.readKey({ armoredKey: await keyResponse.text() });
    if (publicKey.getFingerprint().toUpperCase() !== TOR_SIGNING_FINGERPRINT) {
      throw new Error('Tor signing key fingerprint did not match the pinned fingerprint.');
    }
    const signature = await openpgp.readSignature({ armoredSignature: await fs.readFile(signaturePath, 'utf8') });
    const message = await openpgp.createMessage({ binary: new Uint8Array(await fs.readFile(archivePath)) });
    const verification = await openpgp.verify({ message, signature, verificationKeys: publicKey });
    if (!verification.signatures.length) throw new Error('The Tor archive has no signature from the pinned key.');
    await verification.signatures[0].verified;

    await fs.mkdir(targetDirectory, { recursive: true });
    await tar.x({
      file: archivePath,
      cwd: targetDirectory,
      strict: true,
      filter: (entryPath) => !path.isAbsolute(entryPath) && !entryPath.split(/[\\/]/).includes('..')
    });

    const stack = [targetDirectory];
    let binaryFound = false;
    let geoipFound = false;
    let geoip6Found = false;
    while (stack.length) {
      const current = stack.pop();
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        if (entry.isFile()) {
          if (entry.name.toLowerCase() === binaryName) binaryFound = true;
          if (entry.name.toLowerCase() === 'geoip') geoipFound = true;
          if (entry.name.toLowerCase() === 'geoip6') geoip6Found = true;
        }
      }
    }
    if (!binaryFound || !geoipFound || !geoip6Found) {
      throw new Error('The verified Tor archive did not contain the daemon and GeoIP data files.');
    }
    fsSync.writeFileSync(versionMarker, TOR_VERSION + '\n', 'utf8');
    console.log('Verified and extracted Tor Expert Bundle ' + TOR_VERSION + ' for ' + target.name + '.');
    return targetDirectory;
  } finally {
    await removeTemporaryDirectory(tempDirectory);
  }
}

if (require.main === module) {
  fetchTor().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = fetchTor;