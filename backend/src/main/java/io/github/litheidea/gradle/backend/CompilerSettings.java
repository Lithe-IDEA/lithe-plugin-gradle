package io.github.litheidea.gradle.backend;

import io.github.litheidea.plugin.sdk.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Edits a canonical native Gradle DSL tail. Gradle owns project and compiler discovery; arbitrary
 * Groovy/Kotlin is never parsed or rewritten here.
 */
final class CompilerSettings {
  private static final int LIMIT = 2 * 1024 * 1024;
  private static final String BEGIN = "// <lithe-java-compiler>\n",
      END = "// </lithe-java-compiler>\n";
  private static final Map<String, Map<String, Binding>> BINDINGS = new ConcurrentHashMap<>();

  private static final class Binding {
    final Path path;
    final boolean root;
    final boolean release;

    Binding(Path p, boolean r, boolean v) {
      path = p;
      root = r;
      release = v;
    }
  }

  private CompilerSettings() {}

  static Map<String, Object> object(Object value) {
    if (!(value instanceof Map))
      throw new PluginError("gradle.invalidSettings", "Expected an object.");
    return (Map<String, Object>) value;
  }

  static List<?> list(Object value) {
    return value instanceof List ? (List<?>) value : Collections.emptyList();
  }

  static String text(Object value) {
    return value == null ? "" : value.toString();
  }

  static String local(boolean zh, String en, String cn) {
    return zh ? cn : en;
  }

  static Map<String, Object> map(Object... values) {
    Map<String, Object> answer = new LinkedHashMap<>();
    for (int i = 0; i < values.length; i += 2) answer.put((String) values[i], values[i + 1]);
    return answer;
  }

