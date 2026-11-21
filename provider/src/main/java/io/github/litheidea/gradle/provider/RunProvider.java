package io.github.litheidea.gradle.provider;

import com.sun.source.tree.ClassTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import io.github.litheidea.plugin.sdk.Backend;
import io.github.litheidea.plugin.sdk.CallContext;
import io.github.litheidea.plugin.sdk.Json;
import io.github.litheidea.plugin.sdk.PluginError;
import io.github.litheidea.plugin.sdk.Processes;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.lang.model.element.Modifier;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;

/** Discovers Java entrypoints and delegates their compilation and runtime classpath to Gradle. */
public final class RunProvider {
    private static final String RUN = "java-main";
    private static final int MAX_SOURCE_BYTES = 4 * 1024 * 1024;
    private static final int MAX_EXPORT_BYTES = 1024 * 1024;
    private static final int PROGRESS_CHARS = 8 * 1024;
    private final Path workspace;
    private final Path initScript;
    private final boolean chinese;

    private RunProvider(Backend backend, Path initScript) throws IOException {
        var initialize = backend.initializeParams();
        workspace = Path.of(URI.create(Json.string(initialize, "rootUri"))).toRealPath();
        this.initScript = initScript;
        String locale = Json.string(initialize, "locale");
        chinese = locale != null && locale.toLowerCase(Locale.ROOT).startsWith("zh");
    }

    public static void main(String[] args) throws Exception {
        Path lib = Path.of(RunProvider.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getParent();
        Path initScript = lib.getParent().resolve("lithe.run.init.gradle");
        Backend backend = Backend.create("lithe-gradle-run-provider", RunProvider.class.getPackage().getImplementationVersion());
        backend.onRunEntrypoints((params, context) -> new RunProvider(backend, initScript).discover(params));
        backend.onPrepareRun((params, context) -> new RunProvider(backend, initScript).prepare(params, context));
        backend.suppressSuccessDiagnostics("lithe/build/runEntrypoints");
        backend.listen();
    }

    private Map<String, Object> discover(Map<String, Object> params) throws IOException {
        String root = Json.string(params, "root");
        Path instance = buildRoot(root);
        String file = Json.string(params, "file");
        var entrypoints = new ArrayList<Object>();
        for (String main : mainClasses(instance, file)) {
            String name = main.substring(main.lastIndexOf('.') + 1);
            var selection = new LinkedHashMap<String, String>();
            selection.put("file", file);
            selection.put("mainClass", main);
            String value = Json.stringify(selection);
            if (name.getBytes(StandardCharsets.UTF_8).length <= 256
                    && value.getBytes(StandardCharsets.UTF_8).length <= 4096) {
                // Discovery is independent of Gradle startup. The owning source set is
                // checked against the evaluated build during preparation.
                entrypoints.add(Map.of("run", RUN, "name", name, "entrypoint", value,
                        "project", Map.of("name", instance.getFileName().toString(), "path", root)));
            }
            if (entrypoints.size() == 64) break;
        }
        return Map.of("entrypoints", entrypoints);
    }

    private List<String> mainClasses(Path instance, String file) throws IOException {
        Path source = workspace.resolve(file).normalize();
        if (!source.startsWith(instance) || !source.toString().endsWith(".java") || !Files.isRegularFile(source)) {
            return List.of();
        }
        Path realSource = source.toRealPath();
        if (!realSource.startsWith(instance)) return List.of();
        byte[] bytes;
        try (var input = Files.newInputStream(realSource)) {
            bytes = input.readNBytes(MAX_SOURCE_BYTES + 1);
        }
        if (bytes.length > MAX_SOURCE_BYTES) return List.of();
        var javaSource = new SimpleJavaFileObject(source.toUri(), JavaFileObject.Kind.SOURCE) {
            @Override
            public CharSequence getCharContent(boolean ignoreEncodingErrors) {
                return new String(bytes, StandardCharsets.UTF_8);
            }
        };
        var mains = new ArrayList<String>();
        var compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            throw failure("gradle.run.noCompiler", "Select a JDK to discover Java main methods.", "请选择 JDK 以发现 Java 主方法。");
        }
        var diagnostics = new DiagnosticCollector<JavaFileObject>();
        try (var files = compiler.getStandardFileManager(diagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, diagnostics, List.of("-proc:none"), null,
                    List.of(javaSource));
            for (var unit : task.parse()) {
                String prefix = unit.getPackageName() == null ? "" : unit.getPackageName() + ".";
                for (Tree declaration : unit.getTypeDecls()) {
                    if (declaration instanceof ClassTree type && type.getMembers().stream().anyMatch(RunProvider::isMain)) {
                        mains.add(prefix + type.getSimpleName());
                    }
                }
            }
        }
        return mains;
    }

    private Path buildRoot(String root) throws IOException {
        Path instance = workspace.resolve(root).toRealPath();
        if (!instance.startsWith(workspace)) {
            throw failure("gradle.run.invalidRoot", "The Gradle build must be inside the workspace.",
                    "Gradle 构建必须位于工作区内。");
        }
        return instance;
    }

    private static boolean isMain(Tree tree) {
        if (!(tree instanceof MethodTree method) || !method.getName().contentEquals("main")
                || method.getReturnType() == null || !method.getReturnType().toString().equals("void")
                || !method.getModifiers().getFlags().containsAll(List.of(Modifier.PUBLIC, Modifier.STATIC))
                || method.getParameters().size() != 1) {
            return false;
        }
        return switch (method.getParameters().get(0).getType().toString()) {
            case "String[]", "java.lang.String[]" -> true;
            default -> false;
        };
    }

