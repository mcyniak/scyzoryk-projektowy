import fs from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';

let projectRoot = process.cwd();

export function setProjectRoot(root) {
  projectRoot = root || process.cwd();
}

export function getProjectRoot() {
  return projectRoot;
}

export function getOutputRoot() {
  return path.join(projectRoot, 'output');
}

export function getDebugRoot(page = null, fallbackOutputRoot = null) {
  const root = fallbackOutputRoot || page?.__ecodanOutputRoot || getOutputRoot();
  return path.join(root, 'debug');
}

export async function saveDebug(page, prefix, details = '', extra = null, outputRoot = null) {
  const debugDir = getDebugRoot(page, outputRoot);
  await fs.mkdir(debugDir, { recursive: true }).catch(() => {});

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = sanitize(`${stamp}-${prefix}`);

  const screenshot = path.join(debugDir, `${base}.png`);
  const html = path.join(debugDir, `${base}.html`);
  const log = path.join(debugDir, `${base}.txt`);
  const json = path.join(debugDir, `${base}.json`);

  try {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: screenshot, fullPage: true });
    }
  } catch {}

  try {
    if (page && !page.isClosed()) {
      await fs.writeFile(html, await page.content(), 'utf8');
    }
  } catch {}

  try {
    const url = page && !page.isClosed() ? page.url() : 'PAGE_CLOSED';
    await fs.writeFile(log, `URL: ${url}\n\n${details}`, 'utf8');
  } catch {}

  try {
    if (extra !== null) {
      await fs.writeFile(json, JSON.stringify(extra, null, 2), 'utf8');
    }
  } catch {}

  return { screenshot, html, log, json };
}

export async function cleanupDebugArtifact(debug) {
  if (!debug || typeof debug !== 'object') return;
  const paths = [debug.screenshot, debug.html, debug.log, debug.json, debug.trace].filter(Boolean);
  for (const item of paths) {
    try { await fs.unlink(item); } catch {}
  }
}
