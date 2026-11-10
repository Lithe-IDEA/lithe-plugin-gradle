#!/usr/bin/env node
// Drives lib/lithe-gradle-backend.jar from dist/package over its stdio, as
// Lithe does: `languageImport.settings` for roots inside and outside an open
// workspace folder. No Gradle or network is needed.
//
// Run scripts/package.mjs first. LITHE_TEST_JAVA selects the Java that runs the
// backend (default `java`), so CI also checks Java 8.
//
// Usage: node scripts/test-backend.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackendClient, bounded } from "./backend-client.mjs";

const jar = resolve("dist", "package", "io.github.lithe-idea.gradle-build", "lib", "lithe-gradle-backend.jar");
if (!existsSync(jar)) {
  console.error("✗ dist/package is missing the backend; run node scripts/package.mjs first");
  process.exit(1);
}
const java = process.env.LITHE_TEST_JAVA ?? "java";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lithe-gradle-backend-test-")));
const workspace = join(scratch, "workspace");
const outside = join(scratch, "outside");
const gradleHome = join(scratch, "gradle-home");
const home = join(scratch, "home");
for (const directory of [join(workspace, "app"), outside, gradleHome, home]) mkdirSync(directory, { recursive: true });
writeFileSync(join(gradleHome, "gradle.properties"), "org.gradle.jvmargs=-Xmx1g\norg.gradle.java.home=/jdk/home\norg.gradle.parallel=true\n");
writeFileSync(join(workspace, "app", "gradle.properties"), "org.gradle.jvmargs=-Xmx4g \\\n  -Dfile.encoding=UTF-8\norg.gradle.java.home=relative/jdk\n");
symlinkSync(outside, join(workspace, "escape"));

let client;
let failed = false;
const step = async (name, body) => {
  try { await body(); console.log(`✓ ${name}`); }
  catch (error) { failed = true; console.error(`✗ ${name}\n${error.stack}`); }
};
try {
  client = new BackendClient({
    java, jar, args: [], javaOptions: [`-Duser.home=${home}`],
    env: { ...process.env, GRADLE_USER_HOME: gradleHome },
    hostRequests: { "lithe/host/workspace/getFolders": () => ({ folders: [{ rootID: "r", name: "w", path: workspace }] }) },
  });
  const initialized = await client.initialize(workspace, { functions: true });
  assert.deepEqual(initialized.capabilities.experimental.litheFunctions.functions, [{ id: "languageImport.settings" }]);
  const invoke = (workspaceRoot, context = { contextID: "ctx", generation: 1 }) => client.send("lithe/function/invoke", {
    functionID: "languageImport.settings", operationID: `op-${Math.random()}`, params: { workspaceRoot }, ...(context ? { context } : {}),
  }).response;

  await step("the project's gradle.properties overrides the Gradle user home and only known keys are exported", async () => {
    assert.deepEqual((await invoke(join(workspace, "app"))).result, { settings: {
      "java.import.gradle.user.home": gradleHome,
      "java.import.gradle.jvmArguments": "-Xmx4g -Dfile.encoding=UTF-8",
    } });
  });
  await step("a root outside the open workspace folders, through a link, relative or without a context is refused", async () => {
    for (const root of [outside, join(workspace, "escape"), "relative"]) {
      assert.equal((await invoke(root)).error?.data?.code, "gradle.invalidRoot", root);
    }
    assert.equal((await invoke(workspace, null)).error?.data?.code, "gradle.noWorkspaceContext");
  });
  await step("the backend exits on shutdown", async () => {
    assert.equal(await client.close(), 0, `the backend exits cleanly\n${client.stderr}`);
    client = undefined;
  });
} finally {
  if (client) {
    client.kill();
    await bounded(client.exited, "the backend to be killed").catch(() => {});
  }
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
