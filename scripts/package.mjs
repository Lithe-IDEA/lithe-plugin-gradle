#!/usr/bin/env node
// Packages the plugin into dist/<name>-<version>-darwin.zip, the asset name
// Lithe Store's release tracker recognizes (docs/publishing.md there).
//
// The package is plain data: plugin.json, icons, and the init script that
// runs inside the user's own Gradle, so one archive serves every Mac. The
// unpacked package stays in dist/package/ for installing a local
// development copy into Lithe.
//
// Usage: node scripts/package.mjs [--expect-tag <tag>]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_DIR = "io.github.lithe-idea.gradle-build";
const ASSET_PREFIX = "gradle-build";
const PLATFORM = "darwin";
const PACKAGE_ROOT = join("dist", "package");

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

rmSync("dist", { recursive: true, force: true });
const packageRoot = join(PACKAGE_ROOT, PACKAGE_DIR);
cpSync(PACKAGE_DIR, packageRoot, { recursive: true });
cpSync("LICENSE", join(packageRoot, "LICENSE"));
cpSync("NOTICE", join(packageRoot, "NOTICE"));
assertNoLinks(packageRoot);

const asset = resolve("dist", `${ASSET_PREFIX}-${manifest.version}-${PLATFORM}.zip`);
// -X drops extra file attributes; -y stores a symbolic link as a link so
// Lithe refuses it instead of the archive silently carrying its target.
execFileSync("zip", ["-qrXy", asset, PACKAGE_DIR, "-x", "*.DS_Store"], { cwd: PACKAGE_ROOT });
console.log(`dist/${ASSET_PREFIX}-${manifest.version}-${PLATFORM}.zip ${sha256(asset)}`);