  static String digest(byte[] bytes) throws Exception {
    StringBuilder out = new StringBuilder("sha256:");
    for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes))
      out.append(String.format(Locale.ROOT, "%02x", b & 255));
    return out.toString();
  }

  static Path root(CallContext context) throws Exception {
    if (context.workspaceContext() == null) throw new IOException("A workspace is required.");
    Map<String, Object> response =
        context.host().workspace().getFolders(context.workspaceContext()).get(10, TimeUnit.SECONDS);
    return Paths.get(text(object(list(response.get("folders")).get(0)).get("path"))).toRealPath();
  }

  static byte[] bytes(Path path) throws Exception {
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return new byte[0];
    if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > LIMIT)
      throw new IOException("The native Gradle source is not a bounded regular file.");
    try (InputStream in = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS);
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      for (int n; (n = in.read(buffer)) != -1; ) {
        if (out.size() + n > LIMIT)
          throw new IOException("The native Gradle source exceeds its limit.");
        out.write(buffer, 0, n);
      }
      return out.toByteArray();
    }
  }

  private static String quote(Object value) {
    return Json.stringify(text(value).replace('\\', '/')).replace("$", "\\$");
  }

  /**
   * The metadata is verified against the entire canonical DSL tail. A user edit to that tail is
   * never mistaken for an editable stored preference.
   */
  static Map<String, Object> own(String source, boolean root, boolean kotlin) throws Exception {
    int at = source.lastIndexOf(BEGIN);
    if (at < 0) return new LinkedHashMap<>();
    if (at > 0 && source.charAt(at - 1) != '\n')
      throw new IOException("The native compiler block has been edited. Review it before saving.");
    int dataEnd = source.indexOf('\n', at + BEGIN.length());
    if (dataEnd < 0) throw new IOException("The native compiler block is incomplete.");
    String line = source.substring(at + BEGIN.length(), dataEnd);
    if (!line.startsWith("// "))
      throw new IOException("The native compiler block metadata was edited.");
    Map<String, Object> values = object(Json.parse(line.substring(3)));
    if (!source.substring(at).equals(block(values, root, kotlin)))
      throw new IOException(
          "The native compiler block was edited or is no longer the final statement. Review it"
              + " before saving.");
    return new LinkedHashMap<>(values);
  }

  static String block(Map<String, Object> values, boolean root, boolean kotlin) throws Exception {
    if (values.isEmpty()) return "";
    StringBuilder out =
        new StringBuilder(BEGIN).append("// ").append(Json.stringify(values)).append('\n');
    if (root) out.append("allprojects {\n");
    if (values.containsKey("target")
        || values.containsKey("release")
        || values.containsKey("debug")
        || values.containsKey("arguments")) {
      out.append(
          kotlin
              ? "tasks.withType<org.gradle.api.tasks.compile.JavaCompile>().configureEach {\n"
              : "tasks.withType(org.gradle.api.tasks.compile.JavaCompile).configureEach {\n");
      String inheritedKey = root ? "litheCompilerInherited.root" : "litheCompilerInherited.module";
      if (kotlin)
        out.append(
                "val lithePreviousTarget = options.release.orNull?.toString() ?:"
                    + " targetCompatibility\n"
                    + "extensions.extraProperties.set(")
            .append(quote(inheritedKey))
            .append(
                ", if (lithePreviousTarget.startsWith(\"1.\")) lithePreviousTarget.substring(2)"
                    + " else lithePreviousTarget)\n");
      else
        out.append(
                "def lithePreviousTarget = options.release.orNull?.toString() ?:"
                    + " targetCompatibility\n"
                    + "extensions.extraProperties.set(")
            .append(quote(inheritedKey))
            .append(
                ", lithePreviousTarget.startsWith('1.') ? lithePreviousTarget.substring(2) :"
                    + " lithePreviousTarget)\n");
      if (values.containsKey("target")) {
        String target = text(values.get("target"));
        if (!target.matches("(?:[1-9]|1[0-9]|2[0-6])"))
          throw new IOException("Invalid Java target.");
        out.append("sourceCompatibility = ")
            .append(quote(target))
            .append('\n')
            .append("targetCompatibility = ")
            .append(quote(target))
            .append('\n');
        if (Boolean.TRUE.equals(values.get("release")))
          out.append("options.release.set(").append(target).append(")\n");
      }
      if (Boolean.FALSE.equals(values.get("release"))) out.append("options.release.unset()\n");
      if (values.containsKey("debug"))
        out.append(kotlin ? "options.isDebug = " : "options.debug = ")
            .append(Boolean.TRUE.equals(values.get("debug")))
            .append('\n');
      if (values.containsKey("arguments")) {
        out.append("options.compilerArgs = ").append(kotlin ? "mutableListOf(" : "[");
        boolean first = true;
        for (Object arg : list(values.get("arguments"))) {
          if (!first) out.append(", ");
          first = false;
          out.append(quote(arg));
        }
        out.append(kotlin ? ")\n" : "]\n");
      }
      out.append("}\n");
    }
    if (values.containsKey("libraries")) {
      out.append(
          kotlin
              ? "plugins.withId(\"java\") { dependencies.add(\"implementation\", files("
              : "plugins.withId('java') { dependencies.add('implementation', files(");
      boolean first = true;
      for (Object jar : list(values.get("libraries"))) {
        if (!first) out.append(", ");
        first = false;
        out.append(quote(jar));
      }
      out.append(")) }\n");
    }
    if (root) out.append("}\n");
    return out.append(END).toString();
  }

  private static void choice(List<Object> options, Object value) {
    if (value != null
        && !value.toString().isEmpty()
        && options.stream().noneMatch(option -> value.equals(object(option).get("value"))))
      options.add(map("value", value, "title", value.toString()));
  }

  private static Object nullable(Object value) {
    return value == null || value.toString().isEmpty() ? null : value;
  }

  private static Map<String, Object> field(
      boolean zh,
      String id,
      String en,
      String cn,
      String kind,
      Object raw,
      Object effective,
      Object options,
      String help) {
    if ("enum".equals(kind)) {
      choice((List<Object>) options, raw);
      choice((List<Object>) options, effective);
    }
    return map(
        "id",
        id,
        "title",
        local(zh, en, cn),
        "description",
        help,
        "kind",
        kind,
        "value",
        raw,
        "effectiveValue",
        effective,
        "effectiveSource",
        local(zh, "Gradle JavaCompile model", "Gradle JavaCompile 生效模型"),
        "options",
        options);
  }

  static Object read(Map<String, Object> params, CallContext context, boolean libraries)
      throws Exception {
    Path workspace = root(context);
    Map<String, Object> environment = object(params.get("context"));
    boolean zh = text(environment.get("language")).startsWith("zh");
    List<Object> sources = new ArrayList<>();
    Map<String, Binding> bindings = new LinkedHashMap<>();
    Set<Path> seen = new HashSet<>();
    long total = 0;
    for (Object build : list(environment.get("builds")))
      for (Object value : list(object(object(build).get("model")).get("projects"))) {
        context.throwIfCancelled();
        Map<String, Object> project = object(value), properties = object(project.get("properties"));
        Object buildFile = properties.get("compiler.buildFile");
        if (buildFile == null) continue;
        Path path = Paths.get(text(buildFile));
        if (!path.isAbsolute()) path = workspace.resolve(path);
        path = path.normalize();
        if (!path.startsWith(workspace) || !path.getParent().toRealPath().startsWith(workspace))
          throw new IOException("The Gradle source lies outside the workspace.");
        if (!seen.add(path)) continue;
        if (seen.size() > 1024) throw new IOException("Too many Gradle settings sources.");
        boolean projectRoot = ":".equals(properties.get("path")),
            kotlin = path.toString().endsWith(".kts");
        byte[] bytes = bytes(path);
        total += bytes.length;
        if (total > 8L * 1024 * 1024)
          throw new IOException("Project settings exceed the total read limit.");
        String source = new String(bytes, StandardCharsets.UTF_8);
        Map<String, Object> raw = own(source, projectRoot, kotlin);
        List<Object> fields = new ArrayList<>();
        if (libraries) {
          fields.add(
              field(
                  zh,
                  "libraries",
                  "Referenced JAR files",
                  "引用的 JAR 文件",
                  "fileList",
                  raw.get("libraries"),
                  raw.get("libraries"),
                  Collections.emptyList(),
                  local(
                      zh,
                      "Adds native implementation(files(...)) dependencies. Existing build logic is"
                          + " preserved.",
                      "添加原生 implementation(files(...)) 依赖；保留已有构建逻辑。")));
        } else {
          List<Object> options = new ArrayList<>();
          for (int i = 1; i <= 26; i++)
            options.add(map("value", Integer.toString(i), "title", Integer.toString(i)));
          fields.add(
              field(
                  zh,
                  "target",
                  "Target bytecode",
                  "目标字节码",
                  "enum",
                  raw.get("target"),
                  nullable(properties.get("compiler.target")),
                  options,
                  local(
                      zh,
                      "The native Gradle DSL sets JavaCompile source and target together. The"
                          + " compiler JDK must support the chosen target.",
                      "原生 Gradle DSL 同时设置 JavaCompile 的 source 和 target；编译 JDK 必须支持所选目标。")));
          if (projectRoot) {
            fields.add(
                field(
                    zh,
                    "release",
                    "Use --release",
                    "使用 --release",
                    "boolean",
                    raw.get("release"),
                    properties.containsKey("compiler.releaseEnabled")
                        ? Boolean.valueOf(text(properties.get("compiler.releaseEnabled")))
                        : null,
                    Collections.emptyList(),
                    local(
                        zh,
                        "Restricts JDK APIs as well as bytecode for Java 9 and newer.",
                        "Java 9 及更新版本同时限制 JDK API 和字节码。")));
            fields.add(
                field(
                    zh,
                    "debug",
                    "Generate debugging information",
                    "生成调试信息",
                    "boolean",
                    raw.get("debug"),
                    properties.containsKey("compiler.debug")
                        ? Boolean.valueOf(text(properties.get("compiler.debug")))
                        : null,
                    Collections.emptyList(),
                    ""));
            fields.add(
                field(
                    zh,
                    "arguments",
                    "Additional compiler arguments",
                    "附加编译参数",
                    "stringList",
                    raw.get("arguments"),
                    properties.containsKey("compiler.arguments")
                        ? Json.parse(text(properties.get("compiler.arguments")))
                        : null,
                    Collections.emptyList(),
                    local(zh, "One compiler argument per line.", "每行一个编译参数。")));
          }
        }
        if (!libraries && properties.containsKey("compiler.inheritedTarget"))
          for (Object field : fields)
            if ("target".equals(object(field).get("id"))) {
              object(field).put("inheritedValue", properties.get("compiler.inheritedTarget"));
              choice(
                  (List<Object>) object(field).get("options"),
                  properties.get("compiler.inheritedTarget"));
            }
        String relative = workspace.relativize(path).toString().replace(File.separatorChar, '/'),
            id = "gradle" + digest(relative.getBytes(StandardCharsets.UTF_8)).substring(7);
        bindings.put(
            id,
            new Binding(
                path,
                projectRoot,
                Boolean.parseBoolean(text(properties.get("compiler.releaseEnabled")))));
        sources.add(
            map(
                "id",
                id,
                "group",
                libraries ? "libraries" : projectRoot ? "project" : "modules",
                "title",
                project.get("name"),
                "path",
                relative,
                "revision",
                bytes.length == 0 && !Files.exists(path) ? "missing" : digest(bytes),
                "writable",
                true,
                "fields",
                fields));
      }
    if (sources.isEmpty())
      throw new PluginError("gradle.noJavaProject", "No Gradle Java project is available.");
    synchronized (BINDINGS) {
      if (BINDINGS.size() >= 32 && !BINDINGS.containsKey(workspace.toString()))
        throw new IOException("Too many native settings sessions.");
      BINDINGS.put(workspace.toString(), bindings);
    }
    return map(
        "format",
        "litheSettingsSources",
        "version",
        0,
        "title",
        libraries
            ? local(zh, "Gradle Libraries", "Gradle 库")
            : local(zh, "Gradle Java Compiler", "Gradle Java 编译器"),
        "groups",
        libraries
            ? Collections.singletonList(
                map(
                    "id",
                    "libraries",
                    "title",
                    local(zh, "Local JAR dependencies", "本地 JAR 依赖"),
                    "layout",
                    "form"))
            : Arrays.asList(
                map(
                    "id",
                    "project",
                    "title",
                    local(zh, "Project defaults", "项目默认设置"),
                    "layout",
                    "form"),
                map(
                    "id",
                    "modules",
                    "title",
                    local(zh, "Per-module bytecode", "按模块设置字节码"),
                    "rowTitle",
                    local(zh, "Module", "模块"),
                    "layout",
                    "table")),
        "sources",
        sources);
  }

  static Object edit(Map<String, Object> params, CallContext context) throws Exception {
    Path workspace = root(context);
    String id = text(params.get("sourceID"));
    Map<String, Binding> bindings = BINDINGS.get(workspace.toString());
    Binding binding = bindings == null ? null : bindings.get(id);
    if (binding == null || !binding.path.getParent().toRealPath().startsWith(workspace))
      throw new IOException("Reload settings before saving.");
    byte[] original = bytes(binding.path);
    String revision =
        original.length == 0 && !Files.exists(binding.path) ? "missing" : digest(original);
    if (!revision.equals(params.get("revision")))
      throw new IOException("The Gradle source changed outside this editor.");
    String source = new String(original, StandardCharsets.UTF_8);
    boolean kotlin = binding.path.toString().endsWith(".kts");
    Map<String, Object> values = own(source, binding.root, kotlin);
    Map<String, Object> edits = object(params.get("values"));
    for (Map.Entry<String, Object> edit : edits.entrySet()) {
      String key = edit.getKey();
      Object value = edit.getValue();
      if (!Arrays.asList("target", "release", "debug", "arguments", "libraries").contains(key))
        throw new IOException("Unknown native setting.");
      if (value == null) {
        values.remove(key);
        if (key.equals("target")) values.remove("release");
      } else values.put(key, value);
    }
    if (edits.containsKey("target")
        && edits.get("target") != null
        && !edits.containsKey("release")
        && !values.containsKey("release")) values.put("release", binding.release);
    for (Object value : list(values.get("libraries"))) {
      Path jar = Paths.get(text(value));
      if (!jar.isAbsolute()) jar = binding.path.getParent().resolve(jar);
      if (!Files.isRegularFile(jar) || !jar.toString().toLowerCase(Locale.ROOT).endsWith(".jar"))
        throw new IOException("Choose an existing JAR file.");
    }
    int at = source.lastIndexOf(BEGIN);
    if (at >= 0) source = source.substring(0, at);
    String generated = block(values, binding.root, kotlin);
    if (!source.isEmpty() && !source.endsWith("\n")) source += "\n";
    byte[] replacement = (source + generated).getBytes(StandardCharsets.UTF_8);
    if (replacement.length > LIMIT) throw new IOException("The Gradle source exceeds its limit.");
    context.throwIfCancelled();
    Path stage = Paths.get(text(params.get("outputFile")));
    if (!Files.isRegularFile(stage, LinkOption.NOFOLLOW_LINKS))
      throw new IOException("The staging file no longer exists.");
    try (OutputStream out =
        Files.newOutputStream(
            stage,
            StandardOpenOption.WRITE,
            StandardOpenOption.TRUNCATE_EXISTING,
            LinkOption.NOFOLLOW_LINKS)) {
      context.throwIfCancelled();
      out.write(replacement);
    }
    return map(
        "format",
        "litheSettingsSourceEdit",
        "version",
        0,
        "sourceID",
        id,
        "revision",
        digest(replacement),
        "changed",
        !Arrays.equals(original, replacement));
  }
}
