import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultKubeConfigPath,
  type KubeConfig,
  readKubeConfigFile,
  serializeKubeConfig,
} from "./kubepile.ts";

export type ShellKind = "bash" | "zsh" | "fish";
export type ShellCommandKind = "posix" | "fish";

export interface GenerateShellCommandOptions {
  sourcePath?: string;
  shell?: ShellCommandKind;
  tempDir?: string;
}

export interface GenerateShellCommandResult {
  kubeConfigPath: string;
  shellCommand: string;
}

export interface ListSourceContextNamesOptions {
  sourcePath?: string;
}

export interface InstallShellIntegrationOptions {
  shell?: ShellKind;
  rcFile?: string;
  homeDir?: string;
}

export interface InstallShellIntegrationResult {
  shell: ShellKind;
  rcFile: string;
  updated: boolean;
}

const SHELL_BLOCK_START = "# >>> kubepile shell integration >>>";
const SHELL_BLOCK_END = "# <<< kubepile shell integration <<<";

export async function generateShellCommand(
  contextName: string,
  options: GenerateShellCommandOptions = {},
): Promise<GenerateShellCommandResult> {
  const sourcePath = options.sourcePath ?? defaultKubeConfigPath();
  const shell = options.shell ?? "posix";
  const sourceConfig = await readKubeConfigFile(sourcePath);
  const contextConfig = {
    ...sourceConfig,
    "current-context": contextName,
  };
  const tempRoot = await mkdtemp(path.join(options.tempDir ?? os.tmpdir(), "kubepile-source-"));
  const kubeConfigPath = path.join(tempRoot, "config");

  if (!contextNamesFromConfig(sourceConfig, sourcePath).includes(contextName)) {
    throw new Error(`${sourcePath} does not contain context "${contextName}"`);
  }

  await writeFile(kubeConfigPath, serializeKubeConfig(contextConfig), {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    kubeConfigPath,
    shellCommand: shell === "fish"
      ? fishSourceCommand(contextName, kubeConfigPath)
      : posixSourceCommand(contextName, kubeConfigPath),
  };
}

export async function listSourceContextNames(
  options: ListSourceContextNamesOptions = {},
): Promise<string[]> {
  const sourcePath = options.sourcePath ?? defaultKubeConfigPath();
  return contextNamesFromConfig(await readKubeConfigFile(sourcePath), sourcePath);
}

export async function installShellIntegration(
  options: InstallShellIntegrationOptions = {},
): Promise<InstallShellIntegrationResult> {
  const shell = options.shell ?? detectCurrentShell();
  const rcFile = options.rcFile ?? await shellRcFile(shell, options.homeDir ?? os.homedir());
  const block = shellIntegrationBlock(shell);
  const existing = await readTextIfExists(rcFile);
  const next = upsertShellIntegrationBlock(existing, block);

  await mkdir(path.dirname(rcFile), { recursive: true });
  await writeFile(rcFile, next, "utf8");

  return {
    shell,
    rcFile,
    updated: next !== existing,
  };
}

export function detectCurrentShell(shellPath = process.env.SHELL): ShellKind {
  const shellName = shellPath ? path.basename(shellPath) : "";

  if (shellName === "bash" || shellName === "zsh" || shellName === "fish") {
    return shellName;
  }

  throw new Error(`Unsupported shell "${shellPath ?? ""}". Supported shells: bash, zsh, fish.`);
}

export async function shellRcFile(shell: ShellKind, homeDir = os.homedir()): Promise<string> {
  if (shell === "zsh") {
    return path.join(homeDir, ".zshrc");
  }

  if (shell === "fish") {
    return path.join(homeDir, ".config", "fish", "config.fish");
  }

  const bashCandidates = [
    path.join(homeDir, ".bashrc"),
    path.join(homeDir, ".bash_profile"),
    path.join(homeDir, ".bash_login"),
    path.join(homeDir, ".profile"),
  ];

  return await firstExistingPath(bashCandidates) ?? bashCandidates[0];
}

export function shellIntegrationBlock(shell: ShellKind): string {
  return [
    SHELL_BLOCK_START,
    shell === "fish" ? fishIntegrationFunction() : posixIntegrationFunction(shell),
    SHELL_BLOCK_END,
    "",
  ].join("\n");
}

export function upsertShellIntegrationBlock(existing: string, block: string): string {
  const blockPattern = new RegExp(
    `${escapeRegExp(SHELL_BLOCK_START)}\\n[\\s\\S]*?\\n${escapeRegExp(SHELL_BLOCK_END)}\\n?`,
  );
  const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;

  if (blockPattern.test(existing)) {
    return existing.replace(blockPattern, normalizedBlock);
  }

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  return `${existing}${separator}${normalizedBlock}`;
}

function posixIntegrationFunction(shell: Exclude<ShellKind, "fish">): string {
  return `kubepile() {
  if [ "$1" = "source" ]; then
    shift
    for arg in "$@"; do
      if [ "$arg" = "--list" ]; then
        command \\kubepile source "$@"
        return
      fi
    done
    eval "$(command \\kubepile generate-shell-command --shell ${shell} "$@")"
  else
    command \\kubepile "$@"
  fi
}`;
}

function fishIntegrationFunction(): string {
  return `function kubepile
  if test (count $argv) -gt 0; and test "$argv[1]" = "source"
    set -e argv[1]
    if contains -- --list $argv
      command kubepile source $argv
    else
      command kubepile generate-shell-command --shell fish $argv | source
    end
  else
    command kubepile $argv
  end
end`;
}

function posixSourceCommand(contextName: string, kubeConfigPath: string): string {
  return [
    `export KUBECONFIG=${shellQuote(kubeConfigPath)}`,
    "if [ -z \"${KUBEPILE_OLD_PS1+x}\" ]; then",
    "  export KUBEPILE_OLD_PS1=${PS1-}",
    "fi",
    `export PS1=${shellQuote(`(${contextName}) `)}"$KUBEPILE_OLD_PS1"`,
  ].join("\n");
}

function fishSourceCommand(contextName: string, kubeConfigPath: string): string {
  return [
    `set -gx KUBECONFIG ${fishQuote(kubeConfigPath)}`,
    "if not set -q KUBEPILE_OLD_PROMPT",
    "  functions -c fish_prompt KUBEPILE_OLD_PROMPT",
    "end",
    "function fish_prompt",
    `  printf ${fishQuote(`(${contextName}) `)}`,
    "  KUBEPILE_OLD_PROMPT",
    "end",
  ].join("\n");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fishQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function firstExistingPath(filePaths: string[]): Promise<string | undefined> {
  for (const filePath of filePaths) {
    try {
      await readFile(filePath, "utf8");
      return filePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return undefined;
}

function contextNamesFromConfig(config: KubeConfig, sourcePath: string): string[] {
  if (config.contexts === undefined) {
    return [];
  }

  if (!Array.isArray(config.contexts)) {
    throw new Error(`${sourcePath} contexts must be an array`);
  }

  return config.contexts.map((context) => {
    if (typeof context.name !== "string" || context.name.length === 0) {
      throw new Error(`${sourcePath} context name must be a non-empty string`);
    }

    return context.name;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
