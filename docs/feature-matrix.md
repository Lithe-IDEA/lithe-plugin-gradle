# 功能验证矩阵

## 从当前文件运行和调试 Java

| 能力 | macOS | Windows | 验证入口 |
| --- | --- | --- | --- |
| 发现 Java 主类及保存可编辑的运行配置 | 已实现，Apple Silicon 无头工作台验证通过 | 已实现，Petclinic 主类发现通过，保存配置待验证 | Spring Petclinic 和 JUnit 5 的 Java 启动类 |
| 通过所属 Gradle 源集构建并运行 | 已实现，Petclinic 首页返回 HTTP 200；JUnit 的控制台发布产物由项目自带任务组装 | 已实现，Windows 11 ARM64 来宾使用 x64 JDK，Petclinic 通过提供者和 Wrapper 构建并返回 HTTP 200 | `scripts/test.mjs` 校验模块依赖、应用参数、正常退出、编译错误和包字节不变 |
| Java 调试器连接及停止 | 已实现，Apple Silicon 无头工作台验证通过 | 已实现，完整工作台验收待验证 | 两个开源项目实测断点和停止 |

Windows 验证使用已构建的 Windows 插件包和相同的 Build Provider 请求，工作台运行按钮及调试连接仍待验证。

## Linux 安装包

| 能力 | Linux ARM64 | Linux x64 | 验证入口 |
| --- | --- | --- | --- |
| 构建与安装包 | [已实现并通过原生 CI](https://github.com/Lithe-IDEA/lithe-plugin-gradle/actions/runs/43619362893) | [已实现并通过原生 CI](https://github.com/Lithe-IDEA/lithe-plugin-gradle/actions/runs/43619362893) | `.github/workflows/ci.yml`、[资源说明](linux-packaging.md) |
| 真实工具/语言服务器流程 | [已通过原生 CI](https://github.com/Lithe-IDEA/lithe-plugin-gradle/actions/runs/43619362893) | [已通过原生 CI](https://github.com/Lithe-IDEA/lithe-plugin-gradle/actions/runs/43619362893) | `scripts/package/` 和现有集成测试 |

跨架构本地包检查通过不等于原生工作流验收。既有平台验证记录保持不变。

## 原生编译设置与本地 JAR

| 能力 | macOS | Windows | 证据 |
| --- | --- | --- | --- |
| 项目默认目标、按模块字节码、继承与显式保存 | implemented / pending | implemented / pending | `scripts/compiler/` 真实引擎回归，检查 class major 52/55；原生完整 UI 验收仍 pending |
| 原生 JAR 引用与编译运行 | implemented / pending | implemented / pending | `scripts/compiler/` 编译外部 JAR 并运行引用它的程序；配置与包的只读边界见 native-settings.md |

2026-11-15：本地 macOS 自动化已通过，不将脚本通过等同于所有交互场景验收。Windows 的实机结果另随 PR 补充。
