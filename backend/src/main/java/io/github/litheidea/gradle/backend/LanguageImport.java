package io.github.litheidea.gradle.backend;

import io.github.litheidea.plugin.sdk.Backend;
import io.github.litheidea.plugin.sdk.CallContext;
import io.github.litheidea.plugin.sdk.Host;
import io.github.litheidea.plugin.sdk.Protocol;
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
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

/** Supplies Gradle's effective import configuration to language plugins. */
final class LanguageImport {
    static final String FUNCTION = "languageImport.settings";
    private static final String CHANGED = "languageImport.settingsChanged";
    private static final String PROPERTIES = "gradle.properties";
    private static final long MAX_PROPERTIES_BYTES = 256 * 1024;

    private final Backend backend;
    private final Host host;
    private final Map<String, String> environment;
    private final Map<List<Object>, Observation> observations = new ConcurrentHashMap<>();

    LanguageImport(Backend backend, Map<String, String> environment) {
        this.backend = backend;
        this.host = backend.host();
        this.environment = environment;
    }

    Object handle(Map<String, Object> params, CallContext call) throws Exception {
        String requested = Json.string(params, "workspaceRoot");
        if (requested == null || !Paths.get(requested).isAbsolute()) {
            throw new PluginError("gradle.invalidRoot", "workspaceRoot must be an absolute path.");
        }
        Map<String, Object> workspace = call.workspaceContext();
        if (workspace == null) {
            throw new PluginError("gradle.noWorkspaceContext", "The call carries no workspace context.");
        }
        Path root = Paths.get(requested).toRealPath();
        Map<String, Object> answer = call.host().workspace().getFolders(workspace).get(10, TimeUnit.SECONDS);
        Path folder = containingFolder(root, answer.get("folders"));
        if (folder == null) {
            throw new PluginError("gradle.invalidRoot", "workspaceRoot is not inside an open workspace folder.");
        }
        call.throwIfCancelled();
        if (!isGradleRoot(root)) {
            return Collections.singletonMap("settings", Collections.emptyMap());
        }

        String relative = folder.relativize(root).toString().replace(java.io.File.separatorChar, '/');
        String buildRoot = relative.isEmpty() ? "." : relative;
        boolean optionsAvailable = host.supports(Protocol.HOST_BUILD_GET_OPTIONS).get(10, TimeUnit.SECONDS);
        String consumer = call.callerPluginId();
        if (consumer == null || !host.supports(Protocol.HOST_BUILD_WATCH_CONFIGURATION).get(10, TimeUnit.SECONDS)) {
            if (consumer != null) {
                backend.diagnostics().degraded(FUNCTION, "gradle.configurationWatchUnavailable");
            }
            return settings(root, options(call.host(), workspace, buildRoot, optionsAvailable));
        }

        List<Object> key = Arrays.asList(workspace.get("contextID"), workspace.get("generation"), consumer);
        Observation observation = observations.computeIfAbsent(key, ignored -> new Observation(workspace, consumer));
        try {
            return observation.read(root, buildRoot, optionsAvailable);
        } catch (Exception error) {
            // A malformed properties file can be corrected while its watch is active.
            if (!observation.hasWatch() && observations.remove(key, observation)) {
                observation.close();
            }
            throw error;
        }
    }

    /** Drop plugin-side state when the host ends a context and releases its watches. */
    void contextsChanged(Object ignored) throws Exception {
        // Only prune observations known before the asynchronous host read.
        Map<List<Object>, Observation> previous = new HashMap<>(observations);
        if (previous.isEmpty()) {
            return;
        }
        Object result = host.workspace().listContexts().get(10, TimeUnit.SECONDS).get("contexts");
        if (!(result instanceof List)) {
            return;
        }
        previous.forEach((key, observation) -> {
            boolean open = ((List<?>) result).stream().anyMatch(value -> {
                if (!(value instanceof Map)) {
                    return false;
                }
                Map<?, ?> context = (Map<?, ?>) value;
                Object generation = context.get("generation");
                return key.get(0).equals(context.get("contextID")) && generation instanceof Number
                        && ((Number) key.get(1)).longValue() == ((Number) generation).longValue();
            });
            if (!open && observations.remove(key, observation)) {
                observation.close();
            }
        });
    }

    private static Path containingFolder(Path root, Object folders) throws IOException {
        if (folders instanceof List) {
            for (Object folder : (List<?>) folders) {
                Object path = folder instanceof Map ? ((Map<?, ?>) folder).get("path") : null;
                if (path instanceof String) {
                    Path candidate = Paths.get((String) path).toRealPath();
                    if (root.startsWith(candidate)) {
                        return candidate;
                    }
                }
            }
        }
        return null;
    }

    private static boolean isGradleRoot(Path root) {
        return Arrays.asList("settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts")
                .stream().anyMatch(marker -> Files.isRegularFile(root.resolve(marker)));
    }

    private static Map<String, Object> options(
            Host host, Map<String, Object> workspace, String root, boolean available) throws Exception {
        if (!available) {
            return Collections.emptyMap();
        }
        return Json.object(host.build().getOptions(workspace, "gradle", root).get(10, TimeUnit.SECONDS).get("options"));
    }

