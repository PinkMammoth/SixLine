// Stand-in for `wine` when electron-builder builds the NSIS installer on Linux/WSL without Wine.
// electron-builder only runs one Windows program here: a helper installer whose sole job is to write the
// uninstaller. We extract that uninstaller with electron-builder's own pure-JS UninstallerReader instead
// of executing it (the same fallback electron-builder uses on macOS).
const path = require('node:path');
const [, , target, ...rest] = process.argv;
if (!target || rest.length || !/\.exe$/i.test(target)) {
  console.error(`wine-shim: unsupported invocation: ${process.argv.slice(2).join(' ')}`);
  process.exit(1);
}
const { UninstallerReader } = require(path.join(__dirname, '..', '..', 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'nsisUtil.js'));
const out = path.join(path.dirname(target), `${path.basename(target, 'exe')}__uninstaller.exe`);
UninstallerReader.exec(target, out).then(
  () => console.log(`wine-shim: extracted uninstaller -> ${path.basename(out)}`),
  (e) => {
    console.error(`wine-shim: ${e.message}`);
    process.exit(1);
  },
);
