#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Command } from "@commander-js/extra-typings";
import packageJson from "../package.json" with { type: "json" };
import {
  compileToKubeConfig,
  defaultKubeConfigPath,
  defaultKubepileDir,
  splitKubeConfigFile,
} from "./kubepile.ts";
import {
  generateShellCommand,
  installShellIntegration,
} from "./shell.ts";

const program = createProgram();

if (process.argv.slice(2).length === 0) {
  program.outputHelp();
} else {
  program.parseAsync(process.argv.slice(2), { from: "user" }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kubepile: ${message}\n`);
    process.exitCode = 1;
  });
}

async function askBackup(existingPath: string, backupPath: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answer = await rl.question(
      `Existing kubeconfig found at ${existingPath}. Back it up to ${backupPath}? [y/N] `,
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function createProgram(): Command {
  const program = new Command()
    .name("kubepile")
    .description("Compile and split kubeconfig files.")
    .version(packageJson.version)
    .showHelpAfterError()
    .allowExcessArguments(false)
    .addHelpText(
      "after",
      `

Defaults:
  config dir: ${defaultKubepileDir()}
  kubeconfig: ${defaultKubeConfigPath()}`,
    );

  program
    .command("compile")
    .description("Compile ~/.config/kubepile/*.yaml into ~/.kube/config.")
    .option("--config-dir <dir>", "directory containing kubeconfig YAML files")
    .option("--input-dir <dir>", "alias for --config-dir")
    .option("--output <file>", "output kubeconfig path")
    .option("--backup", "back up an existing output file without prompting")
    .option("--no-backup", "replace an existing output file without prompting")
    .action(async (options) => {
      const result = await compileToKubeConfig({
        inputDir: options.configDir ?? options.inputDir,
        outputPath: options.output,
        shouldBackup:
          options.backup === undefined
            ? askBackup
            : () => options.backup === true,
      });

      if (result.backedUpTo) {
        process.stdout.write(`Backed up existing kubeconfig to ${result.backedUpTo}\n`);
      }

      process.stdout.write(`Compiled ${result.inputFiles.length} kubeconfig file(s) into ${result.outputPath}\n`);
    });

  program
    .command("split")
    .description("Split an existing kubeconfig into one file per context.")
    .option("--source <file>", "source kubeconfig path")
    .option("--output-dir <dir>", "directory to write split kubeconfigs")
    .action(async (options) => {
      const result = await splitKubeConfigFile({
        sourcePath: options.source,
        outputDir: options.outputDir,
      });

      process.stdout.write(`Wrote ${result.writtenFiles.length} kubeconfig file(s) into ${result.outputDir}\n`);
    });

  program
    .command("install")
    .description("Install the kubepile shell function for the current shell.")
    .action(async () => {
      const result = await installShellIntegration();
      const action = result.updated ? "Installed" : "Updated";
      process.stdout.write(`${action} kubepile shell integration in ${result.rcFile}\n`);
      process.stdout.write("Start a new shell, then run: kubepile source <context>\n");
    });

  program
    .command("generate-shell-command")
    .description("Generate shell code for kubepile source. Usually called by the installed shell function.")
    .argument("<context>", "context name to source")
    .option("--source <file>", "source kubeconfig path")
    .option("--shell <shell>", "shell command format: bash, zsh, or fish", "bash")
    .action(async (context, options) => {
      const shell = options.shell === "fish" ? "fish" : "posix";
      const result = await generateShellCommand(context, {
        sourcePath: options.source,
        shell,
      });

      process.stdout.write(`${result.shellCommand}\n`);
    });

  program
    .command("source")
    .description("Switch to one kube context in the current shell.")
    .argument("<context>", "context name to source")
    .action(() => {
      throw new Error(
        "kubepile source requires shell integration. Run `kubepile install`, start a new shell, then run `kubepile source <context>`.",
      );
    });

  return program;
}
