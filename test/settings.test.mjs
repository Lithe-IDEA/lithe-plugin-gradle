import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseProperties, registerSettingsFunction, settingsFor } from '../io.github.lithe-idea.gradle-build/backend/settings.mjs';

class PluginError extends Error { constructor(code, message) { super(message); this.code = code; } }

async function scratch(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lithe-gradle-settings-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function handlerFor(folders, environment = {}) {
  let handler;
  registerSettingsFunction({ function: (id, fn) => { assert.equal(id, 'languageImport.settings'); handler = fn; } }, PluginError, environment);
  const context = { throwIfCancelled() {}, workspaceContext: { contextID: 'c', generation: 1 }, host: { workspace: { getFolders: async () => ({ folders }) } } };
  return (params, overrides = {}) => handler(params, { ...context, ...overrides });
}

test('properties parser keeps escapes and ignores comments', () => {
  assert.deepEqual(parseProperties('# c\n! c\norg.gradle.jvmargs=-Xmx2g \\\n  -Dfile.encoding=UTF-8\nkey : v\\:x\n'),
    { 'org.gradle.jvmargs': '-Xmx2g -Dfile.encoding=UTF-8', key: 'v:x' });
});

test('project gradle.properties overrides the user home and only known keys are exported', async (t) => {
  const root = await scratch(t), home = await scratch(t);
  await writeFile(join(home, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx1g\norg.gradle.java.home=/jdk/home\norg.gradle.parallel=true\n');
  await writeFile(join(root, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx4g\norg.gradle.java.home=relative/jdk\n');
  assert.deepEqual(await settingsFor(root, { GRADLE_USER_HOME: home }), {
    settings: { 'java.import.gradle.user.home': home, 'java.import.gradle.jvmArguments': '-Xmx4g' }
  });
  assert.deepEqual(await settingsFor(root, { GRADLE_USER_HOME: 'relative' }), { settings: { 'java.import.gradle.jvmArguments': '-Xmx4g' } });
});

test('the function answers only for roots inside an open workspace folder', async (t) => {
  const workspace = await scratch(t), outside = await scratch(t);
  await mkdir(join(workspace, 'app'));
  await symlink(outside, join(workspace, 'escape'));
  await writeFile(join(workspace, 'app', 'gradle.properties'), 'org.gradle.jvmargs=-Xmx3g\n');
  const call = handlerFor([{ rootID: 'r', name: 'w', path: workspace }], { GRADLE_USER_HOME: '/nonexistent-lithe-home' });
  assert.deepEqual(await call({ workspaceRoot: join(workspace, 'app') }), {
    settings: { 'java.import.gradle.user.home': '/nonexistent-lithe-home', 'java.import.gradle.jvmArguments': '-Xmx3g' }
  });
  for (const workspaceRoot of [outside, join(workspace, 'escape'), 'relative', undefined]) {
    await assert.rejects(call({ workspaceRoot }), { code: 'gradle.invalidRoot' });
  }
  await assert.rejects(call({ workspaceRoot: workspace }, { workspaceContext: null }), { code: 'gradle.noWorkspaceContext' });
});

test('the vendored SDK matches sdk.lock.json', async () => {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const lock = JSON.parse(await readFile(new URL('../sdk.lock.json', import.meta.url), 'utf8'));
  assert.ok(lock.files.length > 0);
  for (const file of lock.files) {
    const bytes = await readFile(new URL(`../${file.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
  }
});
