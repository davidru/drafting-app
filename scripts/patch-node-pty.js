/**
 * Patches node-pty's binding.gyp and winpty.gyp to disable Spectre mitigation.
 * This avoids requiring the Spectre-mitigated MSVC libraries that most dev
 * environments don't have installed.
 * Runs as postinstall script.
 */
const fs = require('fs');
const path = require('path');

const filesToPatch = [
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'binding.gyp'),
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp'),
];

let patchCount = 0;

for (const file of filesToPatch) {
  if (!fs.existsSync(file)) continue;

  let content = fs.readFileSync(file, 'utf-8');
  if (content.includes("'SpectreMitigation': 'Spectre'")) {
    content = content.replace(/'SpectreMitigation': 'Spectre'/g, "'SpectreMitigation': 'false'");
    fs.writeFileSync(file, content, 'utf-8');
    patchCount++;
    console.log(`Patched Spectre mitigation in ${path.basename(file)}`);
  }
}

if (patchCount > 0) {
  // Clean build directory to force regeneration
  const buildDir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'build');
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    console.log('Cleaned node-pty build directory');
  }
}

console.log(`node-pty Spectre patch: ${patchCount} file(s) patched`);
