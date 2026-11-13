package io.github.litheidea.gradle.backend;

import io.github.litheidea.plugin.sdk.Backend;

/**
 * The plugin backend of the Gradle plugin. It only exports plugin functions to
 * other plugins ({@code languageImport.settings}, see {@link LanguageImport});
 * Gradle itself is run by the host from the commands in plugin.json.
 */
public final class GradleBackend {
    private GradleBackend() {}

    public static void main(String[] arguments) {
        Backend backend = Backend.create("lithe-gradle-backend", version());
        backend.function(LanguageImport.FUNCTION, (params, context) -> LanguageImport.handle(params, context, System.getenv()));
        backend.suppressSuccessDiagnostics(LanguageImport.FUNCTION);
        backend.listen();
    }

    private static String version() {
        String version = GradleBackend.class.getPackage().getImplementationVersion();
        return version == null ? "development" : version;
    }
}
