import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const BAKE_DIRECTORY = path.join(os.homedir(), "bake");
const BAKE_METADATA_DIRECTORY = path.join(BAKE_DIRECTORY, "meta");
const CURRENT_PROJECT_ID_KEY = "currentProjectId";
const CURRENT_PROJECT_PATH_KEY = "currentProjectPath";

type ProjectMetadata = Record<string, unknown>;

class BakeProject extends vscode.TreeItem {
    public constructor(
        public readonly metadataPath: string,
        public readonly location: string,
        public readonly metadata: ProjectMetadata,
        public readonly projectId: string | undefined,
        public readonly isCurrent: boolean,
        public readonly isUsedByCurrent: boolean,
        public readonly dependencyChain: readonly string[] = [],
        public readonly isUninstalling: boolean = false
    ) {
        const name = firstText(metadata, ["id", "name", "title", "projectName"]) ?? path.basename(metadataPath);
        super(name, vscode.TreeItemCollapsibleState.Collapsed);

        this.contextValue = "bakeProject";
        const description = projectDescription(metadata);
        const status = [
            ...(isUninstalling ? ["Uninstalling\u2026"] : []),
            ...(isCurrent ? ["Active"] : []),
            ...(isUsedByCurrent ? ["Used by Active"] : [])
        ].join(" + ");
        this.description = [status || undefined, description].filter(isDefined).join(" - ") || undefined;
        this.tooltip = projectTooltip(name, location, metadata, isCurrent, isUsedByCurrent);
        this.iconPath = isUninstalling
            ? new vscode.ThemeIcon("trash", new vscode.ThemeColor("testing.iconFailed"))
            : new vscode.ThemeIcon(
                isCurrent ? "star-full" : isUsedByCurrent ? "link" : "package",
                isUsedByCurrent ? new vscode.ThemeColor("testing.iconPassed") : undefined
            );
    }
}

