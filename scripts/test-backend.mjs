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
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackendClient, bounded } from "./backend-client.mjs";

const jar = resolve("dist", "package", "io.github.lithe-idea.gradle-build", "lib", "lithe-gradle-backend.jar");
if (!existsSync(jar)) {
  console.error("✗ dist/package is missing the backend; run node scripts/package.mjs first");
  process.exit(1);
}
const java = process.env.LITHE_TEST_JAVA ?? "java";
const manifest = JSON.parse(readFileSync(resolve("dist", "package", "io.github.lithe-idea.gradle-build", "plugin.json"), "utf8"));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lithe-gradle-backend-test-")));
const workspace = join(scratch, "workspace");
const outside = join(scratch, "outside");
const gradleHome = join(scratch, "gradle-home");
const home = join(scratch, "home");
const jdkHome = join(scratch, "chosen-jdk").replaceAll("\\", "/");
for (const directory of [join(workspace, "app"), outside, gradleHome, home]) mkdirSync(directory, { recursive: true });
writeFileSync(join(gradleHome, "gradle.properties"), `org.gradle.jvmargs=-Xmx1g\norg.gradle.java.home=${jdkHome}\norg.gradle.parallel=true\n`);
writeFileSync(join(workspace, "app", "gradle.properties"), "org.gradle.jvmargs=-Xmx4g \\\n  -Dfile.encoding=UTF-8\norg.gradle.java.home=relative/jdk\n");
symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");

let client;
let failed = false;
const step = async (name, body) => {
  try { await body(); console.log(`✓ ${name}`); }
  catch (error) { failed = true; console.error(`✗ ${name}\n${error.stack}`); }
};
try {
  client = new BackendClient({
    java, jar, args: [],
    // The Java tool definition owns the JAR entry switch. This SDK probe
    // exercises the packaged JVM options; Viva integration tests additionally
    // verify Core's tool-template instantiation and the real entry path.
    javaOptions: [`-Duser.home=${home}`, ...manifest.backend.launch.runtimeArguments],
    env: { ...process.env, GRADLE_USER_HOME: gradleHome },
    hostRequests: { "lithe/host/workspace/getFolders": () => ({ folders: [{ rootID: "r", name: "w", path: workspace }] }) },
  });
  const initialized = await client.initialize(workspace, { functions: true });
  assert.deepEqual(initialized.capabilities.experimental.litheFunctions.functions, [{ id: "languageImport.settings" }]);
  const invoke = (workspaceRoot, context = { contextID: "ctx", generation: 1 }) => client.send("lithe/function/invoke", {
    functionID: "languageImport.settings", operationID: `op-${Math.random()}`, params: { workspaceRoot }, ...(context ? { context } : {}),
  }).response;

  await step("Gradle user home properties take precedence over project values and only known keys are exported", async () => {
    assert.deepEqual((await invoke(join(workspace, "app"))).result, { settings: {
      "java.import.gradle.user.home": gradleHome,
      "java.import.gradle.jvmArguments": "-Xmx1g",
      "java.import.gradle.java.home": jdkHome,
    } });
    assert.equal(client.diagnostics.filter((fact) => fact.operation === "languageImport.settings").length, 0, "configuration reads suppress success facts");
  });
  await step("a root outside the open workspace folders, through a link, relative or without a context is refused", async () => {
    for (const root of [outside, join(workspace, "escape"), "relative"]) {
      assert.equal((await invoke(root)).error?.data?.code, "gradle.invalidRoot", root);
    }
    assert.equal((await invoke(workspace, null)).error?.data?.code, "gradle.noWorkspaceContext");
  });
  await step("invalid, oversized and unreadable configuration fails instead of silently changing the JDK", async () => {
    const file = join(workspace, "app", "gradle.properties");
    for (const [contents, code] of [["org.gradle.java.home=\\uZZZZ", "gradle.propertiesInvalid"], ["#".repeat(256 * 1024 + 1), "gradle.propertiesTooLarge"]]) {
      writeFileSync(file, contents);
      assert.equal((await invoke(join(workspace, "app"))).error?.data?.code, code);
    }
    rmSync(file);
    mkdirSync(file);
    assert.equal((await invoke(join(workspace, "app"))).error?.data?.code, "gradle.propertiesUnreadable");
    rmSync(file, { recursive: true });
    assert.deepEqual((await invoke(join(workspace, "app"))).result.settings["java.import.gradle.java.home"], jdkHome);
    for (const code of ["gradle.propertiesInvalid", "gradle.propertiesTooLarge", "gradle.propertiesUnreadable"]) {
      assert.equal(client.diagnostics.filter((fact) => fact.operation === "languageImport.settings" && fact.kind === "operationFailed" && fact.code === code).length, 1, code);
    }
    const facts = JSON.stringify(client.diagnostics);
    for (const privateValue of [scratch, "org.gradle.java.home", "/jdk/home", "-Xmx4g"]) assert.equal(facts.includes(privateValue), false, "diagnostics contain no configuration content");
  });
  await step("the backend exits on shutdown", async () => {
    assert.equal(await client.close(), 0, `the backend exits cleanly\n${client.stderr}`);
    client = undefined;
  });
  for (const fault of ["abort", "oversized frame"]) {
    await step(`the driver reaps a backend after ${fault}`, async () => {
      const peer = new BackendClient({java, jar, args: [], javaOptions: [`-Duser.home=${home}`]});
      try {
        await peer.initialize(workspace, {functions: true});
        if (fault === "abort") peer.kill();
        else peer.child.stdout.emit("data", Buffer.from("Content-Length: 1000000000\r\n\r\n"));
        await bounded(peer.exited, "faulted backend disposal", 2000);
      } finally {
        // The fixture's function-only JVM starts no children. Keep this final
        // independent stop even when the driver under test fails to reap it.
        if (peer.child.exitCode === null && peer.child.signalCode === null) peer.child.kill("SIGKILL");
        await bounded(peer.exited, "fixture JVM disposal", 5000);
      }
    });
  }
} finally {
  if (client) {
    client.kill();
    await bounded(client.exited, "the backend to be killed").catch((error) => {
      failed = true;
      console.error(`backend cleanup failed: ${error.message}`);
    });
  }
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