    private Map<String, Object> prepare(Map<String, Object> params, CallContext context) throws IOException {
        String root = Json.string(params, "root");
        Path instance = buildRoot(root);
        Map<String, Object> options = Json.object(params.get("launchOptions"));
        Map<String, Object> entrypoint = Json.object(Json.parse(Json.string(options, "entrypoint")));
        String file = Json.string(entrypoint, "file");
        String main = Json.string(entrypoint, "mainClass");
        if (!mainClasses(instance, file).contains(main)) {
            throw failure("gradle.run.mainChanged", "The selected main method has changed. Choose Current File again.",
                    "所选主方法已更改。请重新从当前文件启动。");
        }

        var environment = new LinkedHashMap<>(System.getenv());
        environment.putAll(stringsByKey(params.get("environment")));
        var command = new ArrayList<String>();
        command.add(gradle(params, instance, environment));
        command.addAll(List.of("--no-daemon", "--console=plain", "--no-configuration-cache", "--no-configure-on-demand"));
        command.addAll(strings(params.get("optionArguments")));
        Path output = Files.createTempFile("lithe-gradle-java-run-", ".json");
        try {
            command.addAll(List.of("--init-script", initScript.toString(), "-Dlithe.runOutput=" + output,
                    "-Dlithe.runFile=" + workspace.resolve(file), "-Dlithe.runLocale=" + (chinese ? "zh" : "en"),
                    ":lithePrepareJavaRun"));
            var result = context.run(command, new Processes.Options().directory(instance).environment(environment)
                    .maxOutputBytes(64 * 1024).onStdout(text -> progress(context, text)).onStderr(text -> progress(context, text)));
            if (result.exitCode() != 0) {
                throw failure("gradle.run.buildFailed", "Gradle compilation failed. See the Run output.",
                        "Gradle 编译失败。请查看运行输出。");
            }
            if (Files.size(output) == 0 || Files.size(output) > MAX_EXPORT_BYTES) {
                throw failure("gradle.run.invalidClasspath", "Gradle did not return a valid runtime classpath.",
                        "Gradle 未返回有效的运行类路径。");
            }
            return launch(root, main, params, options, Json.object(Json.parse(Files.readString(output))));
        } finally {
            Files.deleteIfExists(output);
        }
    }

    private Map<String, Object> launch(String root, String main, Map<String, Object> params, Map<String, Object> options,
            Map<String, Object> exported) {
        var arguments = new ArrayList<>(strings(options.get("runtimeArguments")));
        if (options.get("debug") instanceof Map) {
            var target = Json.object(Json.object(options.get("debug")).get("target"));
            arguments.add("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address="
                    + Json.string(target, "host") + ":" + target.get("port"));
        }
        arguments.addAll(List.of("-cp", Json.string(exported, "classpath"), main));
        arguments.addAll(strings(options.get("arguments")));
        arguments.addAll(strings(params.get("userArguments")));
        String directory = Json.string(options, "workingDirectory");
        if (directory == null) {
            String project = Json.string(exported, "project");
            directory = root.equals(".") ? project : (project.equals(".") ? root : root + "/" + project);
        }
        return Map.of("executable", Map.of("kind", "toolchain", "value", "java"), "arguments", arguments,
                "workingDirectory", directory, "environment", stringsByKey(options.get("environment")));
    }

    private static String gradle(Map<String, Object> params, Path instance, Map<String, String> environment) {
        if (params.get("tool") instanceof Map) {
            String executable = Json.string(Json.object(params.get("tool")), "executable");
            if (executable != null) return executable;
        }
        boolean windows = File.separatorChar == '\\';
        Path wrapper = instance.resolve(windows ? "gradlew.bat" : "gradlew");
        if (Files.isRegularFile(wrapper) && Files.isRegularFile(instance.resolve("gradle/wrapper/gradle-wrapper.properties"))
                && (windows || Files.isExecutable(wrapper))) {
            return wrapper.toString();
        }
        String gradleHome = environment.get("GRADLE_HOME");
        String command = windows ? "gradle.bat" : "gradle";
        if (gradleHome != null && !gradleHome.isBlank()) {
            Path candidate = Path.of(gradleHome, "bin", command);
            if (Files.isRegularFile(candidate) && (windows || Files.isExecutable(candidate))) return candidate.toString();
        }
        if (windows) {
            for (String directory : environment.getOrDefault("PATH", "").split(File.pathSeparator)) {
                if (directory.isBlank()) continue;
                Path candidate = Path.of(directory.replace("\"", ""), command);
                if (Files.isRegularFile(candidate)) return candidate.toString();
            }
        }
        return command;
    }

    private static List<String> strings(Object value) {
        return value instanceof List<?> list ? list.stream().map(String.class::cast).toList() : List.of();
    }

    private static Map<String, String> stringsByKey(Object value) {
        var result = new LinkedHashMap<String, String>();
        if (value instanceof Map<?, ?> values) values.forEach((key, entry) -> result.put((String) key, (String) entry));
        return result;
    }

    private static void progress(CallContext context, String text) {
        for (int start = 0; start < text.length(); start += PROGRESS_CHARS) {
            context.progress(null, null, text.substring(start, Math.min(start + PROGRESS_CHARS, text.length())));
        }
    }

    private PluginError failure(String code, String english, String translated) {
        return new PluginError(code, chinese ? translated : english);
    }
}
