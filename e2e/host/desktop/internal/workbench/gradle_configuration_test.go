//go:build vivahead && darwin

package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/1lck/Lithe-IDEA/desktop/internal/core"
	"github.com/1lck/Lithe-IDEA/desktop/internal/marketplace"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginstate"
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
)

const probeJavaPlugin = "io.github.lithe-idea.java-support"
const probeGradlePlugin = "io.github.lithe-idea.gradle-build"

type probeKernel struct {
	*testKernel
	wrapper string
}

func (k *probeKernel) StartPluginLanguageServer(ctx context.Context, request core.PluginBackendStart) (core.PluginBackendStarted, error) {
	request.Arguments = append([]string{request.ExecutablePath}, request.Arguments...)
	request.ExecutablePath = k.wrapper
	return k.Client.StartPluginLanguageServer(ctx, request)
}

// Only artifact transport is replaced. The Java plugin still verifies the archives
// and resolves the same managed runtime and server as a normal launch.
type probeTransport struct{}

func (probeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	name := "JDT"
	if strings.Contains(r.URL.Path, "OpenJDK") {
		name = "JDK"
	}
	file, err := os.Open(os.Getenv("LITHE_GRADLE_E2E_" + name + "_ARCHIVE"))
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	return &http.Response{StatusCode: 200, Header: make(http.Header), ContentLength: info.Size(), Request: r, Body: file}, nil
}