class ProjectGroup extends vscode.TreeItem {
    public constructor(
        public readonly type: string,
        public readonly projects: BakeProject[]
    ) {
        super(humanize(type), vscode.TreeItemCollapsibleState.Collapsed);

        this.description = `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
        this.tooltip = `${humanize(type)} projects`;
        this.iconPath = new vscode.ThemeIcon("symbol-namespace");
    }
}

class ProjectDetail extends vscode.TreeItem {
    public constructor(label: string, value: string, icon: string) {
        super(label, vscode.TreeItemCollapsibleState.None);

        this.description = value;
        this.tooltip = `${label}: ${value}`;
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

type BakeTreeItem = ProjectGroup | BakeProject | ProjectDetail;

class BakeProjectsProvider implements vscode.TreeDataProvider<BakeTreeItem> {
    private readonly changeEmitter = new vscode.EventEmitter<BakeTreeItem | undefined>();
    private readonly projectsById = new Map<string, BakeProject>();
    private readonly uninstallingProjectIds = new Set<string>();

    public readonly onDidChangeTreeData: vscode.Event<BakeTreeItem | undefined> =
        this.changeEmitter.event;

    public constructor(
        private currentProjectId: string | undefined,
        private currentProjectPath: string | undefined
    ) {}

    public refresh(): void {
        this.changeEmitter.fire(undefined);
    }

    public markUninstalling(projectId: string): void {
        this.uninstallingProjectIds.add(projectId);
        this.changeEmitter.fire(undefined);
    }

    public clearUninstalling(projectId: string): void {
        this.uninstallingProjectIds.delete(projectId);
        this.changeEmitter.fire(undefined);
    }

    public setCurrentProject(projectId: string, projectPath: string): void {
        this.currentProjectId = projectId;
        this.currentProjectPath = projectPath;
        this.changeEmitter.fire(undefined);
    }

    public getTreeItem(element: BakeTreeItem): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: BakeTreeItem): Promise<BakeTreeItem[]> {
        if (element instanceof ProjectGroup) {
            return element.projects;
        }

        if (element instanceof BakeProject) {
            return [
                ...(await this.projectDependencies(element)),
                ...projectDetails(element)
            ];
        }

        if (element) {
            return [];
        }

        try {
            const entries = await fs.readdir(BAKE_METADATA_DIRECTORY, { withFileTypes: true });
            const projects = await Promise.all(
                entries
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => readProject(path.join(BAKE_METADATA_DIRECTORY, entry.name)))
            );

            const validProjects = projects.filter((project): project is BakeProject => project !== undefined);
            let currentProject = validProjects.find(
                (project) => !!this.currentProjectId && project.projectId === this.currentProjectId
            );
            if (!currentProject && this.currentProjectPath) {
                currentProject = await readProject(path.dirname(this.currentProjectPath));
            }
            const allProjects = currentProject && !validProjects.some(
                (project) => project.projectId === currentProject!.projectId
            )
                ? [...validProjects, currentProject]
                : validProjects;
            this.projectsById.clear();
            for (const project of allProjects) {
                if (project.projectId) {
                    this.projectsById.set(project.projectId, project);
                }
            }
            const usedProjectIds = currentProject
                ? collectDependencyIds(currentProject, this.projectsById)
                : new Set<string>();
            const decoratedProjects = allProjects
                .map(
                    (project) => {
                        const isCurrent = !!this.currentProjectId && project.projectId === this.currentProjectId;
                        const isUsedByCurrent =
                            !isCurrent && !!project.projectId && usedProjectIds.has(project.projectId);

                        return new BakeProject(
                            project.metadataPath,
                            project.location,
                            project.metadata,
                            project.projectId,
                            isCurrent,
                            isUsedByCurrent,
                            project.projectId ? [project.projectId] : [],
                            !!project.projectId && this.uninstallingProjectIds.has(project.projectId)
                        );
                    }
                )
                .sort((left, right) => left.label!.toString().localeCompare(right.label!.toString()));
            const decoratedCurrentProject = decoratedProjects.find((project) => project.isCurrent);

            return [
                ...(decoratedCurrentProject ? [decoratedCurrentProject] : []),
                ...groupProjects(decoratedProjects)
            ];
        } catch (error: unknown) {
            if (isMissingDirectory(error)) {
                return [];
            }

            void vscode.window.showErrorMessage(
                `Unable to read Bake projects in ${BAKE_METADATA_DIRECTORY}: ${formatError(error)}`
            );
            return [];
        }
    }

    private async projectDependencies(project: BakeProject): Promise<BakeProject[]> {
        const dependencies: BakeProject[] = [];

        for (const projectId of projectUseIds(project.metadata)) {
            if (project.dependencyChain.includes(projectId)) {
                continue;
            }

            const dependency = this.projectsById.get(projectId);
            if (dependency) {
                dependencies.push(
                    new BakeProject(
                        dependency.metadataPath,
                        dependency.location,
                        dependency.metadata,
                        dependency.projectId,
                        dependency.isCurrent,
                        !dependency.isCurrent,
                        [...project.dependencyChain, projectId]
                    )
                );
            }
        }

        return dependencies;
    }
}

function groupProjects(projects: BakeProject[]): ProjectGroup[] {
    const projectsByType = new Map<string, BakeProject[]>();

    for (const project of projects) {
        const type = firstText(project.metadata, ["type", "kind"]) ?? "other";
        const group = projectsByType.get(type);
        if (group) {
            group.push(project);
        } else {
            projectsByType.set(type, [project]);
        }
    }

    return [...projectsByType.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, groupedProjects]) => new ProjectGroup(type, groupedProjects));
}

async function readProject(
    projectPath: string
): Promise<BakeProject | undefined> {
    const metadataPath = path.join(projectPath, "project.json");

    try {
        const contents = await fs.readFile(metadataPath, "utf8");
        const metadata = parseMetadata(contents, metadataPath);
        const location = await projectLocation(projectPath, metadata);
        const projectId = firstText(metadata, ["id", "name", "title", "projectName"]);
        return new BakeProject(projectPath, location, metadata, projectId, false, false);
    } catch (error: unknown) {
        if (isMissingDirectory(error)) {
            return undefined;
        }

        void vscode.window.showWarningMessage(
            `Unable to read Bake project metadata at ${metadataPath}: ${formatError(error)}`
        );
        return undefined;
    }
}

async function projectLocation(metadataDirectory: string, metadata: ProjectMetadata): Promise<string> {
    const manifestLocation =
        firstText(metadata, ["location"]) ?? nestedText(metadata, "value", ["location"]);

    if (manifestLocation) {
        return path.isAbsolute(manifestLocation)
            ? manifestLocation
            : path.resolve(metadataDirectory, manifestLocation);
    }

    const sourcePath = path.join(metadataDirectory, "source.txt");
    try {
        const location = (await fs.readFile(sourcePath, "utf8")).trim();
        return location || metadataDirectory;
    } catch (error: unknown) {
        if (isMissingDirectory(error)) {
            return metadataDirectory;
        }

        throw error;
    }
}

function parseMetadata(contents: string, metadataPath: string): ProjectMetadata {
    const parsed: unknown = JSON.parse(contents);

    if (!isRecord(parsed)) {
        throw new Error(`${metadataPath} must contain a JSON object`);
    }

    return parsed;
}

function projectDescription(metadata: ProjectMetadata): string | undefined {
    const version = firstText(metadata, ["version"]);
    const kind = firstText(metadata, ["type", "kind"]);
    const language = nestedText(metadata, "value", ["language"]);
    const description = firstText(metadata, ["description", "summary", "tagline"]) ?? language;
    const identity = [version ? `v${version}` : undefined, kind].filter(isDefined).join(" - ");

    if (identity && description) {
        return `${identity} - ${description}`;
    }

    return identity || description;
}

function projectTooltip(
    name: string,
    projectPath: string,
    metadata: ProjectMetadata,
    isCurrent: boolean,
    isUsedByCurrent: boolean
): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = false;
    tooltip.appendMarkdown(`### ${escapeMarkdown(name)}\n\n`);

    if (isCurrent) {
        tooltip.appendMarkdown("**Status:** Current project  \n");
    } else if (isUsedByCurrent) {
        tooltip.appendMarkdown("**Status:** Used by current project  \n");
    }

    const description = firstText(metadata, ["description", "summary", "tagline"]);
    if (description) {
        tooltip.appendMarkdown(`${escapeMarkdown(description)}\n\n`);
    }

    for (const [label, value] of metadataEntries(metadata)) {
        tooltip.appendMarkdown(`**${escapeMarkdown(label)}:** ${escapeMarkdown(value)}  \n`);
    }

    tooltip.appendMarkdown(`**Location:** \`${escapeCode(projectPath)}\``);
    return tooltip;
}

function projectDetails(project: BakeProject): ProjectDetail[] {
    return [
        ...(project.isCurrent ? [new ProjectDetail("Status", "Current project", "star-full")] : []),
        ...(project.isUsedByCurrent
            ? [new ProjectDetail("Status", "Used by current project", "link")]
            : []),
        ...metadataEntries(project.metadata).map(([label, value]) => new ProjectDetail(label, value, "info")),
        new ProjectDetail("Location", project.location, "folder")
    ];
}

function metadataEntries(metadata: ProjectMetadata): [string, string][] {
    const preferredFields: [string, string[]][] = [
        ["Version", ["version"]],
        ["Description", ["description", "summary", "tagline"]],
        ["Type", ["type", "kind"]],
        ["Language", ["language"]],
        ["Author", ["author", "owner", "maintainer"]],
        ["Identifier", ["id", "identifier"]]
    ];
    const entries: [string, string][] = [];
    const usedKeys = new Set<string>();

    for (const [label, keys] of preferredFields) {
        const key = keys.find((candidate) => textValue(metadata[candidate]) !== undefined);
        const value = key ? textValue(metadata[key]) : undefined;
        if (key && value) {
            entries.push([label, value]);
            usedKeys.add(key);
        }
    }

    const value = isRecord(metadata.value) ? metadata.value : undefined;
    if (value) {
        for (const [label, keys] of [["Language", ["language"]], ["Public", ["public"]]] as const) {
            const key = keys.find((candidate) => textValue(value[candidate]) !== undefined);
            const fieldValue = key ? textValue(value[key]) : undefined;
            if (key && fieldValue) {
                entries.push([label, fieldValue]);
            }
        }
    }

    for (const [key, value] of Object.entries(metadata)) {
        const text = textValue(value);
        if (!usedKeys.has(key) && text && key !== "name" && key !== "title" && key !== "projectName") {
            entries.push([humanize(key), text]);
        }
    }

    return entries;
}

function nestedText(metadata: ProjectMetadata, key: string, keys: string[]): string | undefined {
    return isRecord(metadata[key]) ? firstText(metadata[key], keys) : undefined;
}

function projectUseIds(metadata: ProjectMetadata): Set<string> {
    const projectIds = new Set<string>();
    const use = metadata.use ?? (isRecord(metadata.value) ? metadata.value.use : undefined);

    if (typeof use === "string") {
        for (const value of splitIdentifiers(use)) {
            projectIds.add(value);
        }
        return projectIds;
    }

    if (Array.isArray(use)) {
        for (const entry of use) {
            const text = textValue(entry);
            if (text) {
                for (const value of splitIdentifiers(text)) {
                    projectIds.add(value);
                }
            }
        }
        return projectIds;
    }

    if (isRecord(use)) {
        const identifier = firstText(use, ["id", "name", "project"]);
        if (identifier) {
            for (const value of splitIdentifiers(identifier)) {
                projectIds.add(value);
            }
        }

        for (const [key, value] of Object.entries(use)) {
            if (typeof value === "boolean") {
                if (value) {
                    projectIds.add(key);
                }
                continue;
            }

            const text = textValue(value);
            if (text) {
                for (const splitValue of splitIdentifiers(text)) {
                    projectIds.add(splitValue);
                }
            }
        }
    }

    return projectIds;
}

function collectDependencyIds(project: BakeProject, projectsById: Map<string, BakeProject>): Set<string> {
    const dependencyIds = new Set<string>();
    const visitedIds = new Set<string>();

    function walk(currentProject: BakeProject): void {
        if (currentProject.projectId && visitedIds.has(currentProject.projectId)) {
            return;
        }

        if (currentProject.projectId) {
            visitedIds.add(currentProject.projectId);
        }

        for (const dependencyId of projectUseIds(currentProject.metadata)) {
            dependencyIds.add(dependencyId);
            const dependency = projectsById.get(dependencyId);
            if (dependency) {
                walk(dependency);
            }
        }
    }

    walk(project);
    return dependencyIds;
}

function splitIdentifiers(value: string): string[] {
    return value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function firstText(metadata: ProjectMetadata, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = textValue(metadata[key]);
        if (value) {
            return value;
        }
    }

    return undefined;
}

function textValue(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    if (isRecord(value) && typeof value.name === "string" && value.name.trim()) {
        return value.name.trim();
    }

    return undefined;
}

function isRecord(value: unknown): value is ProjectMetadata {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

function humanize(key: string): string {
    return key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}[\]<>()#+\-.!|]/g, "\\$&");
}

function escapeCode(value: string): string {
    return value.replace(/`/g, "\\`");
}

function isMissingDirectory(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new BakeProjectsProvider(
        context.workspaceState.get<string>(CURRENT_PROJECT_ID_KEY),
        context.workspaceState.get<string>(CURRENT_PROJECT_PATH_KEY)
    );

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("bakeProjects.explorer", provider),
        vscode.commands.registerCommand("bakeProjects.refresh", () => provider.refresh()),
        vscode.commands.registerCommand("bakeProjects.open", async (project: BakeProject) => {
            await vscode.commands.executeCommand(
                "vscode.openFolder",
                vscode.Uri.file(project.location),
                true
            );
        }),
        vscode.commands.registerCommand("bakeProjects.run", (project: BakeProject) =>
            runBake(project, ["run"])
        ),
        vscode.commands.registerCommand("bakeProjects.buildRecursive", (project: BakeProject) =>
            runBake(project, ["build", "-r"])
        ),
        vscode.commands.registerCommand("bakeProjects.rebuild", (project: BakeProject) =>
            runBake(project, ["rebuild"])
        ),
        vscode.commands.registerCommand("bakeProjects.rebuildRecursive", (project: BakeProject) =>
            runBake(project, ["rebuild", "-r"])
        ),
        vscode.commands.registerCommand("bakeProjects.uninstall", (project: BakeProject) => {
            const projectKey = project.projectId ?? project.label!.toString();
            provider.markUninstalling(projectKey);
            runBakeUninstall(project, () => {
                provider.clearUninstalling(projectKey);
                provider.refresh();
            });
        }),
        vscode.commands.registerCommand("bakeProjects.setCurrentProject", async (projectUri?: vscode.Uri) => {
            if (!projectUri || projectUri.scheme !== "file" || path.basename(projectUri.fsPath) !== "project.json") {
                void vscode.window.showErrorMessage("Select a local Bake project.json file.");
                return;
            }

            try {
                const contents = Buffer.from(await vscode.workspace.fs.readFile(projectUri)).toString("utf8");
                const metadata = parseMetadata(contents, projectUri.fsPath);
                const projectId = firstText(metadata, ["id", "name", "title", "projectName"]);

                if (!projectId) {
                    void vscode.window.showErrorMessage("The selected project.json does not define a Bake project ID.");
                    return;
                }

                await context.workspaceState.update(CURRENT_PROJECT_ID_KEY, projectId);
                await context.workspaceState.update(CURRENT_PROJECT_PATH_KEY, projectUri.fsPath);
                provider.setCurrentProject(projectId, projectUri.fsPath);
                void vscode.window.showInformationMessage(`${projectId} is the current Bake project.`);
            } catch (error: unknown) {
                void vscode.window.showErrorMessage(
                    `Unable to set the current Bake project: ${formatError(error)}`
                );
            }
        })
    );
}

function runBake(project: BakeProject, arguments_: string[]): void {
    const terminal = vscode.window.createTerminal({ name: `Bake: ${project.label}` });
    terminal.show(true);
    terminal.sendText(`bake ${arguments_.join(" ")} ${shellQuote(project.location)}`);
}

function runBakeUninstall(project: BakeProject, onFinished: () => void): void {
    const projectName = project.projectId ?? project.label!.toString();
    const commandLine = `bake uninstall ${shellQuote(projectName)}`;
    const terminal = vscode.window.createTerminal({ name: `Bake: ${project.label}` });
    terminal.show(true);

    if (terminal.shellIntegration) {
        runInShellIntegration(terminal, commandLine, onFinished);
        return;
    }

    const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal) {
            disposable.dispose();
            runInShellIntegration(terminal, commandLine, onFinished);
        }
    });
}

function runInShellIntegration(terminal: vscode.Terminal, commandLine: string, onFinished: () => void): void {
    if (!terminal.shellIntegration) {
        terminal.sendText(commandLine);
        return;
    }

    const execution = terminal.shellIntegration.executeCommand(commandLine);
    const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
            disposable.dispose();
            onFinished();
        }
    });
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function deactivate(): void {}
