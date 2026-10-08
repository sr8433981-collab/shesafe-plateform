#!/usr/bin/env node
/**
 * SheSafe — legacy launcher (DEPRECATED).
 *
 * This file used to be a second, independent implementation of the SheSafe API
 * in Node.js. It was a byte-for-byte duplicate of the Python Flask backend,
 * including every one of its security defects, and the two implementations had
 * already drifted apart. Maintaining two copies of emergency logic is a safety
 * hazard, so the Node implementation has been removed and the Flask API is now
 * the single source of truth.
 *
 * This launcher exists for one reason only: `npm start` keeps working for anyone
 * who followed the old instructions. It does not serve anything itself — it
 * hands over to the Flask application and exits non-zero if that is not possible.
 *
 *     node backend/server.js          # delegates to backend/wsgi.py
 *
 * The application lives in:
 *   backend/app/     Flask application package
 *   backend/wsgi.py  entrypoint
 *   backend/tests/   pytest suite
 */

'use strict';

// CommonJS: this file is intentionally `.js` under a `"type": "module"` package,
// so Node needs the explicit extension to treat it as a CommonJS script.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const WSGI = path.join(REPO_ROOT, 'backend', 'wsgi.py');

function findPython() {
  if (fs.existsSync(path.join(REPO_ROOT, '.venv', 'bin', 'python3'))) {
    return path.join(REPO_ROOT, '.venv', 'bin', 'python3');
  }
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function main() {
  if (!fs.existsSync(WSGI)) {
    console.error('backend/wsgi.py is missing. The repository is incomplete.');
    process.exit(1);
  }

  const python = findPython();
  if (!python) {
    console.error(
      [
        '',
        '  SheSafe now runs on the Flask API (backend/wsgi.py).',
        '  Python 3.10+ was not found on this machine.',
        '',
        '  Install Python, then run:',
        '      python3 -m venv .venv',
        '      .venv/bin/pip install -r backend/requirements.txt',
        '      python3 backend/wsgi.py',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log('\n  SheSafe — delegating to the Flask API (backend/wsgi.py).');
  console.log('  The standalone Node.js API has been removed as a duplicate implementation.\n');

  const child = spawn(python, [WSGI], { cwd: REPO_ROOT, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (error) => {
    console.error('Failed to start the Flask API:', error.message);
    process.exit(1);
  });
}

main();