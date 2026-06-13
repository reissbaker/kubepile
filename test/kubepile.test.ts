import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  buildMergedConfig,
  compileToKubeConfig,
  parseKubeConfig,
  splitKubeConfigFile,
} from "../src/kubepile.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("buildMergedConfig", () => {
  it("merges source files without renaming clusters, users, or contexts", async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "eks.yaml"),
      `apiVersion: v1
kind: Config
clusters:
  - name: source-eks-cluster
    cluster:
      server: https://eks.example.test
users:
  - name: source-eks-user
    user:
      token: eks-token
contexts:
  - name: source-eks
    context:
      cluster: source-eks-cluster
      user: source-eks-user
      namespace: apps
`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "gke.yaml"),
      `apiVersion: v1
kind: Config
clusters:
  - name: source-gke-cluster
    cluster:
      server: https://gke.example.test
users:
  - name: source-gke-user
    user:
      token: gke-token
contexts:
  - name: source-gke
    context:
      cluster: source-gke-cluster
      user: source-gke-user
`,
      "utf8",
    );

    const { config } = await buildMergedConfig({ inputDir: dir });

    expect(config["current-context"]).toBeUndefined();
    expect(config.contexts?.map((context) => context.name)).toEqual(["source-eks", "source-gke"]);
    expect(config.clusters?.map((cluster) => cluster.name)).toEqual([
      "source-eks-cluster",
      "source-gke-cluster",
    ]);
    expect(config.users?.map((user) => user.name)).toEqual(["source-eks-user", "source-gke-user"]);
    expect(config.contexts?.[0]?.context).toEqual({
      cluster: "source-eks-cluster",
      user: "source-eks-user",
      namespace: "apps",
    });
  });

  it("rejects a source file with current-context", async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "default.yaml"),
      `apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: https://example.test
contexts:
  - name: one
    context:
      cluster: cluster
current-context: one
`,
      "utf8",
    );

    await expect(buildMergedConfig({ inputDir: dir })).rejects.toThrow(/must not set current-context/);
  });

  it("rejects .yml files", async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "dev.yml"),
      `apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: https://dev.example.test
contexts:
  - name: dev-source
    context:
      cluster: cluster
`,
      "utf8",
    );

    await expect(buildMergedConfig({ inputDir: dir })).rejects.toThrow(/Use \.yaml only/);
  });

  it.each([
    {
      name: "duplicate cluster names",
      source: `apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: https://one.example.test
  - name: cluster
    cluster:
      server: https://two.example.test
contexts:
  - name: dev-source
    context:
      cluster: cluster
`,
      error: /Duplicate cluster name "cluster"/,
    },
    {
      name: "duplicate user names",
      source: `apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: https://dev.example.test
users:
  - name: user
    user:
      token: one
  - name: user
    user:
      token: two
contexts:
  - name: dev-source
    context:
      cluster: cluster
      user: user
`,
      error: /Duplicate user name "user"/,
    },
    {
      name: "duplicate context names",
      source: `apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: https://dev.example.test
contexts:
  - name: dev-source
    context:
      cluster: cluster
  - name: dev-source
    context:
      cluster: cluster
`,
      error: /Duplicate context name "dev-source"/,
    },
  ])("rejects $name", async ({ source, error }) => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "dev.yaml"), source, "utf8");

    await expect(buildMergedConfig({ inputDir: dir })).rejects.toThrow(error);
  });

  it.each([
    {
      name: "cluster",
      first: `apiVersion: v1
kind: Config
clusters:
  - name: shared
    cluster:
      server: https://one.example.test
contexts:
  - name: one
    context:
      cluster: shared
`,
      second: `apiVersion: v1
kind: Config
clusters:
  - name: shared
    cluster:
      server: https://two.example.test
contexts:
  - name: two
    context:
      cluster: shared
`,
    },
    {
      name: "user",
      first: `apiVersion: v1
kind: Config
clusters:
  - name: one-cluster
    cluster:
      server: https://one.example.test
users:
  - name: shared
    user:
      token: one
contexts:
  - name: one
    context:
      cluster: one-cluster
      user: shared
`,
      second: `apiVersion: v1
kind: Config
clusters:
  - name: two-cluster
    cluster:
      server: https://two.example.test
users:
  - name: shared
    user:
      token: two
contexts:
  - name: two
    context:
      cluster: two-cluster
      user: shared
`,
    },
    {
      name: "context",
      first: `apiVersion: v1
kind: Config
clusters:
  - name: one-cluster
    cluster:
      server: https://one.example.test
contexts:
  - name: shared
    context:
      cluster: one-cluster
`,
      second: `apiVersion: v1
kind: Config
clusters:
  - name: two-cluster
    cluster:
      server: https://two.example.test
contexts:
  - name: shared
    context:
      cluster: two-cluster
`,
    },
  ])("rejects duplicate $name names across files", async ({ name, first, second }) => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "one.yaml"), first, "utf8");
    await writeFile(path.join(dir, "two.yaml"), second, "utf8");

    await expect(buildMergedConfig({ inputDir: dir })).rejects.toThrow(
      new RegExp(`Duplicate ${name} name "shared"`),
    );
  });

  it("treats a leading tilde in an explicit input path as literal", async () => {
    const dir = await tempDir();
    const originalCwd = process.cwd();
    const literalConfigDir = path.join(dir, "~", "configs");
    await mkdir(literalConfigDir, { recursive: true });
    await writeFile(
      path.join(literalConfigDir, "literal.yaml"),
      `apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: https://literal.example.test
contexts:
  - name: literal-source
    context:
      cluster: cluster
`,
      "utf8",
    );

    try {
      process.chdir(dir);
      const { config } = await buildMergedConfig({ inputDir: "~/configs" });

      expect(config.contexts?.[0]?.name).toBe("literal-source");
      expect(config.clusters?.[0]?.cluster.server).toBe("https://literal.example.test");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("compileToKubeConfig", () => {
  it("backs up an existing kubeconfig when requested", async () => {
    const dir = await tempDir();
    const kubeDir = path.join(dir, ".kube");
    const outputPath = path.join(kubeDir, "config");
    await mkdir(kubeDir, { recursive: true });
    await writeFile(outputPath, "old-config\n", "utf8");
    await writeFile(
      path.join(dir, "dev.yaml"),
      `apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: https://dev.example.test
contexts:
  - name: dev-source
    context:
      cluster: cluster
`,
      "utf8",
    );

    const result = await compileToKubeConfig({
      inputDir: dir,
      outputPath,
      shouldBackup: () => true,
    });

    expect(result.backedUpTo).toBe(`${outputPath}.bak`);
    await expect(readFile(`${outputPath}.bak`, "utf8")).resolves.toBe("old-config\n");
    const outputSource = await readFile(outputPath, "utf8");
    expect(outputSource).toMatch(
      new RegExp(
        [
          "^# GENERATED BY KUBEPILE: DO NOT MODIFY",
          "#",
          "# To add a kubepile config:",
          `# 1\\. Save a kubeconfig file in ${escapeRegExp(dir)}\\.`,
          `#    Example: ${escapeRegExp(path.join(dir, "dev.yaml"))}`,
          "# 2\\. Rebuild this generated config with:",
          `#    kubepile compile --config-dir ${escapeRegExp(dir)}`,
          "",
          "apiVersion: v1",
        ].join("\n"),
      ),
    );
    const output = parseKubeConfig(outputSource, outputPath);
    expect(output["current-context"]).toBeUndefined();
    expect(output.contexts?.[0]?.name).toBe("dev-source");
  });
});

describe("splitKubeConfigFile", () => {
  it("writes one kubeconfig per context", async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, "config");
    const outputDir = path.join(dir, "kubepile");
    await writeFile(
      sourcePath,
      `apiVersion: v1
kind: Config
preferences:
  colors: false
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
      namespace: payments
current-context: prod
`,
      "utf8",
    );

    const result = await splitKubeConfigFile({ sourcePath, outputDir });

    expect(result.writtenFiles.map((file) => path.basename(file)).sort()).toEqual(["dev.yaml", "prod.yaml"]);

    const prod = parseKubeConfig(await readFile(path.join(outputDir, "prod.yaml"), "utf8"), "prod.yaml");
    expect(prod["current-context"]).toBeUndefined();
    expect(prod.clusters).toEqual([
      {
        name: "prod-cluster",
        cluster: {
          server: "https://prod.example.test",
        },
      },
    ]);
    expect(prod.users).toEqual([
      {
        name: "prod-user",
        user: {
          token: "prod-token",
        },
      },
    ]);
    expect(prod.contexts).toEqual([
      {
        name: "prod",
        context: {
          cluster: "prod-cluster",
          user: "prod-user",
          namespace: "payments",
        },
      },
    ]);
  });

  it("rejects duplicate context names instead of overwriting split files", async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, "config");
    const outputDir = path.join(dir, "kubepile");
    await writeFile(
      sourcePath,
      `apiVersion: v1
kind: Config
clusters:
  - name: one-cluster
    cluster:
      server: https://one.example.test
  - name: two-cluster
    cluster:
      server: https://two.example.test
contexts:
  - name: shared
    context:
      cluster: one-cluster
  - name: shared
    context:
      cluster: two-cluster
`,
      "utf8",
    );

    await expect(splitKubeConfigFile({ sourcePath, outputDir })).rejects.toThrow(
      /Duplicate context name "shared"/,
    );
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kubepile-test-"));
  tempDirs.push(dir);
  return dir;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("runCli", () => {
  it("prints help instead of compiling when no command is provided", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await runCli([]);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("Usage: kubepile");
      expect(output).toContain("compile [options]");
    } finally {
      write.mockRestore();
    }
  });
});
