# Gradle for Lithe

为 [Lithe](https://github.com/Lithe-IDEA/Lithe-IDEA) 提供 Gradle 项目支持：识别 Gradle 构建，在 Gradle 工具窗口里像
IntelliJ IDEA 一样按项目列出任务分组和依赖配置，运行任务、应用和测试。
这是一个**社区插件**，用 Lithe 的声明式构建系统接口（插件 API 3 的 `buildSystems`）实现，
只带一个 Gradle 初始化脚本，没有任何宿主代码。工具窗口由 macOS 宿主用 SwiftUI 原生渲染，插件不提供 Web 入口；
`languageImport` 把 Offline 和 Gradle User Home 选项传给 Java 语言服务器的 Gradle 导入。

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
| 测试 | 运行项目、测试类或单个方法（`--tests`），读取 `build/test-results/test` 的 JUnit XML 报告 |
| 诊断 | 把 javac 的 `文件:行: error|warning:` 和 Kotlin 的 `e:|w: file://…` 输出显示为问题 |
| 依赖 | 每个项目按 source set 的 `compileClasspath`、`runtimeClasspath`、`annotationProcessor` 等配置显示依赖树；已出现过的组件标记为省略，不重复展开（与 `gradle dependencies` 的 `(*)` 相同） |
| 内容根 | source set 的 Java/Kotlin/Groovy/Scala 源码、资源和注解处理器生成目录；`build` 与 `.gradle` 标为排除 |
| 同步 | 构建脚本、`gradle.properties`、`gradle/libs.versions.toml`、Wrapper 配置变化后重新读取项目 |

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

`v0.1.0` 是预发布版本，需要兼容 `buildSystems` 插件 API 3 的 Lithe preview 开发版。
Lithe Store 条目合并后，可在 **设置 → 插件 → 插件市场** 搜索 “Gradle”，安装并按提示重启；
条目合并前可下载 Release 的 ZIP，从 Lithe 开发版的 **⚙ → 从磁盘安装插件…** 安装。
Lithe 已预置 Lithe Store 社区插件源；如果你之前移除了它，先在 **⚙ → 管理插件仓库…** 中重新添加
`https://github.com/Lithe-IDEA/Lithe-store`。

一个包同时支持 Apple Silicon 和 Intel Mac；Lithe for Windows 支持插件市场后会增加 Windows 包。

## 开发

```text
io.github.lithe-idea.gradle-build/plugin.json         # 插件描述，目录名必须等于插件 id
io.github.lithe-idea.gradle-build/lithe.init.gradle   # 初始化脚本，导出模型和依赖树
io.github.lithe-idea.gradle-build/icons/              # 工具窗口和工具栏图标（来源见 NOTICE）
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

测试使用临时工作区和独立的 Gradle User Home，每个 Gradle 命令最多运行 120 秒，结束时有界停止该测试的守护进程并清理临时目录。
每次运行都使用 `--no-daemon`；初始化脚本自己的运行还带 `--warning-mode=fail`，出现弃用警告即失败。
输出记录命令和每项断言的耗时，并检查运行前后插件包的文件清单与 SHA-256 保持不变。
在 Lithe 开发版中，通过 **设置 → 插件 → ⚙ → 从磁盘安装插件…** 选择
`dist/package/io.github.lithe-idea.gradle-build` 即可安装本地开发包（发行版 Lithe 不加载未签名的开发包）。

`plugin.json` 的完整格式见 Lithe 的
[插件契约](https://github.com/Lithe-IDEA/Lithe-IDEA/blob/preview/shared/contracts/plugins/v1/README.md)
和 Lithe Store 的[构建工具接入指南](https://github.com/Lithe-IDEA/Lithe-store/blob/main/docs/build-tool-integration.md)。

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
