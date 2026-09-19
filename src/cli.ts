#!/usr/bin/env bun

import { createCLI, defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { ControlPlane } from "./application/control-plane.ts";
import { createHttpApp } from "./http/app.ts";
import { SqliteStore } from "./infrastructure/sqlite-store.ts";
import { readLocalConfig, resolveDatabase, resolveRuntimeSettings } from "./config/local-config.ts";
import { dashboardView } from "./tui/dashboard.tsx";

const localConfig = await readLocalConfig(process.cwd());
const configuredProjectId = localConfig?.projectId ?? Bun.env.LINEAR_CREW_PROJECT_ID;

const database = option(z.string().default(Bun.env.LINEAR_CREW_DB ?? (localConfig ? resolveDatabase(localConfig) : "linear-crew.sqlite")), {
  short: "d",
  description: "SQLite database file; defaults to .linear-crew.json",
});

const project = option(configuredProjectId
  ? z.string().min(1).default(configuredProjectId)
  : z.string().min(1), { description: "Project id; defaults to .linear-crew.json" });

const optionalDatabase = option(z.string().optional(), {
  short: "d",
  description: "SQLite database file; defaults to .linear-crew.json",
});

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function useControlPlane<T>(filename: string, run: (controlPlane: ControlPlane) => T): T {
  const store = new SqliteStore(filename);
  try {
    return run(new ControlPlane(store));
  } finally {
    store.close();
  }
}

const serve = defineCommand({
  name: "serve",
  description: "Start the local control plane HTTP API",
  options: {
    database,
    port: option(z.coerce.number().int().min(1).max(65535).default(4317), { short: "p", description: "HTTP port" }),
    hostname: option(z.string().default("127.0.0.1"), { description: "Bind hostname" }),
  },
  handler: ({ flags }) => {
    const store = new SqliteStore(flags.database);
    const app = createHttpApp(new ControlPlane(store)).listen({ port: flags.port, hostname: flags.hostname });
    console.log(`Linear Crew listening at http://${app.server?.hostname}:${app.server?.port}`);
  },
});

const projectCreate = defineCommand({
  name: "project-create",
  description: "Create a project",
  options: {
    database,
    name: option(z.string().min(1), { short: "n", description: "Project name" }),
    description: option(z.string().optional(), { description: "Project description" }),
    topology: option(z.enum(["single-repo", "monorepo", "multi-repo"]).default("single-repo"), { description: "Project repository topology" }),
    root: option(z.string().optional(), { description: "Absolute project root; defaults to current directory" }),
  },
  handler: ({ flags, cwd }) => print(useControlPlane(flags.database, (cp) => cp.createProject({ name: flags.name, description: flags.description, topology: flags.topology, rootPath: flags.root ?? cwd }))),
});

const projectList = defineCommand({
  name: "project-list",
  description: "List projects",
  options: { database },
  handler: ({ flags }) => print(useControlPlane(flags.database, (cp) => cp.listProjects())),
});

const guide = defineCommand({
  name: "guide",
  description: "Show the Linear Crew capabilities and implementation workflow configured for a project",
  options: {
    database,
    project,
  },
  handler: ({ flags }) => print(useControlPlane(flags.database, (cp) => cp.projectGuide(flags.project))),
});

const roleAdd = defineCommand({
  name: "role-add",
  description: "Add a role to a project",
  options: {
    database,
    project,
    key: option(z.string().min(1), { description: "Stable role key" }),
    name: option(z.string().min(1), { short: "n", description: "Role name" }),
    capabilities: option(z.string().default(""), { description: "Comma-separated capabilities" }),
    workspaces: option(z.string().default("*"), { description: "Comma-separated allowed workspace keys" }),
    model: option(z.string().optional(), { description: "Optional provider/model" }),
    variant: option(z.string().optional(), { description: "Optional model variant" }),
  },
  handler: ({ flags }) => print(useControlPlane(flags.database, (cp) => cp.createRole(flags.project, {
    key: flags.key,
    name: flags.name,
    capabilities: flags.capabilities.split(",").map((value) => value.trim()).filter(Boolean),
    workspaceKeys: flags.workspaces.split(",").map((value) => value.trim()).filter(Boolean),
    model: flags.model ? {
      providerId: flags.model.includes("/") ? flags.model.slice(0, flags.model.indexOf("/")) : "opencode",
      modelId: flags.model.includes("/") ? flags.model.slice(flags.model.indexOf("/") + 1) : flags.model,
      variant: flags.variant,
    } : undefined,
  }))),
});

const repositoryAdd = defineCommand({
  name: "repository-add",
  description: "Register a project repository",
  options: {
    database,
    project,
    key: option(z.string().min(1), { description: "Stable repository key" }),
    name: option(z.string().min(1), { short: "n", description: "Repository name" }),
    path: option(z.string().min(1), { description: "Repository path" }),
    relationship: option(z.enum(["root", "directory", "submodule", "external"]).optional(), { description: "Relationship to the control root" }),
  },
  handler: ({ flags }) => print(useControlPlane(flags.database, (cp) => cp.createRepository(flags.project, flags))),
});

const workspaceAdd = defineCommand({
  name: "workspace-add",
  description: "Register an OpenCode context root inside a repository",
  options: {
    database,
    project,
    repository: option(z.string().min(1), { description: "Repository id" }),
    key: option(z.string().min(1), { description: "Stable workspace key" }),
    name: option(z.string().min(1), { short: "n", description: "Workspace name" }),
    path: option(z.string().min(1), { description: "Path relative to the configured root" }),
    inheritRoot: option(z.boolean().default(true), { description: "Inherit global project context" }),
    localAgent: option(z.boolean().default(true), { description: "Require a local .opencode agent profile" }),
  },
  handler: ({ flags }) => print(useControlPlane(flags.database, (cp) => cp.createWorkspace(flags.project, {
    repositoryId: flags.repository, key: flags.key, name: flags.name, path: flags.path,
    inheritRootContext: flags.inheritRoot, requireLocalAgent: flags.localAgent,
  }))),
});

const workAdd = defineCommand({
  name: "work-add",
  description: "Create a work item with a durable outcome",
  options: {
    database,
    project,
    type: option(z.enum(["milestone", "epic", "issue", "task"]).default("issue"), { description: "Work item type" }),
    title: option(z.string().min(1), { short: "t", description: "Title" }),
    outcome: option(z.string().min(1), { short: "o", description: "Immutable outcome for this revision" }),
    parent: option(z.string().optional(), { description: "Parent work item id" }),
    role: option(z.string().optional(), { description: "Assignee role key" }),
    workflow: option(z.string().optional(), { description: "Workflow id" }),
  },
  handler: ({ flags }) => print(useControlPlane(flags.database, (cp) => cp.createWorkItem(flags.project, {
    type: flags.type, title: flags.title, outcome: flags.outcome, parentId: flags.parent,
    assigneeRoleKey: flags.role, workflowId: flags.workflow,
  }))),
});

const status = defineCommand({
  name: "status",
  description: "Show a project control plane snapshot",
  options: {
    database,
    project,
  },
  handler: ({ flags }) => print(useControlPlane(flags.database, (cp) => ({
    roles: cp.listRoles(flags.project),
    workItems: cp.listWorkItems(flags.project),
    delegations: cp.listDelegations(flags.project),
    sessions: cp.listSessions(flags.project),
    leases: cp.listLeases(flags.project),
    handoffs: cp.listHandoffs(flags.project),
    interventions: cp.listInterventions(flags.project, "open"),
    acceptances: cp.listAcceptances(flags.project),
    meetings: cp.listMeetings(flags.project),
  }))),
});

const tui = defineCommand({
  name: "tui",
  description: "Open the live human monitoring dashboard",
  options: {
    database,
    project,
    refresh: option(z.coerce.number().int().min(250).default(1000), { description: "Refresh interval in milliseconds" }),
  },
  render: ({ flags }) => dashboardView(flags.database, flags.project, flags.refresh),
  handler: () => {
    throw new Error("The Linear Crew dashboard requires an interactive terminal");
  },
});

const opencodeConfigure = defineCommand({
  name: "opencode-configure",
  description: "Write the local Linear Crew project binding used by the OpenCode plugin",
  options: {
    database,
    project,
  },
  handler: async ({ flags, cwd }) => {
    const path = `${cwd.replace(/[\\/]$/, "")}/.linear-crew.json`;
    const configured = useControlPlane(flags.database, (cp) => {
      const project = cp.getProject(flags.project);
      const repositories = new Map(cp.listRepositories(flags.project).map((repository) => [repository.id, repository]));
      const contexts = cp.listWorkspaces(flags.project).map((workspace) => {
        const repository = repositories.get(workspace.repositoryId);
        if (!repository) throw new Error(`Workspace '${workspace.key}' has no repository`);
        return {
          workspaceKey: workspace.key,
          repositoryKey: repository.key,
          directory: workspace.path,
          relationship: repository.relationship,
          inheritRootContext: workspace.inheritRootContext,
          requireLocalAgent: workspace.requireLocalAgent,
        };
      });
      return { project, contexts };
    });
    await Bun.write(path, `${JSON.stringify({
      schema: 1,
      projectId: flags.project,
      database: flags.database,
      rootDirectory: configured.project.rootPath === "." ? cwd : configured.project.rootPath,
      topology: configured.project.topology,
      contexts: configured.contexts,
      opencode: { baseUrl: "http://127.0.0.1:4096" },
    }, null, 2)}\n`);
    print({ configured: path, projectId: flags.project, database: flags.database });
  },
});

const scheduler = defineCommand({
  name: "scheduler",
  description: "Continuously reconcile OpenCode sessions and wake their coordinators",
  options: {
    database,
    project,
    root: option(z.string().optional(), { description: "Project root directory" }),
    opencode: option(z.string().default("http://127.0.0.1:4096"), { description: "OpenCode server URL" }),
    interval: option(z.coerce.number().int().min(250).default(1000), { description: "Polling interval in milliseconds" }),
  },
  handler: async ({ flags, cwd, signal }) => {
    const store = new SqliteStore(flags.database);
    try {
      const { OpenCodeScheduler, OpenCodeSdkRuntime } = await import("./scheduler/opencode-scheduler.ts");
      const runner = new OpenCodeScheduler(new ControlPlane(store), new OpenCodeSdkRuntime(flags.opencode), flags.root ?? cwd);
      while (!signal.aborted) {
        const result = await runner.reconcile(flags.project);
        if (result.updated || result.notified || result.unknown) print(result);
        await Bun.sleep(flags.interval);
      }
    } finally {
      store.close();
    }
  },
});

const runtime = defineCommand({
  name: "runtime",
  description: "Run a managed OpenCode server and continuously reconcile its Linear Crew sessions",
  options: {
    database: optionalDatabase,
    project: option(z.string().min(1).optional(), { description: "Project id; defaults to .linear-crew.json" }),
    root: option(z.string().optional(), { description: "Project root directory" }),
    hostname: option(z.string().optional(), { description: "OpenCode bind hostname; defaults to the configured baseUrl" }),
    port: option(z.coerce.number().int().min(1).max(65535).optional(), { short: "p", description: "OpenCode server port; defaults to the configured baseUrl" }),
    interval: option(z.coerce.number().int().min(250).default(1000), { description: "Scheduler polling interval in milliseconds" }),
  },
  handler: async ({ flags, cwd, signal }) => {
    const config = await readLocalConfig(cwd);
    const settings = resolveRuntimeSettings(cwd, flags, config);
    const store = new SqliteStore(settings.database);
    try {
      const controlPlane = new ControlPlane(store);
      controlPlane.getProject(settings.projectId);
      const { startManagedOpenCodeServer } = await import("./runtime/managed-opencode-server.ts");
      const server = await startManagedOpenCodeServer({ hostname: settings.hostname, port: settings.port, signal });
      const { OpenCodeScheduler, OpenCodeSdkRuntime } = await import("./scheduler/opencode-scheduler.ts");
      const runner = new OpenCodeScheduler(controlPlane, new OpenCodeSdkRuntime(server.url), settings.rootDirectory);
      try {
        print({ status: "started", opencode: server.url, projectId: settings.projectId, database: settings.database, rootDirectory: settings.rootDirectory, secured: Boolean(Bun.env.OPENCODE_SERVER_PASSWORD) });
        while (!signal.aborted) {
          const result = await runner.reconcile(settings.projectId);
          if (result.updated || result.notified || result.unknown) print(result);
          await Bun.sleep(flags.interval);
        }
      } finally {
        server.close();
      }
    } finally {
      store.close();
    }
  },
});

const cli = await createCLI({ name: "linear-crew", version: "0.1.0", description: "Local control plane for AI agent crews" });
cli.command(serve);
cli.command(projectCreate);
cli.command(projectList);
cli.command(guide);
cli.command(roleAdd);
cli.command(repositoryAdd);
cli.command(workspaceAdd);
cli.command(workAdd);
cli.command(status);
cli.command(tui);
cli.command(opencodeConfigure);
cli.command(scheduler);
cli.command(runtime);
await cli.run();
