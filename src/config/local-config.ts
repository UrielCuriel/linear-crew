import type { ProjectTopology } from "../domain/types.ts";

export interface LocalConfig {
  schema: 1;
  projectId: string;
  database: string;
  rootDirectory: string;
  topology: ProjectTopology;
  contexts: Array<{
    workspaceKey: string;
    repositoryKey: string;
    directory: string;
    relationship: "root" | "directory" | "submodule" | "external";
    inheritRootContext: boolean;
    requireLocalAgent: boolean;
  }>;
  opencode: {
    baseUrl: string;
  };
}

export async function readLocalConfig(rootDirectory: string): Promise<LocalConfig | null> {
  const file = Bun.file(`${rootDirectory.replace(/[\\/]$/, "")}/.linear-crew.json`);
  if (!(await file.exists())) return null;
  const value = await file.json() as Partial<LocalConfig>;
  if (value.schema !== 1 || !value.projectId || !value.database || !value.rootDirectory || !value.topology || !Array.isArray(value.contexts) || !value.opencode?.baseUrl) {
    throw new Error(".linear-crew.json is invalid or uses an unsupported schema");
  }
  return value as LocalConfig;
}

export function resolveDatabase(config: Pick<LocalConfig, "database" | "rootDirectory">): string {
  if (isAbsolute(config.database)) return normalize(config.database);
  return resolveDirectory(config.rootDirectory, config.database);
}

export function resolveDirectory(rootDirectory: string, configuredPath: string): string {
  const root = normalize(rootDirectory);
  const candidate = normalize(configuredPath);
  if (isAbsolute(candidate)) return candidate;
  if (candidate.split("/").includes("..")) throw new Error(`Context directory escapes the project root: ${configuredPath}`);
  return candidate === "." ? root : `${root}/${candidate.replace(/^\.\//, "")}`;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(normalize(path));
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/, "");
}
