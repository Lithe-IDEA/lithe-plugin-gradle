# Gradle for Lithe

为 [Lithe](https://github.com/1lck/Lithe-IDEA) 提供 Gradle 项目支持：识别 Gradle 构建，在 Gradle 工具窗口里像
IntelliJ IDEA 一样按项目列出任务分组和依赖配置，运行任务、应用和测试。
这是一个**社区插件**，使用声明式 `buildSystems` 接口与一个 Java 后端；宿主呈现构建模型，插件不提供网页界面。
1.0.0 预发布面向 Viva preview 的契约 0；历史 Release 的安装要求不能用于判断本分支兼容性。

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
（函数接口版本 1，`context: "workspace"`；传输协议和能力协商版本为 0），Java Support 在启动 JDT LS 前调用它，只接受 `java.import.gradle.` 等白名单前缀内的键。
后端只读取工作区里的文件，不运行 Gradle、不写任何文件：

| 来源 | 导出的键 |
| --- | --- |
| 环境变量 `GRADLE_USER_HOME`（绝对路径） | `java.import.gradle.user.home` |
| `gradle.properties` 的 `org.gradle.java.home`（绝对路径） | `java.import.gradle.java.home` |
| `gradle.properties` 的 `org.gradle.jvmargs` | `java.import.gradle.jvmArguments` |

`gradle.properties` 按 Gradle 的真实优先级合并：Gradle User Home 高于项目根（[官方规则](https://docs.gradle.org/current/userguide/build_environment.html#sec:gradle_configuration_properties)）。`workspaceRoot` 必须落在已打开的本地工作区文件夹内，
否则函数拒绝（`gradle.invalidRoot`）。工具栏的 Offline 与 Gradle User Home 选项只保存在宿主里，插件后端读不到，
所以它们不再传给 JDT LS，需要宿主把已存选项交给插件函数后才能恢复。后端用 Lithe 找到的 Java（8 或更新版本）运行，初始堆 16 MiB、最大堆 128 MiB；此限制不改变 Gradle 或 JDT LS 的堆配置。
可选属性文件不存在时正常继续；不可读、非普通文件、格式损坏或超过 256 KiB 时返回分类失败，不用默认值掩盖配置问题。

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

相对已发布的 0.1.2，此次契约迁移要求更换宿主：旧版 macOS Lithe 不能安装当前包。
按仓库版本规则记为 1.0.0（重大兼容性变化）；用户需先换用配套 Viva preview，再安装新包。
设置键、Gradle 的最低版本与项目文件没有迁移。当前没有稳定宿主支持这份契约，发布时必须为预发布；发布为草稿预发布，下载校验后由维护者公开。


本分支的清单、构建模型、依赖文档及函数协商均为当前契约 0。需要配套 Viva preview，尚未发布到 Store。
需要包含主仓库 [#1884](https://github.com/1lck/Lithe-IDEA/pull/1884) 的 Viva 客户端（修订 `607f00967d70a7017d49805183d0d2e6ffdf1c0d` 或更新）及 Java Support 1.1.0。通过宿主的“从磁盘安装插件”选择 ZIP；不要用本分支覆盖已发布的同版本发行包。
后端 JAR 与声明式脚本没有平台专属二进制，`-darwin.zip` 与 `-windows.zip` 使用完全相同的归档字节。两端真实验证范围见下文；文件名本身不代表运行验收。

## 开发

```text
io.github.lithe-idea.gradle-build/plugin.json         # 插件描述，目录名必须等于插件 id
io.github.lithe-idea.gradle-build/lithe.init.gradle   # 初始化脚本，导出模型和依赖树
backend/                                              # languageImport.settings 后端（Java），打包成 lib/lithe-gradle-backend.jar
vendor/lithe-plugin-sdk-java/                         # 固定版本的官方 Java SDK 源码（sdk.lock.json 逐文件校验，编译进后端 jar）
io.github.lithe-idea.gradle-build/icons/              # 工具窗口和工具栏图标（来源见 NOTICE）
io.github.lithe-idea.gradle-build/templates/java/     # New Project 的 Gradle Java 项目模板（Kotlin/Groovy DSL、示例代码）
test/fixtures/multi/                                  # 两个子项目的示例构建，供集成测试使用
scripts/package.mjs                                   # 打包成 dist/gradle-build-<版本>-{darwin,windows}.zip
scripts/test.mjs                                      # 用真实 Gradle 运行清单里的命令并检查输出
scripts/test-backend.mjs                              # 经 stdio 驱动后端 jar，测试 languageImport.settings（不需要 Gradle）
.github/workflows/ci.yml                              # PR 时打包、用 Gradle 7.6 和 9.6.1 测试，并用 Lithe Store 的规则检查
.github/workflows/release.yml                         # 推送 v<版本> 标签时发布 GitHub Release
```

本地需要 Node.js 22+（只运行脚本）、JDK 17+ 和 Gradle（还需要 `zip`）；打包用 JDK 自带的 `javac` 和 `jar` 编译后端，不需要 Maven：

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
`dist/package/io.github.lithe-idea.gradle-build` 即可安装本地开发包（兼容 Viva 客户端按社区插件信任流程确认安装）。

`plugin.json` 与插件开发资料只以 [Rust Core 的 shared/plugins](https://github.com/Lithe-IDEA/Lithe-core-rust/tree/main/shared/plugins) 为准。
本分支 Java SDK 固定到 Core `0be1d34f8926fc284a23874a4f6a57a14e339de8`，源码原样保存于 vendor，
`sdk.lock.json` 逐文件校验来源与 SHA-256；`node scripts/sdk/verify-sdk.mjs` 可离线校验。
SDK 的旧日志注释仍提及版本 1，实际协商实现使用版本 0；插件没有修改官方 SDK。

## 诊断日志

后端通过官方 SDK 上报结构化操作结果，宿主统一写入插件通道；插件不自建日志文件。
`languageImport.settings` 是高频读取，关闭成功记录，失败保留一次 ERROR。当前没有降级或恢复分支。
分类标识为 `gradle.invalidRoot`、`gradle.noWorkspaceContext`、`gradle.propertiesUnreadable`、`gradle.propertiesTooLarge`、`gradle.propertiesInvalid`；
日志不包含路径、属性值或构建输出。Java SDK 握手及生命周期由宿主记录。

声明式模型与依赖命令由宿主观察，在 `plugins/io.github.lithe-idea.gradle-build/host` 通道记录一次终态，
成功为 INFO，失败为 ERROR，取消不记录。构建、运行、测试的输出仍属于各自的工作流界面。
工作流 JSON 是返回数据，不是日志；插件包只读，输出位置由宿主提供。

后端脚本测试覆盖成功抑制、真实失败唯一性、可选文件缺失及损坏/超大属性文件，也覆盖主动中止与异常大报文后的进程清理。
驱动限制帧 16 MiB、stderr 尾部 64 KiB、诊断 1000 条；Windows 用系统进程树终止，避免对负 PID 的 Unix 操作失效后留下 JVM。
这些生命周期回归已在实际 Java 8 和原生 Windows 的 Java 8 后端运行。
既有测试驱动的未使用 Maven 分支另见 [#1880](https://github.com/1lck/Lithe-IDEA/issues/1880)。
同一迁移后 JAR、同一 Java 8、六对交错测量，仅改变 JVM 堆选项：初始化并执行八次真实配置查询后的 RSS 中位数从
45.98 MiB 变为 43.80 MiB（-4.72%，benchstat p=0.002）；初始化加八次查询的时间为 78.39/78.44 ms，无显著差异（p=0.485）。
这是配置后端的单点 RSS，不是峰值或整套 Java 支持的内存；128 MiB 是 Java 堆上限，不是进程总内存上限。
JAR 入口开关由 Java 工具定义提供；需要配套 Viva 经 Core 实例化该模板。SDK 测试验证包中的 JVM 选项与函数协议，
真实 Viva 集成另行验证工具模板、配置回读与中转无超时。

这些测试不能替代目标平台原生日志窗口的逐项验收；未执行的启动失败、取消与窗口验收应在交付说明中单列。

## 发布新版本

1. 修改 `plugin.json` 的 `version`（例如 `0.2.0`），合入 `main`。
2. 推送同名标签：

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. `Release` 工作流会核对标签与版本、打包、测试并创建草稿预发布（维护者下载校验后公开）（说明里附 SHA-256）；当前契约只由 Viva preview 支持，不能发布为稳定版。
4. 当前版本保持预发布，不自动进入市场；宿主稳定兼容性与两平台验收完成后，再按 Lithe Store 的规则准备稳定发行。

## 许可

[Apache-2.0](LICENSE)。图标来自 IntelliJ Platform，见 [NOTICE](NOTICE)。
