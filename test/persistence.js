// Data survives restarts in SQLite, and an old config.json is imported once.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); };

// Runs a snippet against config.js in a fresh process (a "restart") and returns its JSON output.
function run(dataDir, code) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    `const c = await import(${JSON.stringify(join(here, '..', 'src', 'config.js'))}); const out = await (async () => { ${code} })(); console.log('@@' + JSON.stringify(out));`],
  { env: { ...process.env, DATA_DIR: dataDir, FIGMA_TOKEN: '', FIGMA_FILE_KEY: '' }, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  return JSON.parse(r.stdout.split('@@')[1]);
}

const dir = mkdtempSync(join(tmpdir(), 'persist-'));
const first = run(dir, `
  const i = c.addIntegration({ name: 'Marketing', type: 'figma', token: 'figd_secret9999' });
  const p = c.addProject({ name: 'Spring', integrationId: i.id, source: 'ABC' });
  c.updateProject(p.id, { name: 'Spring 2' });
  c.updateProject('static', { name: 'Demo' });
  const k = c.createApiKey('n8n');
  c.setDefaultProject(p.id);
  return { key: k.key, integration: i.id, project: p.id };`);
assert(existsSync(join(dir, 'creatives.db')), 'data is stored in creatives.db');

const second = run(dir, `
  const cfg = c.publicConfig();
  return { cfg, token: c.getIntegration(${JSON.stringify(first.integration)})?.token, keyOk: c.verifyApiKey(${JSON.stringify(first.key)}), badKey: c.verifyApiKey('fr_nope') };`);
assert(second.cfg.integrations.some((i) => i.name === 'Marketing') && second.token === 'figd_secret9999', 'integrations and their credentials survive a restart');
assert(second.cfg.projects.some((p) => p.name === 'Spring 2' && p.source === 'ABC') && second.cfg.defaultProjectId === first.project, 'projects, renames and the default survive a restart');
assert(second.cfg.projects.some((p) => p.id === 'static' && p.name === 'Demo'), 'renamed built-in projects survive a restart');
assert(second.keyOk && !second.badKey, 'API keys (stored as hashes) still verify after a restart');

// An old config.json is imported once and kept as a backup.
const legacy = mkdtempSync(join(tmpdir(), 'legacy-'));
writeFileSync(join(legacy, 'config.json'), JSON.stringify({
  integrations: [{ id: 'f1', name: 'Old Figma', type: 'figma', token: 'figd_old1234' }],
  projects: [{ id: 'p1', name: 'Old project', integrationId: 'f1', fileKey: 'KEY' }],
  defaultProjectId: 'p1', apiKeys: [],
}));
const imported = run(legacy, `return c.publicConfig();`);
assert(imported.integrations.some((i) => i.name === 'Old Figma') && imported.projects.some((p) => p.name === 'Old project' && p.source === 'KEY'), 'an existing config.json is imported (fileKey becomes source)');
assert(existsSync(join(legacy, 'config.json.migrated')) && !existsSync(join(legacy, 'config.json')), 'the old file is set aside as config.json.migrated');
const again = run(legacy, `return c.publicConfig().projects.filter((p) => p.id === 'p1').length;`);
assert(again === 1, 'the import does not run twice');
process.exit(0);
