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
const toolbarHome = join(scratch, "toolbar-home");
const watchMethod = "lithe/host/build/watchConfiguration";
const optionsMethod = "lithe/host/build/getOptions";
const changedFunction = "languageImport.settingsChanged";
let selectedOptions = {};
let nextWatch = 0;
let contexts = [{ contextID: "ctx", generation: 1 }];
let onDispose;
let watches = new Map();
let deliveries = [];
let onDelivery;
const expectDelivery = () => bounded(new Promise((resolve) => { onDelivery = resolve; }), "a settings change");
const home = join(scratch, "home");
const jdkHome = join(scratch, "chosen-jdk").replaceAll("\\", "/");
for (const directory of [join(workspace, "app"), outside, gradleHome, toolbarHome, home]) mkdirSync(directory, { recursive: true });
writeFileSync(join(gradleHome, "gradle.properties"), `org.gradle.jvmargs=-Xmx1g\norg.gradle.java.home=${jdkHome}\norg.gradle.parallel=true\n`);
writeFileSync(join(workspace, "app", "gradle.properties"), "org.gradle.jvmargs=-Xmx4g \\\n  -Dfile.encoding=UTF-8\norg.gradle.java.home=relative/jdk\n");
writeFileSync(join(workspace, "app", "build.gradle"), "");
writeFileSync(join(toolbarHome, "gradle.properties"), "org.gradle.jvmargs=-Xmx2g\n");
symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");

let client;
let failed = false;
const step = async (name, body) => {
  try { await body(); console.log(`✓ ${name}`); }
  catch (error) { failed = true; console.error(`✗ ${name}\n${error.stack}`); }
};
try {
  client = new BackendClient({
    java, jar,
    // The Java tool definition owns the JAR entry switch. This SDK probe
    // exercises the packaged JVM options; Viva integration tests additionally
    // verify Core's tool-template instantiation and the real entry path.
    javaOptions: [`-Duser.home=${home}`, ...manifest.backend.launch.runtimeArguments],
    env: { ...process.env, GRADLE_USER_HOME: gradleHome },
    hostRequests: {
      "lithe/host/workspace/getFolders": () => ({ folders: [{ rootID: "r", name: "w", path: workspace }] }),
      "lithe/host/workspace/listContexts": () => ({ contexts }),
      "lithe/host/getCapabilities": () => ({ services: { build: { methods: [watchMethod, optionsMethod] } } }),
      [optionsMethod]: ({ buildSystemID, root }) => {
        assert.equal(buildSystemID, "gradle");
        assert.equal(root, "app");
        return { options: selectedOptions };
      },
      [watchMethod]: ({ files }) => {
        const id = `watch-${++nextWatch}`;
        watches.set(id, { files, sequence: 0 });
        return { subscriptionID: id };
      },
      "lithe/host/subscriptions/dispose": ({ subscriptionID }) => {
        watches.delete(subscriptionID);
        onDispose?.(subscriptionID);
        return null;
      },
      "lithe/host/functions/invoke": (request) => {
        deliveries.push(request);
        onDelivery?.(request);
        onDelivery = undefined;
        return { value: {} };
      },
    },
  });
  const initialized = await client.initialize(workspace);
  assert.deepEqual(initialized.capabilities.experimental.litheFunctions.functions, [{ id: "compiler.prepareSettings" }, { id: "compiler.settings" }, { id: "languageImport.settings" }, { id: "libraries.settings" }]);
  const invoke = (workspaceRoot, context = { contextID: "ctx", generation: 1 }, caller) => client.send("lithe/function/invoke", {
    functionID: "languageImport.settings", operationID: `op-${Math.random()}`, params: { workspaceRoot }, ...(context ? { context } : {}), ...(caller ? { caller } : {}),
  }).response;

  await step("Gradle user home properties take precedence over project values and only known keys are exported", async () => {
    assert.deepEqual((await invoke(join(workspace, "app"))).result, { settings: {
      "java.import.gradle.offline.enabled": false,
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
  await step("toolbar changes switch Gradle homes and publish the full updated import snapshot", async () => {
    const root = join(workspace, "app");
    const context = { contextID: "ctx", generation: 1 };
    const caller = { pluginID: "test.java" };
    assert.equal((await invoke(root, context, caller)).result.settings["java.import.gradle.user.home"], gradleHome);
    const invalidate = (id) => client.notify("lithe/host/subscriptions/notify", {
      subscriptionID: id, sequence: ++watches.get(id).sequence, event: { type: "changed" },
    });
    let id = [...watches.keys()][0];
    selectedOptions = { offline: true, gradleUserHome: toolbarHome };
    let delivery = expectDelivery();
    invalidate(id);
    const request = await delivery;
    assert.equal(request.pluginID, caller.pluginID);
    assert.equal(request.functionID, changedFunction);
    assert.deepEqual(request.params, { settings: {
      "java.import.gradle.offline.enabled": true,
      "java.import.gradle.user.home": toolbarHome,
      "java.import.gradle.jvmArguments": "-Xmx2g",
      "java.import.gradle.java.home": "",
    } });
    assert.equal(watches.has(id), false, "the previous user home watch was disposed");
    id = [...watches.keys()][0];
    assert.deepEqual(watches.get(id).files, [join(root, "gradle.properties"), join(toolbarHome, "gradle.properties")]);
    rmSync(join(toolbarHome, "gradle.properties"));
    writeFileSync(join(root, "gradle.properties"), "org.gradle.jvmargs=-Xmx3g\n");
    delivery = expectDelivery();
    invalidate(id);
    assert.equal((await delivery).params.settings["java.import.gradle.jvmArguments"], "-Xmx3g");
    rmSync(join(root, "gradle.properties"));
    delivery = expectDelivery();
    invalidate(id);
    const removed = (await delivery).params.settings;
    assert.equal(removed["java.import.gradle.java.home"], "");
    assert.deepEqual(removed["java.import.gradle.jvmArguments"], []);
    selectedOptions = {};
    delivery = expectDelivery();
    invalidate(id);
    const cleared = (await delivery).params.settings;
    assert.equal(cleared["java.import.gradle.offline.enabled"], false);
    assert.equal(cleared["java.import.gradle.user.home"], gradleHome);
    assert.equal(cleared["java.import.gradle.jvmArguments"], "-Xmx1g");
  });
  await step("a workspace unrelated to Gradle does not install a watcher or send language settings", async () => {
    const before = watches.size;
    assert.deepEqual((await invoke(workspace)).result, { settings: {} });
    assert.equal(watches.size, before);
    assert.equal(deliveries.length, 4);
  });
  await step("closing a workspace releases its configuration subscription", async () => {
    assert.equal(watches.size, 1);
    const [subscription] = watches.keys();
    const disposed = bounded(new Promise((resolve) => { onDispose = resolve; }), "workspace subscription disposal");
    contexts = [{ contextID: "ctx", generation: 2 }];
    client.notify("lithe/host/workspace/didChangeContexts", { revision: 2 });
    assert.equal(await disposed, subscription);
    assert.equal(watches.size, 0);
    onDispose = undefined;
  });
  await step("the backend exits on shutdown", async () => {
    assert.equal(await client.close(), 0, `the backend exits cleanly\n${client.stderr}`);
    client = undefined;
  });
  for (const fault of ["abort", "oversized frame"]) {
    await step(`the driver reaps a backend after ${fault}`, async () => {
      const peer = new BackendClient({java, jar, javaOptions: [`-Duser.home=${home}`]});
      try {
        await peer.initialize(workspace);
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
