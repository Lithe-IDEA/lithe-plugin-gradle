// Runs the packaged Gradle and Java backends with Viva, Core and a real JDT LS.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTool } from "../compiler/process.mjs";

const [hostArg, javaPlugin, jdkArchive, jdtArchive, gradleArchive, gradleDir, projectJava] = process.argv.slice(2);
if (process.platform !== "darwin" || !projectJava) {
  throw Error("Usage on macOS: node scripts/language-import/test.mjs <Lithe checkout> <Java plugin package> <managed JDK archive> <JDT LS archive> <Gradle ZIP> <extracted Gradle> <project JDK home>");
}
const root = fileURLToPath(new URL("../..", import.meta.url));
const host = resolve(hostArg);
const plugin = join(root, "dist/package/io.github.lithe-idea.gradle-build");
for (const path of [javaPlugin, jdkArchive, jdtArchive, gradleArchive, gradleDir, projectJava, plugin]) {
  statSync(path);
}
const temporary = mkdtempSync(join(tmpdir(), "lithe-gradle-import-overlay-"));
try {
  const testPath = "desktop/internal/workbench/gradle_configuration_test.go";
  const overlay = join(temporary, "overlay.json");
  writeFileSync(overlay, JSON.stringify({ Replace: { [join(host, testPath)]: join(root, "e2e/host", testPath) } }));
  const output = await runTool("bash", [
    "scripts/desktop/desktop-go.sh", "test", "-overlay", overlay, "-tags", "vivahead",
    "-count=1", "-timeout=4m", "./internal/workbench", "-run", "^TestGradleConfigurationReachesLiveJDT$", "-v",
  ], {
    cwd: host,
    env: {
      ...process.env,
      LITHE_GRADLE_E2E_PLUGIN: plugin,
      LITHE_GRADLE_E2E_JAVA_PLUGIN: resolve(javaPlugin),
      LITHE_GRADLE_E2E_JDK_ARCHIVE: resolve(jdkArchive),
      LITHE_GRADLE_E2E_JDT_ARCHIVE: resolve(jdtArchive),
      LITHE_GRADLE_E2E_GRADLE_ARCHIVE: resolve(gradleArchive),
      LITHE_GRADLE_E2E_GRADLE_DIR: resolve(gradleDir),
      LITHE_GRADLE_E2E_PROJECT_JAVA: resolve(projectJava),
    },
    timeout: 480_000,
  });
  process.stdout.write(output);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
