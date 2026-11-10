# Gradle for Lithe

为 [Lithe](https://github.com/1lck/Lithe-IDEA) 提供 Gradle 项目支持：识别 Gradle 构建，在 Gradle 工具窗口里像
IntelliJ IDEA 一样按项目列出任务分组和依赖配置，运行任务、应用和测试。
这是一个**社区插件**，用 Lithe 的声明式构建系统接口（插件 API 3 的 `buildSystems`）实现，
只带一个 Gradle 初始化脚本，没有任何宿主代码。工具窗口由 macOS 宿主用 SwiftUI 原生渲染，插件不提供 Web 入口；
插件另带一个很小的 Node 后端，向 Java Support 提供 Gradle 的导入设置（见下文“Java 语言服务器的导入设置”）。

> English: Gradle support for Lithe through the declarative `buildSystems` plugin API — projects with their tasks by
> group, JavaExec tasks as run entries, test runs with JUnit reports, compiler diagnostics and per-configuration
> dependency trees. It runs your own Gradle with a bundled init script.

> **试用版**：`buildSystems` 接口还在 Lithe 的预览分支上，0.1.0 作为预发布版本提供，需要包含该接口的 Lithe 开发版。

## 功能

| 功能 | 说明 |
| --- | --- |
| 识别项目 | 最外层含 `settings.gradle(.kts)` 或 `build.gradle(.kts)` 的目录是构建根，`include` 的子项目组成项目树 |
| 任务 | 每个项目的全部任务，按 `Tasks › <分组>` 归类（build、verification、help…，没有分组的放在 other）；根项目任务按名称运行（作用于所有项目，与 `gradle build` 相同），子项目任务按路径运行（`:app:build`） |
| 运行 | `JavaExec` 类型的任务（如 `application` 插件的 `run`）作为可运行的应用 |
| 自定义任务 | “Run Gradle Tasks…” 输入任意任务和参数，选中子项目时在该项目目录下运行 |
| 选项 | 工具栏开关 Offline（`--offline`）；Gradle User Home（`--gradle-user-home`） |
| 测试 | 运行项目、测试类或单个方法（`--tests`），读取 `build/test-results/test` 的 JUnit XML 报告；`--rerun` 仅重新执行所选测试任务，编译等依赖仍使用增量缓存，避免旧报告被宿主过滤后显示为零 |
| 诊断 | 把 javac 的 `文件:行: error|warning:` 和 Kotlin 的 `e:|w: file://…` 输出显示为问题 |
| 依赖 | 每个项目按 source set 的 `compileClasspath`、`runtimeClasspath`、`annotationProcessor` 等配置显示依赖树；已出现过的组件标记为省略，不重复展开（与 `gradle dependencies` 的 `(*)` 相同） |
| 内容根 | source set 的 Java/Kotlin/Groovy/Scala 源码、资源和注解处理器生成目录；`build` 与 `.gradle` 标为排除 |
| 同步 | 构建脚本、`gradle.properties`、`gradle/libs.versions.toml`、Wrapper 配置变化后重新读取项目 |

## 新建项目

插件在 New Project 窗口提供 “Gradle” 条目，生成一个 Gradle Java 项目：可选 Kotlin 或 Groovy DSL、JDK、是否添加示例代码，
以及 GroupId 和 ArtifactId。模板在 `io.github.lithe-idea.gradle-build/templates/java/`，从 Java Support 插件移来，
生成的文件与原来相同。条目要求 `java` 语言和 `gradle` 构建系统同时可用，所以生成的项目需要安装 Java Support 插件提供 Java 语言支持。

## Java 语言服务器的导入设置

旧版清单里的 `buildSystems[].languageImport` 已从插件契约删除。现在 Gradle 插件导出插件函数 `languageImport.settings`
（版本 1，`context: "workspace"`），Java Support 在启动 JDT LS 前调用它，只接受 `java.import.gradle.` 等白名单前缀内的键。
后端只读取工作区里的文件，不运行 Gradle、不写任何文件：

| 来源 | 导出的键 |
| --- | --- |
| 环境变量 `GRADLE_USER_HOME`（绝对路径） | `java.import.gradle.user.home` |
| `gradle.properties` 的 `org.gradle.java.home`（绝对路径） | `java.import.gradle.java.home` |
| `gradle.properties` 的 `org.gradle.jvmargs` | `java.import.gradle.jvmArguments` |

`gradle.properties` 先读 Gradle User Home 里的，再读项目根的，项目根优先。`workspaceRoot` 必须落在已打开的本地工作区文件夹内，
否则函数拒绝（`gradle.invalidRoot`）。工具栏的 Offline 与 Gradle User Home 选项只保存在宿主里，插件后端读不到，
所以它们不再传给 JDT LS，需要宿主把已存选项交给插件函数后才能恢复。后端需要 Node.js 20.3 或更新版本。

## 依赖的程序

插件不带 Gradle，使用你项目或电脑上的 Gradle，按以下顺序查找：

1. 项目里的 Gradle Wrapper（`gradlew`，需要 `gradle/wrapper/gradle-wrapper.properties`）；
2. 环境变量 `GRADLE_HOME` 下的 `bin/gradle`；
3. `PATH` 里的 `gradle`。

要求 Gradle 7.6 或更新版本，以及该 Gradle 版本支持的 Java（Gradle 9 需要 Java 17）。

## 工作方式

读取项目和依赖时，插件用 `--init-script` 给你的 Gradle 加载随包提供的 `lithe.init.gradle`：

- `litheModel` 在所有项目配置完成后，把项目、任务和 source set 写成 Lithe 的 `litheBuildModel` 文档；
  `litheDependencyReport` 在每个项目内解析依赖配置，再写成 `litheDependencies` 文档。
  文件位置由 Lithe 指定（`-PlitheModelOutput` / `-PlitheDependenciesOutput`）。
- 这两个命令附带 `--no-configuration-cache` 和 `--no-configure-on-demand`，确保读到所有项目；
  只导出最外层构建，`buildSrc` 和 included build 不会覆盖结果。
- 不会编译、打包或生成 `build/`；解析依赖只下载依赖的元数据，不下载 jar。
- 不带这些属性时脚本只注册任务，不做别的事；插件目录在运行时保持只读。

读取项目会执行构建脚本和其中的插件，首次读取还可能联网下载插件和依赖元数据，所以 Lithe 会先确认你信任这个工作区。

## 安装

`v0.1.2` 移除宿主已删除的 `languageImport` 字段并改用插件函数提供导入设置；`v0.1.1` 修复重复运行测试时报告显示为零的问题。均需要兼容 `buildSystems` 插件 API 3 的 Lithe preview 开发版。
Lithe Store 条目合并后，可在 **设置 → 插件 → 插件市场** 搜索 “Gradle”，安装并按提示重启；
条目合并前可下载 Release 的 ZIP，从 Lithe 开发版的 **⚙ → 从磁盘安装插件…** 安装。
Lithe 已预置 Lithe Store 社区插件源；如果你之前移除了它，先在 **⚙ → 管理插件仓库…** 中重新添加
`https://github.com/Lithe-IDEA/Lithe-store`。

一个包同时支持 Apple Silicon 和 Intel Mac；Lithe for Windows 支持插件市场后会增加 Windows 包。

## 开发

```text
io.github.lithe-idea.gradle-build/plugin.json         # 插件描述，目录名必须等于插件 id
io.github.lithe-idea.gradle-build/lithe.init.gradle   # 初始化脚本，导出模型和依赖树
io.github.lithe-idea.gradle-build/backend/            # languageImport.settings 后端（Node）和固定版本的官方 SDK（sdk.lock.json）
io.github.lithe-idea.gradle-build/icons/              # 工具窗口和工具栏图标（来源见 NOTICE）
io.github.lithe-idea.gradle-build/templates/java/     # New Project 的 Gradle Java 项目模板（Kotlin/Groovy DSL、示例代码）
test/fixtures/multi/                                  # 两个子项目的示例构建，供集成测试使用
scripts/package.mjs                                   # 打包成 dist/gradle-build-<版本>-darwin.zip
scripts/test.mjs                                      # 用真实 Gradle 运行清单里的命令并检查输出
.github/workflows/ci.yml                              # PR 时打包、用 Gradle 7.6 和 9.6.1 测试，并用 Lithe Store 的规则检查
.github/workflows/release.yml                         # 推送 v<版本> 标签时发布 GitHub Release
```

本地需要 Node.js 22+、JDK 17+ 和 Gradle（还需要 `zip`）：

```bash
node scripts/package.mjs
```

```bash
GRADLE=/path/to/gradle node scripts/test.mjs
```

只验证测试报告回归时可运行 `GRADLE=/path/to/gradle node scripts/test.mjs --test-results-only`；它连续运行两次相同测试，检查第二次报告刷新且测试类没有重新编译。

测试使用临时工作区和独立的 Gradle User Home，每个 Gradle 命令最多运行 120 秒，结束时有界停止该测试的守护进程并清理临时目录。
每次运行都使用 `--no-daemon`；初始化脚本自己的运行还带 `--warning-mode=fail`，出现弃用警告即失败。
输出记录命令和每项断言的耗时，并检查运行前后插件包的文件清单与 SHA-256 保持不变。
在 Lithe 开发版中，通过 **设置 → 插件 → ⚙ → 从磁盘安装插件…** 选择
`dist/package/io.github.lithe-idea.gradle-build` 即可安装本地开发包（发行版 Lithe 不加载未签名的开发包）。

`plugin.json` 的完整格式见 lithe-plugin-docs 里的
[插件契约](https://github.com/Lithe-IDEA/lithe-plugin-docs/blob/main/contract/v1/README.md)
和[构建工具接入指南](https://github.com/Lithe-IDEA/lithe-plugin-docs/blob/main/guides/build-tool-integration.md)。

## 诊断日志

此插件的 Gradle 命令及模型导出脚本由宿主执行，后端只在 Java Support 调用 `languageImport.settings` 时启动，用官方 SDK 自动记录该函数的结构化操作事实（不含路径和属性值）。
启用结构化日志 v2 的 Lithe macOS preview 由宿主将构建、运行与测试的进程终态、退出码和耗时
记录到当前会话的 `run` 通道；Gradle 的编译输出和测试报告继续留在 Build Output 与测试界面。
模型与依赖树 JSON 是工作流数据，不是日志，仍通过宿主提供的临时输出文件返回。

模型导出和依赖树命令同样由宿主执行。宿主替插件把每次执行记成与 SDK 插件同一组的操作事实，写入
`plugins/io.github.lithe-idea.gradle-build/host` 通道，操作名为 `lithe/build/model` 和
`lithe/build/dependencies`（与由插件后端提供时的请求名相同）：结果成功解码记
`plugins.operation.finished`（INFO，含耗时）；失败记 `plugins.operation.failed`（ERROR），失败码只取自
执行阶段——`host.planFailed`（无法生成命令计划）、`host.executableUnavailable`（无法解析 Gradle 或
wrapper）、`host.launchFailed`（进程拉起失败）、`host.timedOut`（超时）、`host.commandFailed`（命令失败
退出）、`host.outputInvalid`（输出文件无法解码）。取消和被新请求取代的结果不记录；事实不含 Gradle 输出、
路径或命令行。插件不需要任何日志代码，宿主实现见 https://github.com/1lck/Lithe-IDEA/pull/1720。

排障时使用 Lithe 的独立日志窗口和诊断导出。不启用 Gradle `--debug` 来复制环境、凭据、
完整命令行或构建正文，也不将 Gradle User Home、daemon 状态或输出文件迁入日志目录。
Windows 的日志实现仍为 v1；本文没有声明 Windows 已完成 v2 验收。

## 发布新版本

1. 修改 `plugin.json` 的 `version`（例如 `0.2.0`），合入 `main`。
2. 推送同名标签：

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. `Release` 工作流会核对标签与版本、打包、测试并发布 Release（说明里附 SHA-256）；`v0.1.0` 会直接标为预发布。
4. `v0.1.0` 预发布需要单独提交 Lithe Store 条目合并请求；后续稳定版可由 Store 自动追踪并开合并请求，合并后用户即可在 Lithe 中更新。

## 许可

[Apache-2.0](LICENSE)。图标来自 IntelliJ Platform，见 [NOTICE](NOTICE)。