func TestGradleConfigurationReachesLiveJDT(t *testing.T) {
	stage := t.TempDir()
	capture := filepath.Join(stage, "jdt-input.lsp")
	write := func(path, value string, mode os.FileMode) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), mode); err != nil {
			t.Fatal(err)
		}
	}
	wrapper := filepath.Join(stage, "jdt-stdio")
	write(wrapper, "#!/bin/sh\n/usr/bin/tee \""+capture+"\" | \"$@\"\n", 0o700)
	write(filepath.Join(stage, "prefs", settingsFile), `{"theme":"dark"}`, 0o600)
	prefs := store.At(filepath.Join(stage, "prefs"))
	pluginRoot := filepath.Join(stage, "plugins")
	for _, item := range []struct{ id, env string }{{probeJavaPlugin, "LITHE_GRADLE_E2E_JAVA_PLUGIN"}, {probeGradlePlugin, "LITHE_GRADLE_E2E_PLUGIN"}} {
		path := os.Getenv(item.env)
		data, err := os.ReadFile(filepath.Join(path, "plugin.json"))
		if err != nil {
			t.Fatal(err)
		}
		var manifest struct{ Version string }
		if err := json.Unmarshal(data, &manifest); err != nil {
			t.Fatal(err)
		}
		destination := filepath.Join(pluginRoot, item.id, manifest.Version)
		if err := os.CopyFS(destination, os.DirFS(path)); err != nil {
			t.Fatal(err)
		}
		if err := pluginstate.New(prefs).SetEnabled(item.id, true); err != nil {
			t.Fatal(err)
		}
	}
	root := filepath.Join(stage, "project")
	t.Setenv("JAVA_HOME", os.Getenv("LITHE_GRADLE_E2E_PROJECT_JAVA"))
	homeA := filepath.Join(stage, "gradle-first")
	homeB := filepath.Join(stage, "gradle-second")
	t.Setenv("GRADLE_USER_HOME", homeA)
	t.Setenv("PATH", filepath.Join(os.Getenv("LITHE_GRADLE_E2E_GRADLE_DIR"), "bin")+":"+os.Getenv("PATH"))
	write(filepath.Join(root, "settings.gradle"), "rootProject.name='configuration-probe'\n", 0o600)
	write(filepath.Join(root, "build.gradle"), "plugins { id 'java' }\n", 0o600)
	write(filepath.Join(root, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=file://"+os.Getenv("LITHE_GRADLE_E2E_GRADLE_ARCHIVE")+"\n", 0o600)
	file := filepath.Join(root, "src", "main", "java", "Main.java")
	write(file, "class Main {}\n", 0o600)
	projectProperties := filepath.Join(root, "gradle.properties")
	write(projectProperties, "org.gradle.java.home="+os.Getenv("LITHE_GRADLE_E2E_PROJECT_JAVA")+"\norg.gradle.jvmargs=-Dprobe=project\n", 0o600)
	propertiesA := filepath.Join(homeA, "gradle.properties")
	propertiesB := filepath.Join(homeB, "gradle.properties")
	write(propertiesA, "org.gradle.jvmargs=-Dprobe=first\n", 0o600)
	write(propertiesB, "org.gradle.jvmargs=-Dprobe=second\n", 0o600)
	t.Cleanup(func() {
		for _, home := range []string{homeA, homeB} {
			commandContext, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			command := exec.CommandContext(commandContext, filepath.Join(os.Getenv("LITHE_GRADLE_E2E_GRADLE_DIR"), "bin", "gradle"), "--stop")
			command.Env = append(os.Environ(), "GRADLE_USER_HOME="+home)
			if output, err := command.CombinedOutput(); err != nil {
				t.Errorf("stop Gradle: %v %s", err, output)
			}
			cancel()
		}
	})
	kernel := &probeKernel{&testKernel{Client: core.NewClient()}, wrapper}
	h := newHarnessWithOptions(t, Options{Kernel: kernel, PluginKernel: kernel, Store: prefs, PluginRoot: pluginRoot, Languages: []string{"en"}})
	h.app.plugins.LogDirectory = func(_ context.Context, id string) string {
		directory := filepath.Join(stage, "logs", id)
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return ""
		}
		return directory
	}
	h.app.plugins.RuntimeDownloader = marketplace.NewArchiveDownloader(&http.Client{Transport: probeTransport{}})
	h.open(root)
	instance := buildInstance{BuildInstance: core.BuildInstance{Root: ".", BuildSystemID: "gradle"}}
	data, err := os.ReadFile(filepath.Join(os.Getenv("LITHE_GRADLE_E2E_PLUGIN"), "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	instance.Manifest = data
	save := func(offline, home string) {
		t.Helper()
		option := buildOptionChange{optionID: "offline", value: json.RawMessage(offline)}
		selection := buildOptionChange{optionID: "gradleUserHome", value: json.RawMessage(strconv.Quote(home))}
		done := make(chan error, 1)
		h.app.saveBuildOptionChanges(h.app.project, &instance, []buildOptionChange{option, selection}, nil, func(_ json.RawMessage, err error) { done <- err })
		if err := awaitValueWithin(t, h, 10*time.Second, done, "save toolbar options"); err != nil {
			t.Fatal(err)
		}
	}
	save("true", homeA)
	h.app.openFileAt(h.app.project, file, 1)
	var server *pluginServer
	awaitStateWithin(t, h, 120*time.Second, "JDT LS ready", func() bool {
		server = h.app.pluginServers[probeJavaPlugin]
		if failure := h.app.pluginServerFailed["java"]; failure != nil {
			t.Fatalf("Java startup failed: %s", failure.message)
		}
		if server != nil && server.state == "failed" {
			t.Fatalf("JDT LS failed: %+v", server.logs)
		}
		return server != nil && server.state == "ready"
	})
	session := server.session
	input := func() []map[string]any {
		raw, _ := os.ReadFile(capture)
		var msgs []map[string]any
		for len(raw) > 0 {
			split := bytes.Index(raw, []byte("\r\n\r\n"))
			if split < 0 {
				break
			}
			size := 0
			for line := range strings.SplitSeq(string(raw[:split]), "\r\n") {
				if value, ok := strings.CutPrefix(strings.ToLower(line), "content-length:"); ok {
					size, _ = strconv.Atoi(strings.TrimSpace(value))
				}
			}
			raw = raw[split+4:]
			if size <= 0 || len(raw) < size {
				break
			}
			var m map[string]any
			if json.Unmarshal(raw[:size], &m) == nil {
				msgs = append(msgs, m)
			}
			raw = raw[size:]
		}
		return msgs
	}
	require := func(home, javaHome string, offline bool, jvm string) {
		t.Helper()
		const method = "workspace/didChangeConfiguration"
		awaitStateWithin(t, h, 12*time.Second, fmt.Sprintf("%s %s %t", method, filepath.Base(home), offline), func() bool {
			for _, m := range input() {
				if m["method"] != method {
					continue
				}
				keys := []string{"params", "settings", "java", "import", "gradle"}
				var value any = m
				for _, key := range keys {
					object, _ := value.(map[string]any)
					value = object[key]
				}
				gradle, _ := value.(map[string]any)
				offlineSection, _ := gradle["offline"].(map[string]any)
				userSection, _ := gradle["user"].(map[string]any)
				javaSection, _ := gradle["java"].(map[string]any)
				matched := gradle["jvmArguments"] == jvm
				if jvm == "" {
					args, ok := gradle["jvmArguments"].([]any)
					matched = ok && len(args) == 0
				}
				if userSection["home"] == home && offlineSection["enabled"] == offline && javaSection["home"] == javaHome && matched {
					return true
				}
			}
			return false
		})
		if current := h.app.pluginServers[probeJavaPlugin]; current == nil || current.session != session {
			t.Fatal("JDT LS restarted")
		}
		t.Logf("%s %s %t %q reached JDT LS", method, filepath.Base(home), offline, jvm)
	}
	require(homeA, os.Getenv("LITHE_GRADLE_E2E_PROJECT_JAVA"), true, "-Dprobe=first")
	save("false", homeB)
	require(homeB, os.Getenv("LITHE_GRADLE_E2E_PROJECT_JAVA"), false, "-Dprobe=second")
	write(propertiesB, "org.gradle.jvmargs=-Dprobe=updated\n", 0o600)
	require(homeB, os.Getenv("LITHE_GRADLE_E2E_PROJECT_JAVA"), false, "-Dprobe=updated")
	if err := os.Remove(propertiesB); err != nil {
		t.Fatal(err)
	}
	require(homeB, os.Getenv("LITHE_GRADLE_E2E_PROJECT_JAVA"), false, "-Dprobe=project")
	if err := os.Remove(projectProperties); err != nil {
		t.Fatal(err)
	}
	require(homeB, "", false, "")
}
