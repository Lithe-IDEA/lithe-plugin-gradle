#!/usr/bin/env node
// Packages one portable plugin archive with macOS and Windows asset names
// recognized by Lithe Store (docs/publishing.md there).
//
// The package is plain data: plugin.json, icons, New Project templates, and
// the init script that runs inside the user's own Gradle, and the Java backend
// jar (lib/lithe-gradle-backend.jar), so the bytes are shared across platforms. The
// unpacked package stays in dist/package/ for installing a local
// development copy into Lithe.
//
// Usage: node scripts/package.mjs [--expect-tag <tag>]

import { execFileSync } from "node:child_process";
import { verifySdk } from "./sdk/verify-sdk.mjs";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const PACKAGE_DIR = "io.github.lithe-idea.gradle-build";
const ASSET_PREFIX = "gradle-build";
const PLATFORM = "darwin";
const PACKAGE_ROOT = join("dist", "package");

/**
 * Why `path` is not an existing `kind` ("icon file" or "template directory")
 * inside the plugin package, or undefined when it is one. Absolute paths and
 * `..` segments are refused because the package is copied and zipped as is.
 */
function packageEntryProblem(path, kind) {
  if (typeof path !== "string" || path === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    return `${kind} ${path} must be a relative path inside the package`;
  }
  const stat = statSync(join(PACKAGE_DIR, path), { throwIfNoEntry: false });
  const found = kind === "template directory" ? stat?.isDirectory() : stat?.isFile();
  return found ? undefined : `missing ${kind} ${path}`;
}

const manifest = JSON.parse(readFileSync(`${PACKAGE_DIR}/plugin.json`, "utf8"));
const problems = [];
if (manifest.id !== PACKAGE_DIR) problems.push(`plugin.json id ${manifest.id} must equal the directory ${PACKAGE_DIR}`);
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version)) problems.push(`version ${manifest.version} is not MAJOR.MINOR.PATCH`);
if (manifest.vendor?.signatureRequirement !== "none") problems.push('vendor.signatureRequirement must be "none"');
if (manifest.id === "dev.lithe" || manifest.id.startsWith("dev.lithe.")) problems.push("dev.lithe.* is reserved for official plugins");

const tagFlag = process.argv.indexOf("--expect-tag");
if (tagFlag >= 0) {
  const tag = process.argv[tagFlag + 1];
  if (tag !== `v${manifest.version}`) problems.push(`tag ${tag} does not match plugin.json version ${manifest.version} (expected v${manifest.version})`);
}

// New Project entries point at icons and template directories by path; a typo
// there would only surface when a user opens the New Project window.
for (const generator of manifest.projectGenerators ?? []) {
  const entries = [];
  if (generator.icon?.path !== undefined) entries.push(["icon file", generator.icon.path]);
  if (generator.icon?.darkPath !== undefined) entries.push(["icon file", generator.icon.darkPath]);
  for (const step of generator.steps ?? []) {
    if (step.source !== undefined) entries.push(["template directory", step.source]);
  }
  for (const [kind, path] of entries) {
    const problem = packageEntryProblem(path, kind);
    if (problem !== undefined) problems.push(`generator ${generator.id}: ${problem}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Lithe refuses packages with symbolic links, so refuse them before zipping. */
function assertNoLinks(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
    if (stat.isDirectory()) assertNoLinks(path);
  }
}

// The backend (backend/) and the vendored official Java SDK (vendor/, pinned by
// sdk.lock.json) are compiled together for Java 8 with the JDK's own javac and
// jar, so building needs no Maven. A fixed timestamp makes the jar reproducible.
await verifySdk();
const BACKEND_BUILD = join("backend", "target");
const BACKEND_JAR = join(BACKEND_BUILD, "lithe-gradle-backend.jar");
function sourcesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourcesUnder(path) : entry.name.endsWith(".java") ? [path] : [];
  });
}
rmSync(BACKEND_BUILD, { recursive: true, force: true });
mkdirSync(join(BACKEND_BUILD, "classes"), { recursive: true });
const javaSources = [...sourcesUnder("backend/src/main/java"), ...sourcesUnder("vendor/lithe-plugin-sdk-java/src/main/java")];
execFileSync("javac", ["-encoding", "UTF-8", "--release", "8", "-Xlint:-options", "-d", join(BACKEND_BUILD, "classes"), ...javaSources], { stdio: "inherit", timeout: 120_000 });
writeFileSync(join(BACKEND_BUILD, "MANIFEST.MF"), `Main-Class: io.github.litheidea.gradle.backend.GradleBackend\nImplementation-Version: ${manifest.version}\n`);
execFileSync("jar", ["--create", "--file", BACKEND_JAR, "--manifest", join(BACKEND_BUILD, "MANIFEST.MF"), "--date", "2026-10-20T00:00:00Z", "-C", join(BACKEND_BUILD, "classes"), "."], { stdio: "inherit", timeout: 60_000 });
if (!existsSync(BACKEND_JAR)) throw new Error(`${BACKEND_JAR} was not built`);

rmSync("dist", { recursive: true, force: true });
const packageRoot = join(PACKAGE_ROOT, PACKAGE_DIR);
cpSync(PACKAGE_DIR, packageRoot, { recursive: true });
mkdirSync(join(packageRoot, "lib"), { recursive: true });
cpSync(BACKEND_JAR, join(packageRoot, "lib", "lithe-gradle-backend.jar"));
cpSync("vendor/LICENSE", join(packageRoot, "SDK-LICENSE"));
cpSync("LICENSE", join(packageRoot, "LICENSE"));
cpSync("NOTICE", join(packageRoot, "NOTICE"));
assertNoLinks(packageRoot);

const asset = resolve("dist", `${ASSET_PREFIX}-${manifest.version}-${PLATFORM}.zip`);
// -X drops extra file attributes; -y stores a symbolic link as a link so
// Lithe refuses it instead of the archive silently carrying its target.
execFileSync("zip", ["-qrXy", asset, PACKAGE_DIR, "-x", "*.DS_Store"], { cwd: PACKAGE_ROOT, timeout: 30_000 });
console.log(`dist/${ASSET_PREFIX}-${manifest.version}-${PLATFORM}.zip ${sha256(asset)}`);
// The package contains no native binaries; advertise the same verified bytes
// under a Windows name so installers can select it without filename guessing.
const windowsAsset = resolve("dist", `${ASSET_PREFIX}-${manifest.version}-windows.zip`);
cpSync(asset, windowsAsset);
console.log(`dist/${ASSET_PREFIX}-${manifest.version}-windows.zip ${sha256(windowsAsset)}`);
