// electron-builder configuration for SixLine. `npm run dist` builds Windows x64 installer + portable exe.
const path = require('node:path');
const onWindows = process.platform === 'win32';

// Building on Linux/WSL without Wine: scripts/wine-shim/wine extracts the NSIS uninstaller in JS.
if (!onWindows) process.env.PATH = `${path.join(__dirname, 'scripts', 'wine-shim')}${path.delimiter}${process.env.PATH}`;

module.exports = {
  appId: 'app.sixline.desktop',
  productName: 'SixLine',
  copyright: 'Copyright © 2026 SixLine',
  directories: { output: 'release/${version}', buildResources: 'build' },
  // Everything the app needs at runtime is in dist/ (Vite bundles alphaTab, fonts, SoundFont, workers)
  // plus the Electron main/preload. No node_modules are needed at runtime.
  files: ['dist/**/*', '!dist/**/*.map', 'electron/**/*', 'build/icon.png', 'package.json'],
  asar: true,
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'build/icon.ico',
    // on Windows electron-builder edits the exe itself; on WSL scripts/after-pack.cjs does it
    signAndEditExecutable: onWindows,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false, // asked for in build/installer.nsh
    createStartMenuShortcut: true,
    shortcutName: 'SixLine',
    uninstallDisplayName: 'SixLine ${version}',
    artifactName: 'SixLine-Setup-${version}.${ext}',
    include: 'build/installer.nsh',
  },
  portable: { artifactName: 'SixLine-${version}-portable.${ext}' },
  fileAssociations: [{ ext: 'tabproj', name: 'SixLine Project', description: 'SixLine project', role: 'Editor', icon: 'build/icon.ico' }],
  afterPack: './scripts/after-pack.cjs',
  publish: null, // no auto-update feed: SixLine never goes online
};
