import { mkdir, readdir, readFile, stat, copyFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface NamedCluster {
  name: string;
  cluster: Record<string, unknown>;
}

export interface NamedUser {
  name: string;
  user: Record<string, unknown>;
}

export interface KubeContext {
  cluster: string;
  user?: string;
  namespace?: string;
  [key: string]: unknown;
}

export interface NamedContext {
  name: string;
  context: KubeContext;
}

export interface KubeConfig {
  apiVersion?: string;
  kind?: string;
  preferences?: Record<string, unknown>;
  clusters?: NamedCluster[];
  users?: NamedUser[];
  contexts?: NamedContext[];
  "current-context"?: string;
  [key: string]: unknown;
}

export interface CompileOptions {
  inputDir?: string;
}

export interface CompileToFileOptions extends CompileOptions {
  outputPath?: string;
  shouldBackup?: (existingPath: string, backupPath: string) => Promise<boolean> | boolean;
}

export interface CompileResult {
  config: KubeConfig;
  inputFiles: string[];
  outputPath: string;
  backedUpTo?: string;
}

export interface SplitOptions {
  sourcePath?: string;
  outputDir?: string;
}

export interface SplitConfig {
  contextName: string;
  fileName: string;
  config: KubeConfig;
}

export interface SplitResult {
  outputDir: string;
  writtenFiles: string[];
}

interface MergeNameSets {
  clusters: Set<string>;
  users: Set<string>;
  contexts: Set<string>;
}

export function defaultKubepileDir(): string {
  return path.join(os.homedir(), ".config", "kubepile");
}

export function defaultKubeConfigPath(): string {
  return path.join(os.homedir(), ".kube", "config");
}

export async function buildMergedConfig(options: CompileOptions = {}): Promise<{
  config: KubeConfig;
  inputFiles: string[];
}> {
  const inputDir = options.inputDir ?? defaultKubepileDir();
  const inputFiles = await listKubeConfigFiles(inputDir);
  const configs = await Promise.all(
    inputFiles.map(async (filePath) => ({
      filePath,
      config: await readKubeConfigFile(filePath),
    })),
  );

  const seenNames: MergeNameSets = {
    clusters: new Set(),
    users: new Set(),
    contexts: new Set(),
  };
  const merged: KubeConfig = {
    apiVersion: "v1",
    kind: "Config",
    preferences: {},
    clusters: [],
    users: [],
    contexts: [],
  };

  for (const source of configs) {
    appendSourceConfig(merged, source.config, source.filePath, seenNames);
  }

  delete merged["current-context"];

  return { config: merged, inputFiles };
}

export async function compileToKubeConfig(options: CompileToFileOptions = {}): Promise<CompileResult> {
  const inputDir = options.inputDir ?? defaultKubepileDir();
  const outputPath = options.outputPath ?? defaultKubeConfigPath();
  const backupPath = `${outputPath}.bak`;
  const { config, inputFiles } = await buildMergedConfig({ ...options, inputDir });
  let backedUpTo: string | undefined;

  if (await pathExists(outputPath)) {
    const shouldBackup = await options.shouldBackup?.(outputPath, backupPath);

    if (shouldBackup) {
      await mkdir(path.dirname(backupPath), { recursive: true });
      await copyFile(outputPath, backupPath);
      backedUpTo = backupPath;
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeGeneratedKubeConfig(config, inputDir), "utf8");

  return { config, inputFiles, outputPath, backedUpTo };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function splitKubeConfigFile(options: SplitOptions = {}): Promise<SplitResult> {
  const sourcePath = options.sourcePath ?? defaultKubeConfigPath();
  const outputDir = options.outputDir ?? defaultKubepileDir();
  const sourceConfig = await readKubeConfigFile(sourcePath);
  const splitConfigs = splitKubeConfig(sourceConfig, sourcePath);
  const writtenFiles: string[] = [];

  await mkdir(outputDir, { recursive: true });

  for (const splitConfig of splitConfigs) {
    const outputPath = path.join(outputDir, splitConfig.fileName);
    await writeFile(outputPath, serializeKubeConfig(splitConfig.config), "utf8");
    writtenFiles.push(outputPath);
  }

  return { outputDir, writtenFiles };
}

export function splitKubeConfig(config: KubeConfig, sourceLabel = "kubeconfig"): SplitConfig[] {
  const contexts = getNamedContexts(config, sourceLabel);
  const clusters = getNamedClusters(config, sourceLabel);
  const users = getNamedUsers(config, sourceLabel);

  validateAndTrackUniqueNamedEntries(clusters, "cluster", sourceLabel, new Set());
  validateAndTrackUniqueNamedEntries(users, "user", sourceLabel, new Set());
  validateAndTrackUniqueNamedEntries(contexts, "context", sourceLabel, new Set());

  return contexts.map((context) => {
    const contextName = getNonEmptyString(context.name, `${sourceLabel} context name`);
    const contextBody = getContextBody(context, sourceLabel);
    const clusterName = getNonEmptyString(contextBody.cluster, `${sourceLabel} context "${contextName}" cluster`);
    const userName = getOptionalString(contextBody.user, `${sourceLabel} context "${contextName}" user`);
    const cluster = findNamedEntry(clusters, clusterName, "cluster", sourceLabel);
    const user = userName
      ? findNamedEntry(users, userName, "user", sourceLabel)
      : undefined;
    const splitContext = deepClone(contextBody);

    return {
      contextName,
      fileName: fileNameForContext(contextName),
      config: {
        apiVersion: "v1",
        kind: "Config",
        preferences: deepClone(config.preferences ?? {}),
        clusters: [deepClone(cluster)],
        users: user ? [deepClone(user)] : [],
        contexts: [
          {
            name: contextName,
            context: splitContext,
          },
        ],
      },
    };
  });
}

export async function readKubeConfigFile(filePath: string): Promise<KubeConfig> {
  const source = await readFile(filePath, "utf8");
  return parseKubeConfig(source, filePath);
}

export function parseKubeConfig(source: string, sourceLabel = "kubeconfig"): KubeConfig {
  const parsed = parse(source) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`${sourceLabel} must be a YAML object`);
  }

  return parsed as KubeConfig;
}

export function serializeKubeConfig(config: KubeConfig): string {
  return stringify(config, { lineWidth: 0 });
}

export function serializeGeneratedKubeConfig(config: KubeConfig, inputDir = defaultKubepileDir()): string {
  return `${generatedKubeConfigHeader(inputDir)}${serializeKubeConfig(config)}`;
}

export function fileNameForContext(contextName: string): string {
  const safeName = getNonEmptyString(contextName, "context name");

  if (/^[A-Za-z0-9._-]+$/.test(safeName)) {
    return `${safeName}.yaml`;
  }

  return `${encodeURIComponent(safeName)}.yaml`;
}

function generatedKubeConfigHeader(inputDir: string): string {
  const exampleConfigPath = path.join(inputDir, "dev.yaml");

  return [
    "# GENERATED BY KUBEPILE: DO NOT MODIFY",
    "#",
    "# To add a kubepile config:",
    `# 1. Save a kubeconfig file in ${inputDir}.`,
    `#    Example: ${exampleConfigPath}`,
    "# 2. Rebuild this generated config with:",
    `#    kubepile compile --config-dir ${shellQuote(inputDir)}`,
    "",
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function listKubeConfigFiles(inputDir: string): Promise<string[]> {
  try {
    const inputStat = await stat(inputDir);

    if (!inputStat.isDirectory()) {
      throw new Error(`Config path is not a directory: ${inputDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Config directory does not exist: ${inputDir}`);
    }

    throw error;
  }

  const entries = await readdir(inputDir, { withFileTypes: true });
  const unsupportedYamlFiles = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name) && !entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (unsupportedYamlFiles.length > 0) {
    throw new Error(
      `Unsupported kubeconfig file extension in ${inputDir}: ${unsupportedYamlFiles.join(", ")}. Use .yaml only.`,
    );
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => path.join(inputDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No kubeconfig files found in ${inputDir}`);
  }

  return files;
}

function appendSourceConfig(
  merged: KubeConfig,
  sourceConfig: KubeConfig,
  sourceLabel: string,
  seenNames: MergeNameSets,
): void {
  rejectCurrentContext(sourceConfig, sourceLabel);

  const sourceClusters = getNamedClusters(sourceConfig, sourceLabel);
  const sourceUsers = getNamedUsers(sourceConfig, sourceLabel);
  const sourceContexts = getNamedContexts(sourceConfig, sourceLabel);

  validateAndTrackUniqueNamedEntries(sourceClusters, "cluster", sourceLabel, seenNames.clusters);
  validateAndTrackUniqueNamedEntries(sourceUsers, "user", sourceLabel, seenNames.users);
  validateAndTrackUniqueNamedEntries(sourceContexts, "context", sourceLabel, seenNames.contexts);

  merged.clusters?.push(...deepClone(sourceClusters));
  merged.users?.push(...deepClone(sourceUsers));
  merged.contexts?.push(...deepClone(sourceContexts));
}

function rejectCurrentContext(config: KubeConfig, sourceLabel: string): void {
  if (Object.hasOwn(config, "current-context")) {
    throw new Error(`${sourceLabel} must not set current-context`);
  }
}

function getNamedClusters(config: KubeConfig, sourceLabel: string): NamedCluster[] {
  return getArray(config.clusters, `${sourceLabel} clusters`) as NamedCluster[];
}

function getNamedUsers(config: KubeConfig, sourceLabel: string): NamedUser[] {
  return getArray(config.users, `${sourceLabel} users`) as NamedUser[];
}

function getNamedContexts(config: KubeConfig, sourceLabel: string): NamedContext[] {
  return getArray(config.contexts, `${sourceLabel} contexts`) as NamedContext[];
}

function getArray(value: unknown, label: string): unknown[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value;
}

function validateAndTrackUniqueNamedEntries(
  entries: Array<{ name: unknown }>,
  entryType: string,
  sourceLabel: string,
  seen: Set<string>,
): void {
  for (const entry of entries) {
    const name = getNonEmptyString(entry.name, `${sourceLabel} ${entryType} name`);

    if (seen.has(name)) {
      throw new Error(`Duplicate ${entryType} name "${name}" found in ${sourceLabel}`);
    }

    seen.add(name);
  }
}

function getContextBody(context: NamedContext, sourceLabel: string): KubeContext {
  if (!isRecord(context) || !isRecord(context.context)) {
    throw new Error(`${sourceLabel} context "${String(context.name)}" must contain a context object`);
  }

  return context.context as KubeContext;
}

function findNamedEntry<T extends { name: string }>(
  entries: T[],
  name: string,
  entryType: string,
  sourceLabel: string,
): T {
  const entry = entries.find((candidate) => candidate.name === name);

  if (!entry) {
    throw new Error(`${sourceLabel} references missing ${entryType} "${name}"`);
  }

  return entry;
}

function getNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function getOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
