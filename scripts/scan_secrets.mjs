import fs from 'fs';
import path from 'path';

const IGNORED_DIRS = new Set(['node_modules', '.next', '.git']);
const IGNORED_FILES = new Set(['.env.local', 'scan_secrets.mjs']);
const UUID_REGEX = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

let foundSecrets = false;

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(process.cwd(), fullPath);

    if (entry.isDirectory()) {
      scanDir(fullPath);
    } else if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split(/\r?\n/);
        lines.forEach((line, idx) => {
          const lower = line.toLowerCase();
          const hasApiKeyParam = lower.includes('api-key=');
          const hasUuidKey = UUID_REGEX.test(line);

          if (hasApiKeyParam || hasUuidKey) {
            console.error(`Potential secret detected in ${relPath}:${idx + 1}`);
            foundSecrets = true;
          }
        });
      } catch (err) {
        // Skip binary or unreadable files
      }
    }
  }
}

scanDir(process.cwd());

if (foundSecrets) {
  console.error('FAIL: Potential secrets detected in repository files.');
  process.exit(1);
} else {
  console.log('PASS: No secrets detected.');
  process.exit(0);
}
