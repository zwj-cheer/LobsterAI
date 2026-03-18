'use strict';

/**
 * Clean up unnecessary files from the OpenClaw runtime to reduce package size.
 *
 * Two strategies:
 * 1. Remove unnecessary files (.map, .d.ts, README, etc.) from all packages
 * 2. Replace large packages not needed at runtime with lightweight stubs
 *    (same approach as AutoClaw — import succeeds, actual calls throw in existing try-catch)
 */

const fs = require('fs');
const path = require('path');

// ─── Strategy 1: File cleanup patterns ───

const PATTERNS_TO_DELETE = [
  // Source maps
  /\.map$/i,
  // TypeScript declarations
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  // Documentation files
  /^readme(\.(md|txt|rst))?$/i,
  /^changelog(\.(md|txt|rst))?$/i,
  /^history(\.(md|txt|rst))?$/i,
  /^license(\.(md|txt))?$/i,
  /^licence(\.(md|txt))?$/i,
  /^authors(\.(md|txt))?$/i,
  /^contributors(\.(md|txt))?$/i,
  // Config files not needed at runtime
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^\.editorconfig$/i,
  /^\.npmignore$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^jest\.config/i,
  /^vitest\.config/i,
  /^\.babelrc/i,
  /^babel\.config/i,
  // Test files
  /\.test\.\w+$/i,
  /\.spec\.\w+$/i,
];

const DIRS_TO_DELETE = new Set([
  'docs',
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '.github',
  'example',
  'examples',
  'coverage',
]);

// ─── Strategy 2: Stub replacements ───
// Packages not needed in headless gateway mode, replaced with lightweight stubs.
// The stub allows require/import to succeed but throws when actually called.
// Callers already have try-catch protection.

const PACKAGES_TO_STUB = [
  'koffi',            // Windows FFI for terminal PTY — not needed in gateway mode
  'pdfjs-dist',       // Browser-side PDF rendering — gateway is a backend process
  'playwright-core',  // Browser automation — gateway doesn't launch browsers
];

const GENERIC_STUB_INDEX = `// Stub: this package is not needed for headless gateway operation.
// Import succeeds; actual calls throw (callers have try-catch protection).
module.exports = new Proxy({}, {
  get(_, prop) {
    if (prop === '__esModule') return false;
    if (prop === 'default') return module.exports;
    if (prop === 'then') return undefined;
    return function() {
      throw new Error(require('./package.json').name + ' is not available in this build');
    };
  }
});
`;

function stubPackage(pkgDir, pkgName, stats) {
  if (!fs.existsSync(pkgDir)) return;

  // Read original version for the stub package.json
  let version = '0.0.0-stub';
  try {
    const origPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    version = origPkg.version || version;
  } catch { /* ignore */ }

  // Remove all contents
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });

  // Write stub files
  fs.writeFileSync(path.join(pkgDir, 'index.js'), GENERIC_STUB_INDEX, 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: pkgName,
    version,
    main: 'index.js',
    type: 'commonjs',
  }, null, 2) + '\n', 'utf8');

  stats.stubbed.push(pkgName);
}

// ─── File cleanup ───

function shouldDeleteFile(filename) {
  return PATTERNS_TO_DELETE.some((pattern) => pattern.test(filename));
}

function cleanDir(dirPath, stats) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (DIRS_TO_DELETE.has(entry.name.toLowerCase())) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        stats.dirsRemoved++;
        continue;
      }
      cleanDir(fullPath, stats);
      // Remove empty directories
      try {
        const remaining = fs.readdirSync(fullPath);
        if (remaining.length === 0) {
          fs.rmdirSync(fullPath);
        }
      } catch { /* ignore */ }
    } else if (entry.isFile() && shouldDeleteFile(entry.name)) {
      try {
        const size = fs.statSync(fullPath).size;
        fs.unlinkSync(fullPath);
        stats.filesRemoved++;
        stats.bytesFreed += size;
      } catch { /* ignore */ }
    }
  }
}

// ─── Main ───

function main() {
  const runtimeRoot = process.argv[2]
    || path.join(__dirname, '..', 'vendor', 'openclaw-runtime', 'current');

  if (!fs.existsSync(runtimeRoot)) {
    console.error(`[prune-openclaw-runtime] Runtime root not found: ${runtimeRoot}`);
    process.exit(1);
  }

  const nodeModulesDir = path.join(runtimeRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    console.log('[prune-openclaw-runtime] No node_modules found, skipping.');
    return;
  }

  console.log(`[prune-openclaw-runtime] Cleaning ${runtimeRoot} ...`);

  const stats = { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0, stubbed: [] };

  // Step 1: Replace large unnecessary packages with stubs
  for (const pkgName of PACKAGES_TO_STUB) {
    stubPackage(path.join(nodeModulesDir, pkgName), pkgName, stats);
  }

  // Step 2: Clean unnecessary files from node_modules only (not extensions)
  cleanDir(nodeModulesDir, stats);

  const mbFreed = (stats.bytesFreed / 1024 / 1024).toFixed(1);
  console.log(
    `[prune-openclaw-runtime] Stubbed: ${stats.stubbed.length > 0 ? stats.stubbed.join(', ') : 'none'}`
  );
  console.log(
    `[prune-openclaw-runtime] Removed ${stats.filesRemoved} files, ${stats.dirsRemoved} dirs, freed ${mbFreed} MB`
  );
}

main();
