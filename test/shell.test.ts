import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseKubeConfig } from "../src/kubepile.ts";
import {
  detectCurrentShell,
  generateShellCommand,
  installShellIntegration,
  listSourceContextNames,
  shellIntegrationBlock,
  shellRcFile,
  upsertShellIntegrationBlock,
} from "../src/shell.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("generateShellCommand", () => {
  it("writes a full temporary kubeconfig with the requested current context and emits posix shell code", async () => {
    const dir = await mkTempDir();
    const sourcePath = path.join(dir, "config");
    await writeSourceKubeConfig(sourcePath);

    const result = await generateShellCommand("prod", {
      sourcePath,
      tempDir: dir,
      shell: "posix",
    });
    const tempConfig = parseKubeConfig(await readFile(result.kubeConfigPath, "utf8"), result.kubeConfigPath);
    const tempStat = await stat(result.kubeConfigPath);

    expect(tempStat.mode & 0o777).toBe(0o600);
    expect(tempConfig["current-context"]).toBe("prod");
    expect(tempConfig.contexts?.map((context) => context.name)).toEqual(["dev", "prod"]);
    expect(tempConfig.clusters?.map((cluster) => cluster.name)).toEqual(["dev-cluster", "prod-cluster"]);
    expect(tempConfig.users?.map((user) => user.name)).toEqual(["dev-user", "prod-user"]);
    expect(result.shellCommand).toContain(`export KUBECONFIG=${result.kubeConfigPath}`);
    expect(result.shellCommand).toContain("export PS1='(prod) '\"$KUBEPILE_OLD_PS1\"");
  });

  it("emits fish shell code", async () => {
    const dir = await mkTempDir();
    const sourcePath = path.join(dir, "config");
    await writeSourceKubeConfig(sourcePath);

    const result = await generateShellCommand("dev", {
      sourcePath,
      tempDir: dir,
      shell: "fish",
    });

    expect(result.shellCommand).toContain("set -gx KUBECONFIG");
    expect(result.shellCommand).toContain("functions -c fish_prompt KUBEPILE_OLD_PROMPT");
    expect(result.shellCommand).toContain("printf '(dev) '");
  });
});

describe("listSourceContextNames", () => {
  it("lists context names from the source kubeconfig", async () => {
    const dir = await mkTempDir();
    const sourcePath = path.join(dir, "config");
    await writeSourceKubeConfig(sourcePath);

    await expect(listSourceContextNames({ sourcePath })).resolves.toEqual(["dev", "prod"]);
  });
});

describe("shell integration", () => {
  it("detects supported shells", () => {
    expect(detectCurrentShell("/bin/bash")).toBe("bash");
    expect(detectCurrentShell("/usr/bin/zsh")).toBe("zsh");
    expect(detectCurrentShell("/opt/homebrew/bin/fish")).toBe("fish");
  });

  it("chooses rc files by shell", async () => {
    const homeDir = await mkTempDir();

    await expect(shellRcFile("bash", homeDir)).resolves.toBe(path.join(homeDir, ".bashrc"));
    await expect(shellRcFile("zsh", homeDir)).resolves.toBe(path.join(homeDir, ".zshrc"));
    await expect(shellRcFile("fish", homeDir)).resolves.toBe(path.join(homeDir, ".config", "fish", "config.fish"));
  });

  it("uses an existing bash rc file before creating .bashrc", async () => {
    const homeDir = await mkTempDir();
    await writeFile(path.join(homeDir, ".bash_profile"), "export EXISTING=1\n", "utf8");

    await expect(shellRcFile("bash", homeDir)).resolves.toBe(path.join(homeDir, ".bash_profile"));
  });

  it("uses command kubepile in the installed posix wrapper", () => {
    const block = shellIntegrationBlock("zsh");

    expect(block).toContain('command \\kubepile source "$@"');
    expect(block).toContain('eval "$(command \\kubepile generate-shell-command --shell zsh "$@")"');
    expect(block).toContain('command \\kubepile "$@"');
  });

  it("passes source --list through in the installed fish wrapper", () => {
    const block = shellIntegrationBlock("fish");

    expect(block).toContain("if contains -- --list $argv");
    expect(block).toContain("command kubepile source $argv");
    expect(block).toContain("command kubepile generate-shell-command --shell fish $argv | source");
  });

  it("upserts the managed block", () => {
    const first = upsertShellIntegrationBlock("export FOO=1\n", shellIntegrationBlock("bash"));
    const second = upsertShellIntegrationBlock(first, shellIntegrationBlock("zsh"));

    expect(first).toContain("# >>> kubepile shell integration >>>");
    expect(second).toContain("--shell zsh");
    expect(second).not.toContain("--shell bash");
    expect(second).toContain("export FOO=1");
  });

  it("installs into the requested rc file", async () => {
    const dir = await mkTempDir();
    const rcFile = path.join(dir, ".zshrc");

    const result = await installShellIntegration({
      shell: "zsh",
      rcFile,
    });

    expect(result.updated).toBe(true);
    expect(result.rcFile).toBe(rcFile);
    await expect(readFile(rcFile, "utf8")).resolves.toContain("--shell zsh");
  });
});

async function mkTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kubepile-shell-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSourceKubeConfig(sourcePath: string): Promise<void> {
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(
    sourcePath,
    `apiVersion: v1
kind: Config
clusters:
  - name: dev-cluster
    cluster:
      server: https://dev.example.test
  - name: prod-cluster
    cluster:
      server: https://prod.example.test
users:
  - name: dev-user
    user:
      token: dev-token
  - name: prod-user
    user:
      token: prod-token
contexts:
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
`,
    "utf8",
  );
}
