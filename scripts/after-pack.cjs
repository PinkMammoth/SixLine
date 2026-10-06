// electron-builder afterPack hook: stamp icon + version info into SixLine.exe.
// On Windows electron-builder does this itself. On Linux it would need Wine; under WSL we instead run
// rcedit's Windows binary natively through WSL interop.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32' || process.platform === 'win32') return;
  let isWsl = false;
  try {
    isWsl = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {}
  if (!isWsl) throw new Error('Building the Windows app on Linux needs WSL (for rcedit) or a Windows machine.');
  const toWin = (p) => execFileSync('wslpath', ['-w', p]).toString().trim();
  const rcedit = path.join(ctx.packager.projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  fs.chmodSync(rcedit, 0o755);
  const info = ctx.packager.appInfo;
  const exe = path.join(ctx.appOutDir, `${info.productFilename}.exe`);
  const version = info.version;
  execFileSync(rcedit, [
    toWin(exe),
    '--set-icon', toWin(path.join(ctx.packager.projectDir, 'build', 'icon.ico')),
    '--set-file-version', version,
    '--set-product-version', version,
    '--set-version-string', 'ProductName', info.productName,
    '--set-version-string', 'FileDescription', info.productName,
    '--set-version-string', 'CompanyName', info.companyName || info.productName,
    '--set-version-string', 'LegalCopyright', info.copyright,
    '--set-version-string', 'InternalName', info.productFilename,
    '--set-version-string', 'OriginalFilename', `${info.productFilename}.exe`,
  ], { stdio: 'inherit' });
  console.log(`  • stamped icon and version ${version} into ${path.basename(exe)} (rcedit via WSL interop)`);
};
