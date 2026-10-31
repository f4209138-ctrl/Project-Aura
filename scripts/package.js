const path = require('node:path');
const fs = require('node:fs');
const { build, Platform } = require('electron-builder');
const fetchTor = require('./fetch-tor');

async function main() {
  const cachedNsisDirectory = path.join(__dirname, '..', 'electron-builder-cache', 'nsis@1.2.1', 'nsis-bundle-3.12-wfwns', 'windows');
  if (!process.env.ELECTRON_BUILDER_NSIS_DIR && fs.existsSync(path.join(cachedNsisDirectory, 'Bin', 'makensis.exe'))) {
    process.env.ELECTRON_BUILDER_NSIS_DIR = cachedNsisDirectory;
  }
  const torDirectory = await fetchTor();
  const platform = process.platform === 'win32'
    ? Platform.WINDOWS
    : (process.platform === 'darwin' ? Platform.MAC : Platform.LINUX);
  const directoryOnly = process.argv.includes('--dir') || process.env.AURA_DIR_ONLY === '1';
  const targets = directoryOnly ? platform.createTarget('dir') : platform.createTarget();
  await build({
    targets,
    config: {
      appId: 'com.aurabrowser.desktop',
      productName: 'AuraBrowser',
      electronDist: path.join(__dirname, '..', 'node_modules', 'electron', 'dist'),
      toolsets: { nsis: '1.2.1' },
      directories: { output: 'release' },
      files: ['src/**/*', 'package.json'],
      extraResources: [{ from: torDirectory, to: 'tor' }],
      // Security: block running the app as plain Node, code injection via env vars/inspector, and tampering with app files.
      electronFuses: {
        runAsNode: false,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true
      },
      win: { target: ['nsis'], icon: path.join(__dirname, '..', 'src', 'assets', 'aurabrowser.ico') },
      nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'AuraBrowser', packElevateHelper: false },
      mac: { target: ['dmg'] },
      linux: { target: ['AppImage'] }
    }
  });
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});