#!/usr/bin/env node
// Runs the commands plugin.json declares against test/fixtures/multi with a
// real Gradle, and checks the documents the init script writes. Lithe's own
// tests decode these documents; this script makes sure Gradle produces them.
//
// Run scripts/package.mjs first. GRADLE selects the Gradle executable
// (default `gradle`), so CI can also check the oldest supported Gradle.
//
// LITHE_CAPTURE_DIR=<dir> also copies the documents there, with the
// scratch workspace written as `${workspace}`, for Lithe's Core tests.
//
// Usage: node scripts/test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_DIR = "io.github.lithe-idea.gradle-build";
const pluginDir = resolve("dist", "package", PACKAGE_DIR);
const gradle = process.env.GRADLE ?? "gradle";
if (!existsSync(join(pluginDir, "plugin.json"))) {
  console.error("✗ dist/package is missing; run node scripts/package.mjs first");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
const buildSystem = manifest.buildSystems[0];
// Every run starts and stops its own daemon, so the test leaves no Gradle
// process behind. The init script's own runs also fail on any deprecation.
const SINGLE_USE = ["--no-daemon"];
const STRICT = [...SINGLE_USE, "--warning-mode=fail"];

/**
 * Expands a declared argument list the way Lithe does for this test: no
 * option has a value, so `${optionArguments…}` contributes nothing, and a
 * conditional argument is kept when its conditions hold. `project` is a
 * project of the exported model.
 */
function expand(list, { outputFile, project, suite }) {
  const nested = project !== undefined && project.properties.path !== ":";
  const conditions = {
    projectSelected: project !== undefined,
    noProjectSelected: project === undefined,
    nestedProjectSelected: nested,
    noNestedProjectSelected: !nested,
    suiteSelected: suite !== undefined,
    noSuiteSelected: suite === undefined,
    caseSelected: false,
    noCaseSelected: true,
  };
  const result = [];
  for (const item of list) {
    const value = typeof item === "string" ? item : item.value;
    const when = typeof item === "string" ? [] : [item.when].flat();
    if (!when.every((condition) => conditions[condition])) continue;
    if (/^\$\{optionArguments(:[A-Za-z]+)?\}$/.test(value)) continue;
    result.push(
      value
        .replaceAll("${pluginDir}", pluginDir)
        .replaceAll("${outputFile}", outputFile ?? "")
        .replaceAll(/\$\{project\.property:([A-Za-z]+)\}/g, (_, key) => project.properties[key])
        .replaceAll("${test.suite}", suite ?? ""),
    );
  }
  return result;
}

const COMMAND_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const scratch = mkdtempSync(join(tmpdir(), "lithe-gradle-test-"));
const root = join(scratch, "multi");
// A test owns its Gradle state and daemons, including when a command times out.
// Stopping this user home cannot terminate a developer's unrelated Gradle build.
const gradleUserHome = join(scratch, "gradle-home");

async function execute(root, argv, { quiet = false, timeout = COMMAND_TIMEOUT_MS } = {}) {
  const started = performance.now();
  await new Promise((resolve, reject) => {
    const child = spawn(gradle, argv, {
      cwd: root,
      env: { ...process.env, GRADLE_USER_HOME: gradleUserHome },
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", quiet ? "ignore" : "inherit"],
    });
    let timedOut = false;
    let interrupted = false;
    let forceKill;
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    const terminate = () => {
      kill("SIGTERM");
      forceKill ??= setTimeout(() => kill("SIGKILL"), CLEANUP_TIMEOUT_MS);
    };
    const interrupt = () => {
      interrupted = true;
      terminate();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeout);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      // A timed-out launcher may exit before its child daemon has stopped.
      if (timedOut || interrupted) kill("SIGKILL");
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      const label = argv.join(" ");
      if (timedOut) reject(new Error(`Gradle timed out after ${timeout}ms: ${label}`));
      else if (interrupted) reject(new Error(`Gradle interrupted: ${label}`));
      else if (code !== 0) reject(new Error(`Gradle exited ${code ?? signal}: ${label}`));
      else resolve();
    });
  });
  console.log(`Gradle command completed in ${((performance.now() - started) / 1000).toFixed(2)}s: ${argv.at(-1)}`);
}

