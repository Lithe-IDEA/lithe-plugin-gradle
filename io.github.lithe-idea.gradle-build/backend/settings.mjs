// `languageImport.settings` of the Gradle plugin: the JDT LS import settings
// that Gradle's own configuration files imply. Nothing here runs Gradle,
// writes a file or reads a path outside the workspace and the user's Gradle
// home. Ownership and lifecycle: README.md ("Java 语言服务器的导入设置").
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_PROPERTIES_BYTES = 256 * 1024;

const inside = (root, path) => {
  const value = relative(root, path);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
};

/** Reads `key=value` pairs of a Java properties file; later lines win. */
export function parseProperties(text) {
  const result = {};
  for (const raw of text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/)) {
    const line = raw.trimStart();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const match = /^((?:\\.|[^\s:=\\])+)\s*[:=]?\s*(.*)$/.exec(line);
    if (!match) continue;
    const unescape = (value) => value.replace(/\\(.)/g, '$1');
    result[unescape(match[1])] = unescape(match[2].trimEnd());
  }
  return result;
}

async function properties(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > MAX_PROPERTIES_BYTES ? {} : parseProperties(text);
  } catch {
    return {};
  }
}

/** The Gradle user home as Gradle resolves it without a command line. */
export function gradleUserHome(environment) {
  const value = environment.GRADLE_USER_HOME;
  return typeof value === 'string' && isAbsolute(value) ? value : join(homedir(), '.gradle');
}

/**
 * Settings for the Gradle build at `root`. `gradle.properties` of the project
 * wins over the one in the Gradle user home, as in Gradle itself.
 */
export async function settingsFor(root, environment = process.env) {
  const home = gradleUserHome(environment);
  const merged = { ...(await properties(join(home, 'gradle.properties'))), ...(await properties(join(root, 'gradle.properties'))) };
  const settings = {};
  if (typeof environment.GRADLE_USER_HOME === 'string' && isAbsolute(environment.GRADLE_USER_HOME)) {
    settings['java.import.gradle.user.home'] = home;
  }
  const javaHome = merged['org.gradle.java.home'];
  if (javaHome && isAbsolute(javaHome)) settings['java.import.gradle.java.home'] = javaHome;
  const jvmArguments = merged['org.gradle.jvmargs'];
  if (jvmArguments) settings['java.import.gradle.jvmArguments'] = jvmArguments;
  return { settings };
}

/** The function handler: only roots inside an open local workspace are read. */
export function registerSettingsFunction(backend, PluginError, environment = process.env) {
  backend.function('languageImport.settings', async (params, context) => {
    context.throwIfCancelled();
    const requested = params?.workspaceRoot;
    if (typeof requested !== 'string' || !isAbsolute(requested)) {
      throw new PluginError('gradle.invalidRoot', 'workspaceRoot must be an absolute path.');
    }
    if (!context.workspaceContext) throw new PluginError('gradle.noWorkspaceContext', 'The call carries no workspace context.');
    let root;
    try {
      root = await realpath(resolve(requested));
      const { folders = [] } = await context.host.workspace.getFolders(context.workspaceContext);
      const allowed = [];
      for (const folder of folders) if (typeof folder.path === 'string') allowed.push(await realpath(folder.path).catch(() => null));
      if (!allowed.some((folder) => folder && inside(folder, root))) throw new Error('outside');
    } catch {
      throw new PluginError('gradle.invalidRoot', 'workspaceRoot is not inside an open workspace folder.');
    }
    context.throwIfCancelled();
    return settingsFor(root, environment);
  });
}
