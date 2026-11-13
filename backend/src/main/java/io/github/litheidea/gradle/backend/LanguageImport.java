package io.github.litheidea.gradle.backend;

import io.github.litheidea.plugin.sdk.CallContext;
import io.github.litheidea.plugin.sdk.Json;
import io.github.litheidea.plugin.sdk.PluginError;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

/**
 * The plugin function {@code languageImport.settings} (version 1) that Java
 * Support calls before it starts JDT LS: the import settings Gradle's own
 * configuration files imply. Nothing here runs Gradle or writes a file; the
 * workspace root it is asked about must lie inside an open local workspace
 * folder. Gradle user-home properties take precedence over project properties,
 * as documented by Gradle.
 *
 * <p>{@code GRADLE_USER_HOME} (absolute) becomes {@code java.import.gradle.user.home},
 * {@code org.gradle.java.home} (absolute) {@code java.import.gradle.java.home} and
 * {@code org.gradle.jvmargs} {@code java.import.gradle.jvmArguments}.
 */
final class LanguageImport {
    static final String FUNCTION = "languageImport.settings";
    private static final long MAX_PROPERTIES_BYTES = 256 * 1024;

    private LanguageImport() {}

    /** The function handler. */
    static Object handle(Map<String, Object> params, CallContext context, Map<String, String> environment) throws Exception {
        String requested = Json.string(params, "workspaceRoot");
        if (requested == null || !Paths.get(requested).isAbsolute()) {
            throw new PluginError("gradle.invalidRoot", "workspaceRoot must be an absolute path.");
        }
        Map<String, Object> workspace = context.workspaceContext();
        if (workspace == null) {
            throw new PluginError("gradle.noWorkspaceContext", "The call carries no workspace context.");
        }
        Path root = Paths.get(requested).toRealPath();
        Map<String, Object> answer = context.host().workspace().getFolders(workspace).get(10, TimeUnit.SECONDS);
        if (!insideFolder(root, answer.get("folders"))) {
            throw new PluginError("gradle.invalidRoot", "workspaceRoot is not inside an open workspace folder.");
        }
        context.throwIfCancelled();
        return settings(root, environment);
    }

    private static boolean insideFolder(Path root, Object folders) throws IOException {
        if (!(folders instanceof List)) {
            return false;
        }
        for (Object folder : (List<?>) folders) {
            Object path = folder instanceof Map ? ((Map<?, ?>) folder).get("path") : null;
            if (path instanceof String && root.startsWith(Paths.get((String) path).toRealPath())) {
                return true;
            }
        }
        return false;
    }

    /** The Gradle user home as Gradle resolves it without a command line. */
    static Path userHome(Map<String, String> environment) {
        String value = environment.get("GRADLE_USER_HOME");
        if (value != null && !value.isEmpty() && Paths.get(value).isAbsolute()) {
            return Paths.get(value);
        }
        return Paths.get(System.getProperty("user.home"), ".gradle");
    }

    /** {@code { settings }} for the Gradle build at {@code root}. */
    static Map<String, Object> settings(Path root, Map<String, String> environment) {
        Path home = userHome(environment);
        Properties merged = new Properties();
        load(merged, root.resolve("gradle.properties"));
        load(merged, home.resolve("gradle.properties"));
        Map<String, Object> settings = new LinkedHashMap<>();
        String explicitHome = environment.get("GRADLE_USER_HOME");
        if (explicitHome != null && !explicitHome.isEmpty() && Paths.get(explicitHome).isAbsolute()) {
            settings.put("java.import.gradle.user.home", home.toString());
        }
        String javaHome = merged.getProperty("org.gradle.java.home");
        if (javaHome != null && !javaHome.isEmpty() && Paths.get(javaHome).isAbsolute()) {
            settings.put("java.import.gradle.java.home", javaHome);
        }
        String jvmArguments = merged.getProperty("org.gradle.jvmargs");
        if (jvmArguments != null && !jvmArguments.isEmpty()) {
            settings.put("java.import.gradle.jvmArguments", jvmArguments);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("settings", settings);
        return result;
    }

    /** Missing files are optional; a failed read must never silently select a different JDK. */
    private static void load(Properties target, Path file) {
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class);
            if (!attributes.isRegularFile()) {
                throw new PluginError("gradle.propertiesUnreadable", "Gradle configuration is not a regular file.");
            }
            if (attributes.size() > MAX_PROPERTIES_BYTES) {
                throw new PluginError("gradle.propertiesTooLarge", "Gradle configuration exceeds the read limit.");
            }
            try (InputStream input = Files.newInputStream(file)) {
                // Recheck the bound while reading: the file may grow after stat.
                byte[] bytes = new byte[(int) MAX_PROPERTIES_BYTES + 1];
                int count = 0;
                for (int read; count < bytes.length && (read = input.read(bytes, count, bytes.length - count)) != -1;) {
                    count += read;
                }
                if (count > MAX_PROPERTIES_BYTES) {
                    throw new PluginError("gradle.propertiesTooLarge", "Gradle configuration exceeds the read limit.");
                }
                target.load(new ByteArrayInputStream(bytes, 0, count));
            }
        } catch (NoSuchFileException missing) {
            // log-exempt: expected absence: Gradle properties files are optional.
        } catch (IllegalArgumentException invalid) {
            throw new PluginError("gradle.propertiesInvalid", "Gradle configuration contains an invalid escape.");
        } catch (IOException unreadable) {
            throw new PluginError("gradle.propertiesUnreadable", "Gradle configuration could not be read.");
        }
    }
}