async function run(root, list, values = {}, extra = SINGLE_USE) {
  const argv = [...extra, ...expand(buildSystem.invocation.globalArguments, values), ...expand(list, values)];
  await execute(root, argv);
}
const captureDir = process.env.LITHE_CAPTURE_DIR;
function capture(name, file) {
  if (!captureDir) return;
  let text = readFileSync(file, "utf8");
  // The real path first: on macOS it extends the temporary path.
  for (const prefix of new Set([realpathSync(root), root])) text = text.replaceAll(prefix, "${workspace}");
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(join(captureDir, name), text);
}
function packageSnapshot(directory = pluginDir, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    return entry.isDirectory()
      ? [[`${name}/`, null], ...packageSnapshot(path, `${name}/`)]
      : [[name, createHash("sha256").update(readFileSync(path)).digest("hex")]];
  });
}
const packageBefore = packageSnapshot();
let failed = false;
const check = async (name, body) => {
  const started = performance.now();
  try {
    await body();
    console.log(`✓ ${name} (${((performance.now() - started) / 1000).toFixed(2)}s)`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${name}\n${error.stack}`);
  }
};

try {
  cpSync(resolve("test", "fixtures", "multi"), root, { recursive: true });

  const modelFile = join(scratch, "model.json");
  await run(root, buildSystem.model.arguments, { outputFile: modelFile }, STRICT);
  capture("model.json", modelFile);
  const model = JSON.parse(readFileSync(modelFile, "utf8"));
  const byName = (name) => model.projects.find((project) => project.name === name);
  const task = (project, name) => model.tasks.find((entry) => entry.project === byName(project).path && entry.name === name);

  if (!process.argv.includes("--test-results-only")) {
    await check("the model lists every project with its Gradle path", () => {
      assert.equal(model.format, "litheBuildModel");
      assert.deepEqual(model.projects.map((project) => project.name), ["multi", "app", "core"]);
      assert.equal(byName("core").parent, byName("multi").path);
      assert.deepEqual(byName("multi").properties, { path: ":", taskPrefix: ":", group: "demo", version: "1.0.0" });
      assert.deepEqual(byName("core").properties, { path: ":core", taskPrefix: ":core:", group: "demo", version: "1.0.0" });
    });

    await check("tasks are filed under their Gradle group and run by path", () => {
      assert.deepEqual(task("core", "test").category, ["Tasks", "verification"]);
      assert.deepEqual(task("core", "compileJava").category, ["Tasks", "other"]);
      assert.equal(task("core", "build").properties.path, ":core:build");
      assert.equal(task("multi", "help").properties.path, "help", "a root task runs as a selector");
      const templates = new Set(buildSystem.tasks.filter((entry) => entry.fromModel).map((entry) => entry.id));
      assert.ok(model.tasks.every((entry) => templates.has(entry.template)), "every task names a fromModel template");
      assert.ok(!model.tasks.some((entry) => entry.name.startsWith("lithe")), "Lithe's own tasks are hidden");
    });

    await check("JavaExec tasks are applications the run entries pick up", () => {
      assert.equal(task("app", "run").execution, "application");
      assert.equal(task("app", "run").properties.path, ":app:run");
      assert.equal(task("core", "test").execution, undefined);
    });

    await check("source sets become content roots", () => {
      const core = byName("core").path;
      const kinds = model.contentRoots.filter((entry) => entry.project === core).map((entry) => [entry.kind, entry.path]);
      for (const expected of [
        ["source", join(core, "src", "main", "java")],
        ["resource", join(core, "src", "main", "resources")],
        ["testSource", join(core, "src", "test", "java")],
        ["testResource", join(core, "src", "test", "resources")],
        ["generatedSource", join(core, "build", "generated", "sources", "annotationProcessor", "java", "main")],
      ]) {
        assert.ok(kinds.some(([kind, path]) => kind === expected[0] && path === expected[1]), `${expected.join(" ")}`);
      }
      assert.ok(!model.contentRoots.some((entry) => entry.project === byName("multi").path));
    });

    const projectDependencies = join(scratch, "app-dependencies.json");
    await run(root, buildSystem.dependencies.arguments, { outputFile: projectDependencies, project: byName("app") }, STRICT);
    capture("app-dependencies.json", projectDependencies);
    await check("a project's tree lists its classpaths with the sibling project", () => {
      const tree = JSON.parse(readFileSync(projectDependencies, "utf8"));
      assert.equal(tree.format, "litheDependencies");
      assert.deepEqual(tree.dependencies.map((node) => node.name), [
        "compileClasspath",
        "runtimeClasspath",
        "testCompileClasspath",
        "testRuntimeClasspath",
      ]);
      assert.deepEqual(tree.dependencies[0].children.map((node) => [node.name, node.properties]), [
        ["core", { kind: "project", path: ":core" }],
      ]);
    });

    const workspaceDependencies = join(scratch, "dependencies.json");
    await run(root, buildSystem.dependencies.arguments, { outputFile: workspaceDependencies }, STRICT);
    capture("dependencies.json", workspaceDependencies);
    await check("the workspace tree has one node per project with transitive children", () => {
      const tree = JSON.parse(readFileSync(workspaceDependencies, "utf8"));
      assert.deepEqual(tree.dependencies.map((node) => node.name), ["multi", "app", "core"]);
      const core = tree.dependencies[2];
      const testClasspath = core.children.find((node) => node.name === "testCompileClasspath");
      const junit = testClasspath.children[0];
      assert.deepEqual([junit.group, junit.name, junit.version], ["junit", "junit", "4.13.2"]);
      assert.equal(junit.children[0].name, "hamcrest-core");
    });

    await check("an unknown project fails instead of writing an empty tree", async () => {
      const missing = { properties: { path: ":missing" } };
      await assert.rejects(
        execute(root, [...SINGLE_USE, ...expand(buildSystem.dependencies.arguments, { outputFile: join(scratch, "x.json"), project: missing })], { quiet: true }),
        /Gradle exited 1:/,
      );
      assert.ok(!existsSync(join(scratch, "x.json")), "the failed command wrote no document");
    });

    await check("reading the model and dependencies builds nothing", () => {
      for (const directory of ["build", "core/build", "app/build"]) {
        assert.ok(!existsSync(join(root, directory)), `${directory} was not created`);
      }
    });

  }

  const testSelection = { project: byName("core"), suite: "demo.core.GreeterTest" };
  await run(root, buildSystem.test.arguments, testSelection);
  await check("a filtered test run writes the report the results glob reads", () => {
    const report = readFileSync(join(root, "core", "build", "test-results", "test", "TEST-demo.core.GreeterTest.xml"), "utf8");
    assert.match(report, /<testsuite[^>]*name="demo\.core\.GreeterTest"[^>]*tests="2"/);
  });

  await check("repeated tests refresh reports while compiled dependencies stay incremental", async () => {
    const report = join(root, "core", "build", "test-results", "test", "TEST-demo.core.GreeterTest.xml");
    const classFile = join(root, "core", "build", "classes", "java", "test", "demo", "core", "GreeterTest.class");
    const compiledBefore = statSync(classFile).mtimeMs;
    // A fixed old timestamp reproduces the host's stale-report rejection without
    // sleeps or relying on how quickly the two Gradle invocations finish.
    utimesSync(report, new Date(0), new Date(0));
    const started = Date.now();
    await run(root, buildSystem.test.arguments, testSelection);
    assert.ok(statSync(report).mtimeMs >= started, "the repeated run must produce a current report");
    assert.match(readFileSync(report, "utf8"), /<testsuite[^>]*name="demo\.core\.GreeterTest"[^>]*tests="2"/);
    assert.equal(statSync(classFile).mtimeMs, compiledBefore, "test compilation must remain incremental");
  });

  if (!process.argv.includes("--test-results-only")) {
    await check("without Lithe's properties the init script does nothing", async () => {
      await execute(root, [...STRICT, "-q", "--no-configuration-cache", "--init-script", join(pluginDir, "lithe.init.gradle"), "help"]);
    });
  }
  await check("the packaged plugin stays byte-identical after the workflow", () => {
    assert.deepEqual(packageSnapshot(), packageBefore);
  });
} finally {
  try {
    await execute(root, ["--stop"], { timeout: 15_000 });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