    private Path userHome(Path root, Map<String, Object> options) {
        String selected = Json.string(options, "gradleUserHome");
        if (selected != null && !selected.isEmpty()) {
            return root.resolve(selected).normalize();
        }
        String value = environment.get("GRADLE_USER_HOME");
        if (value != null && !value.isEmpty() && Paths.get(value).isAbsolute()) {
            return Paths.get(value).normalize();
        }
        return Paths.get(System.getProperty("user.home"), ".gradle").normalize();
    }

    /** User-home properties override project properties; the toolbar overrides the environment. */
    private Map<String, Object> settings(Path root, Map<String, Object> options) {
        Path home = userHome(root, options);
        Properties merged = new Properties();
        load(merged, root.resolve(PROPERTIES));
        load(merged, home.resolve(PROPERTIES));
        Map<String, Object> settings = new LinkedHashMap<>();
        settings.put("java.import.gradle.offline.enabled", Boolean.TRUE.equals(options.get("offline")));
        settings.put("java.import.gradle.user.home", home.toString());
        String javaHome = merged.getProperty("org.gradle.java.home");
        // JDT LS merges updates into its existing preferences. Send an explicit
        // reset when a property is removed so the previous import value clears.
        settings.put("java.import.gradle.java.home",
                javaHome != null && !javaHome.isEmpty() && Paths.get(javaHome).isAbsolute() ? javaHome : "");
        String jvmArguments = merged.getProperty("org.gradle.jvmargs", "");
        settings.put("java.import.gradle.jvmArguments",
                jvmArguments.isEmpty() ? Collections.emptyList() : jvmArguments);
        return Collections.singletonMap("settings", settings);
    }

    // Each language consumer gets a single current snapshot per workspace.
    // Serialize the initial read and change processing so a slow refresh cannot
    // replace a newer snapshot. Java records changes received during collection.
    private final class Observation {
        private final Map<String, Object> workspace;
        private final String consumer;
        private Path root;
        private String buildRoot;
        private boolean optionsAvailable;
        private Path watchedRoot;
        private Path watchedHome;
        private Host.Subscription watch;
        private Map<String, Object> delivered;
        private boolean closed;

        Observation(Map<String, Object> workspace, String consumer) {
            this.workspace = workspace;
            this.consumer = consumer;
        }

        synchronized Map<String, Object> read(Path root, String buildRoot, boolean optionsAvailable) throws Exception {
            if (closed) {
                throw new PluginError("gradle.workspaceClosed", "The workspace context closed.");
            }
            this.root = root;
            this.buildRoot = buildRoot;
            this.optionsAvailable = optionsAvailable;
            Map<String, Object> value = snapshot();
            delivered = value;
            return value;
        }

        private Map<String, Object> snapshot() throws Exception {
            Map<String, Object> current = options(host, workspace, buildRoot, optionsAvailable);
            for (int attempt = 0; attempt < 3; attempt++) {
                Path home = userHome(root, current);
                if (watch != null && root.equals(watchedRoot) && home.equals(watchedHome)) {
                    return settings(root, current);
                }
                Host.Subscription replacement = host.build().watchConfiguration(workspace,
                        Arrays.asList(root.resolve(PROPERTIES).toString(), home.resolve(PROPERTIES).toString()),
                        this::changed).get(10, TimeUnit.SECONDS);
                disposeWatch();
                watch = replacement;
                watchedRoot = root;
                watchedHome = home;
                // Read again after registration so a file or option changed
                // while the watch was being installed cannot be missed.
                current = options(host, workspace, buildRoot, optionsAvailable);
            }
            if (userHome(root, current).equals(watchedHome)) {
                return settings(root, current);
            }
            throw new PluginError("gradle.configurationChanging", "Gradle configuration changed repeatedly during the read.");
        }

        private synchronized void changed(Host.Event event) throws Exception {
            if (closed || watch == null || !watch.id().equals(event.subscriptionId())) {
                return;
            }
            if ("watchFailed".equals(Json.object(event.event()).get("type"))) {
                disposeWatch();
                backend.diagnostics().degraded(FUNCTION, "gradle.configurationWatchReopened");
            }
            Map<String, Object> value = snapshot();
            if (Objects.equals(delivered, value)) {
                return;
            }
            Map<String, Object> request = new LinkedHashMap<>();
            request.put("pluginID", consumer);
            request.put("functionID", CHANGED);
            request.put("params", value);
            request.put("timeoutMilliseconds", 10000);
            try {
                host.functions().invoke(workspace, request).get(12, TimeUnit.SECONDS);
                delivered = value;
            } catch (ExecutionException error) {
                // Skip private paths and values in the diagnostic. A later
                // change or the next collection can deliver the full snapshot.
                backend.diagnostics().degraded(CHANGED, "gradle.configurationDeliveryFailed");
            }
        }

        synchronized boolean hasWatch() {
            return watch != null;
        }

        synchronized void close() {
            closed = true;
            disposeWatch();
        }

        private void disposeWatch() {
            if (watch != null) {
                watch.dispose().whenComplete((value, error) -> {
                    if (error != null) {
                        backend.diagnostics().degraded(FUNCTION, "gradle.configurationWatchDisposeFailed");
                    }
                });
                watch = null;
            }
        }
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
