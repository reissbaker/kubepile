#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { Command } from "@commander-js/extra-typings";
import packageJson from "../package.json" with { type: "json" };
import {
  compileToKubeConfig,
  defaultKubeConfigPath,
  defaultKubepileDir,
  splitKubeConfigFile,
} from "./kubepile.ts";

export async function runCli(argv: string[]): Promise<void> {
  const program = createProgram();

  if (argv.length === 0) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(argv, { from: "user" });
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

  return program;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (import.meta.url === entryPoint) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kubepile: ${message}\n`);
    process.exitCode = 1;
  });
}
