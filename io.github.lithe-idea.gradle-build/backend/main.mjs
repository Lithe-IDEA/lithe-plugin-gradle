// Gradle plugin backend: serves `languageImport.settings` to the Java plugin.
import { createBackend, PluginError } from './vendor/lithe-plugin-sdk/index.mjs';
import { registerSettingsFunction } from './settings.mjs';

const backend = createBackend({ name: 'gradle-build', version: '0.1.2' });
registerSettingsFunction(backend, PluginError);
await backend.listen();
