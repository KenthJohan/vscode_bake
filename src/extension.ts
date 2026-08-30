import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const BUILD_TOOL_CONFIGURATION_KEY = "buildTool";
const DIRECTORY_CONFIGURATION_KEY = "directory";
const LD_LIBRARY_PATH_CONFIGURATION_KEY = "ldLibraryPath";
const SYSTEM_LIBRARY_PATH_CONFIGURATION_KEY = "systemLibraryPath";
const DEFAULT_BAKE_DIRECTORY_NAME = "bake3";
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

type BakeTreeItem =
    | ProjectGroup
    | BakeProject
    | SubprojectGroup
    | TestGroup
    | TestSuiteItem
    | TestCaseItem
    | ProjectDetail
    | LibraryReference
    | LibraryPathGroup
    | LibraryPathItem;

class ProjectGroup extends vscode.TreeItem {
    public constructor(
        public readonly type: string,
        public readonly children: BakeTreeItem[],
        itemLabel: string = "projects"
    ) {
        super(humanize(type), vscode.TreeItemCollapsibleState.Collapsed);

        this.description = `${children.length} ${children.length === 1 ? itemLabel.slice(0, -1) : itemLabel}`;
        this.tooltip = `${humanize(type)} ${itemLabel}`;
        this.iconPath = new vscode.ThemeIcon("symbol-namespace");
    }
}

class TestGroup extends vscode.TreeItem {
    public constructor(
        public readonly project: BakeProject,
        public readonly children: TestSuiteItem[]
    ) {
        super("Tests", vscode.TreeItemCollapsibleState.Collapsed);

        this.contextValue = "bakeTests";
        this.description = `${children.length} ${children.length === 1 ? "suite" : "suites"}`;
        this.tooltip = `Tests (${children.length} test ${children.length === 1 ? "suite" : "suites"})`;
        this.iconPath = new vscode.ThemeIcon("beaker");
    }
}

class TestSuiteItem extends vscode.TreeItem {
    public constructor(
        public readonly id: string,
        public readonly children: TestCaseItem[],
        public readonly projectLocation: string
    ) {
        super(
            id,
            children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.contextValue = "bakeTestSuite";
        this.description =
            children.length > 0
                ? `${children.length} ${children.length === 1 ? "testcase" : "testcases"}`
                : undefined;
        this.tooltip = `Test suite: ${id}${children.length > 0 ? ` (${children.length} testcases)` : ""}`;
        this.iconPath = new vscode.ThemeIcon("symbol-class");
        this.command = {
            command: "bakeProjects.openTestSuiteFile",
            title: "Open Test Suite File",
            arguments: [this]
        };
    }
}

class TestCaseItem extends vscode.TreeItem {
    public constructor(public readonly name: string) {
        super(name, vscode.TreeItemCollapsibleState.None);

        this.contextValue = "bakeTestCase";
        this.tooltip = `Test case: ${name}`;
        this.iconPath = new vscode.ThemeIcon("symbol-method");
    }
}

class SubprojectGroup extends vscode.TreeItem {
    public constructor(
        public readonly project: BakeProject,
        public readonly children: BakeProject[]
    ) {
        super("Subprojects", vscode.TreeItemCollapsibleState.Collapsed);

        this.contextValue = "bakeSubprojects";
        this.description = `${children.length} ${children.length === 1 ? "project" : "projects"}`;
        this.tooltip = `Nested Bake projects in ${project.location}`;
        this.iconPath = new vscode.ThemeIcon("project");
    }
}

class LibraryPathGroup extends vscode.TreeItem {
    public constructor(
        public readonly title: string,
        public readonly children: LibraryPathItem[],
        iconName: string = "folder-library"
    ) {
        super(title, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = `${children.length} ${children.length === 1 ? "directory" : "directories"}`;
        this.tooltip = `${title} (${children.length} directories)`;
        this.iconPath = new vscode.ThemeIcon(iconName);
    }
}

class LibraryPathItem extends vscode.TreeItem {
    public constructor(
        public readonly dirPath: string,
        public readonly exists: boolean
    ) {
        super(dirPath, vscode.TreeItemCollapsibleState.None);

        this.contextValue = "bakeLibraryPathItem";
        this.tooltip = `${dirPath}${exists ? " (directory exists)" : " (directory does not exist)"}`;
        this.description = exists ? undefined : "not found";
        this.iconPath = new vscode.ThemeIcon(
            exists ? "folder" : "folder-active",
            exists ? undefined : new vscode.ThemeColor("testing.iconFailed")
        );
        this.command = {
            command: "bakeProjects.openPathInOS",
            title: "Open Folder in OS",
            arguments: [dirPath]
        };
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

class LibraryReference extends vscode.TreeItem {
    public constructor(
        public readonly name: string,
        public readonly project?: BakeProject,
        public readonly exists: boolean = true,
        public readonly resolvedPath?: string
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);

        this.contextValue = "bakeLibrary";
        this.description = exists ? undefined : "not found";
        this.tooltip = exists
            ? (resolvedPath ? `Library: ${name}\nPath: ${resolvedPath}` : `Library: ${name}`)
            : `Library: ${name} (not found)`;
        this.iconPath = new vscode.ThemeIcon(
            "library",
            exists ? undefined : new vscode.ThemeColor("testing.iconFailed")
        );
    }
}

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
        if (
            element instanceof ProjectGroup ||
            element instanceof LibraryPathGroup ||
            element instanceof TestGroup ||
            element instanceof TestSuiteItem ||
            element instanceof SubprojectGroup
        ) {
            return element.children;
        }

        if (element instanceof BakeProject) {
            const subprojects = await findSubprojects(element);
            const testSuites = parseTestSuites(element.metadata, element.location);
            const dependencies = await this.projectDependencies(element);
            const libraries = await this.projectLibraries(element);
            return [
                ...(testSuites.length > 0 ? [new TestGroup(element, testSuites)] : []),
                ...(subprojects.length > 0 ? [new SubprojectGroup(element, subprojects)] : []),
                ...(dependencies.length > 0 ? [new ProjectGroup("use", dependencies)] : []),
                ...(libraries.length > 0 ? [new ProjectGroup("lib", libraries, "libraries")] : []),
                ...projectDetails(element)
            ];
        }

        if (element) {
            return [];
        }

        const metadataDirectory = bakeMetadataDirectory();
        let decoratedProjects: BakeProject[] = [];
        let decoratedCurrentProject: BakeProject | undefined;
        let currentProject: BakeProject | undefined;

        try {
            const entries = await fs.readdir(metadataDirectory, { withFileTypes: true });
            const projects = await Promise.all(
                entries
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => readProject(path.join(metadataDirectory, entry.name)))
            );

            const validProjects = projects.filter((project): project is BakeProject => project !== undefined);
            currentProject = validProjects.find(
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
            decoratedProjects = allProjects
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
            decoratedCurrentProject = decoratedProjects.find((project) => project.isCurrent);
        } catch (error: unknown) {
            if (!isMissingDirectory(error)) {
                void vscode.window.showErrorMessage(
                    `Unable to read Bake projects in ${metadataDirectory}: ${formatError(error)}`
                );
            }
        }

        const libraryPathGroups = await getLibraryPathRootGroups(currentProject);

        return [
            ...(decoratedCurrentProject ? [decoratedCurrentProject] : []),
            ...groupProjects(decoratedProjects),
            ...libraryPathGroups
        ];
    }

    private async projectDependencies(project: BakeProject): Promise<BakeProject[]> {
        return this.projectReferences(project, projectUseIds(project.metadata));
    }

    private async projectLibraries(project: BakeProject): Promise<LibraryReference[]> {
        const libNames = [...projectLibIds(project.metadata)];
        if (libNames.length === 0) {
            return [];
        }

        const candidateDirs = await getCandidateLibraryDirectories(project);
        const dirFilesMap = new Map<string, string[]>();

        return Promise.all(
            libNames.map(async (name) => {
                const resolved = await findLibraryFile(name, project, candidateDirs, dirFilesMap);
                return new LibraryReference(name, project, resolved !== undefined, resolved);
            })
        );
    }

    private async projectReferences(project: BakeProject, projectIds: Set<string>): Promise<BakeProject[]> {
        const references: BakeProject[] = [];

        for (const projectId of projectIds) {
            if (project.dependencyChain.includes(projectId)) {
                continue;
            }

            const dependency = this.projectsById.get(projectId);
            if (dependency) {
                references.push(
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

        return references;
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

async function findSubprojects(project: BakeProject): Promise<BakeProject[]> {
    const rootLocation = project.location;
    const subprojects: BakeProject[] = [];

    async function visit(directory: string): Promise<void> {
        if (directory !== rootLocation) {
            const subproject = await readProject(directory);
            if (subproject) {
                subprojects.push(subproject);
                return;
            }
        }

        let entries: Dirent[];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error: unknown) {
            if (isMissingDirectory(error)) {
                return;
            }
            throw error;
        }

        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
                .map((entry) => visit(path.join(directory, entry.name)))
        );
    }

    try {
        await visit(rootLocation);
    } catch (error: unknown) {
        void vscode.window.showWarningMessage(
            `Unable to read Bake subprojects in ${rootLocation}: ${formatError(error)}`
        );
    }

    return subprojects.sort((left, right) => left.label!.toString().localeCompare(right.label!.toString()));
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

function projectLibIds(metadata: ProjectMetadata): Set<string> {
    const projectIds = new Set<string>();

    for (const [key, value] of Object.entries(metadata)) {
        if (!key.startsWith("lang.") || !isRecord(value)) {
            continue;
        }

        const libraries = value.lib;
        if (typeof libraries === "string") {
            for (const library of splitIdentifiers(libraries)) {
                projectIds.add(library);
            }
        } else if (Array.isArray(libraries)) {
            for (const library of libraries) {
                const name = textValue(library);
                if (name) {
                    for (const identifier of splitIdentifiers(name)) {
                        projectIds.add(identifier);
                    }
                }
            }
        }
    }

    return projectIds;
}

function parseTestSuites(metadata: ProjectMetadata, projectLocation: string): TestSuiteItem[] {
    const test = isRecord(metadata.test) ? metadata.test : undefined;
    if (!test) {
        return [];
    }

    const rawSuites = Array.isArray(test.testsuites) ? test.testsuites : undefined;
    if (!rawSuites) {
        return [];
    }

    const suites: TestSuiteItem[] = [];
    for (const rawSuite of rawSuites) {
        if (isRecord(rawSuite)) {
            const suiteId = firstText(rawSuite, ["id", "name", "title"]);
            if (!suiteId) {
                continue;
            }

            const rawCases = Array.isArray(rawSuite.testcases) ? rawSuite.testcases : [];
            const testCases: TestCaseItem[] = [];
            for (const rawCase of rawCases) {
                const caseName = textValue(rawCase);
                if (caseName) {
                    testCases.push(new TestCaseItem(caseName));
                }
            }
            suites.push(new TestSuiteItem(suiteId, testCases, projectLocation));
        } else if (typeof rawSuite === "string" && rawSuite.trim()) {
            suites.push(new TestSuiteItem(rawSuite.trim(), [], projectLocation));
        }
    }

    return suites;
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

    if (isRecord(value)) {
        const identifier = firstText(value, ["name", "id", "project"]);
        if (identifier) {
            return identifier;
        }
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
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration(`bakeProjects.${DIRECTORY_CONFIGURATION_KEY}`) ||
                event.affectsConfiguration(`bakeProjects.${LD_LIBRARY_PATH_CONFIGURATION_KEY}`) ||
                event.affectsConfiguration(`bakeProjects.${SYSTEM_LIBRARY_PATH_CONFIGURATION_KEY}`)
            ) {
                provider.refresh();
            }
        }),
        vscode.commands.registerCommand("bakeProjects.refresh", () => provider.refresh()),
        vscode.commands.registerCommand("bakeProjects.open", async (project: BakeProject) => {
            await vscode.commands.executeCommand(
                "vscode.openFolder",
                vscode.Uri.file(project.location),
                true
            );
        }),
        vscode.commands.registerCommand("bakeProjects.openLibraryFolder", async (library?: LibraryReference) => {
            if (library instanceof LibraryReference) {
                await openLibraryFolder(library);
            }
        }),
        vscode.commands.registerCommand("bakeProjects.openTestSuiteFile", async (suiteItem?: TestSuiteItem) => {
            if (suiteItem instanceof TestSuiteItem) {
                await openTestSuiteFile(suiteItem);
            }
        }),
        vscode.commands.registerCommand("bakeProjects.openPathInOS", async (target?: string | LibraryPathItem) => {
            const targetPath = typeof target === "string" ? target : target?.dirPath;
            if (!targetPath) {
                return;
            }
            try {
                await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(targetPath));
            } catch (error: unknown) {
                void vscode.window.showErrorMessage(
                    `Unable to open directory ${targetPath}: ${formatError(error)}`
                );
            }
        }),
        vscode.commands.registerCommand("bakeProjects.run", (project: BakeProject) =>
            runBake(project, ["run"])
        ),
        vscode.commands.registerCommand("bakeProjects.test", (tests: TestGroup) =>
            runBake(tests.project, ["test"])
        ),
        vscode.commands.registerCommand("bakeProjects.addTestSuite", (target?: BakeProject | TestGroup) =>
            addTestSuite(target, provider)
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
    terminal.sendText(`${buildTool()} ${arguments_.join(" ")} ${shellQuote(project.location)}`);
}

function runBakeUninstall(project: BakeProject, onFinished: () => void): void {
    const projectName = project.projectId ?? project.label!.toString();
    const commandLine = `${buildTool()} uninstall ${shellQuote(projectName)}`;
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

function buildTool(): "bake" | "bake3" {
    return vscode.workspace.getConfiguration("bakeProjects").get<string>(BUILD_TOOL_CONFIGURATION_KEY) === "bake3"
        ? "bake3"
        : "bake";
}

function bakeDirectory(): string {
    const configured = vscode.workspace.getConfiguration("bakeProjects").get<string>(DIRECTORY_CONFIGURATION_KEY);
    const directoryName = configured?.trim() || DEFAULT_BAKE_DIRECTORY_NAME;
    return path.isAbsolute(directoryName) ? directoryName : path.join(os.homedir(), directoryName);
}

function bakeMetadataDirectory(): string {
    return path.join(bakeDirectory(), "meta");
}

async function openLibraryFolder(library: LibraryReference): Promise<void> {
    const libraryName = library.name;
    if (!libraryName) {
        void vscode.window.showErrorMessage("No library name specified.");
        return;
    }

    const candidateDirs = await getCandidateLibraryDirectories(library.project);
    const resolvedPath = await findLibraryFile(libraryName, library.project, candidateDirs);

    if (resolvedPath) {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(resolvedPath));
        return;
    }

    const existingDirs: string[] = [];
    for (const dir of candidateDirs) {
        try {
            const stat = await fs.stat(dir);
            if (stat.isDirectory()) {
                existingDirs.push(dir);
            }
        } catch {
            // Skip
        }
    }

    if (existingDirs.length > 0) {
        void vscode.window.showErrorMessage(
            `Could not find library "${libraryName}" in library directories:\n${existingDirs.join("\n")}`
        );
    } else {
        void vscode.window.showErrorMessage(
            `None of the library directories exist. Checked paths:\n${candidateDirs.join("\n")}`
        );
    }
}

async function openTestSuiteFile(suiteItem: TestSuiteItem): Promise<void> {
    const projectLocation = suiteItem.projectLocation;
    const suiteId = suiteItem.id;
    if (!projectLocation || !suiteId) {
        return;
    }

    const srcDir = path.join(projectLocation, "src");
    const candidates = [
        suiteId,
        `${suiteId}.c`,
        `${suiteId}.cpp`,
        `${suiteId}.cc`,
        `${suiteId}.cxx`
    ];

    for (const candidate of candidates) {
        const filePath = path.join(srcDir, candidate);
        try {
            const stat = await fs.stat(filePath);
            if (stat.isFile()) {
                await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
                return;
            }
        } catch {
            // File does not exist, check next candidate
        }
    }

    void vscode.window.showErrorMessage(
        `Could not find source file for test suite "${suiteId}" in ${srcDir}`
    );
}

async function getCandidateLibraryDirectories(project?: BakeProject): Promise<string[]> {
    const ldDirs = await getLdLibraryPathDirectories(project);
    const sysDirs = getSystemLibraryPathDirectories(project);
    const candidateDirs = [...ldDirs];
    for (const sysDir of sysDirs) {
        if (!candidateDirs.includes(sysDir)) {
            candidateDirs.push(sysDir);
        }
    }
    return candidateDirs;
}

async function findLibraryFile(
    libraryName: string,
    project?: BakeProject,
    candidateDirs?: string[],
    dirFilesMap?: Map<string, string[]>
): Promise<string | undefined> {
    const expandedDirectPath = expandPath(libraryName, project);
    try {
        await fs.stat(expandedDirectPath);
        return expandedDirectPath;
    } catch {
        // Not a direct path
    }

    const dirs = candidateDirs ?? (await getCandidateLibraryDirectories(project));

    for (const dir of dirs) {
        try {
            let files: string[] | undefined = dirFilesMap?.get(dir);
            if (!files) {
                const stat = await fs.stat(dir);
                if (!stat.isDirectory()) {
                    continue;
                }
                const readFiles = await fs.readdir(dir);
                files = readFiles;
                dirFilesMap?.set(dir, readFiles);
            }

            for (const file of files) {
                if (isLibraryMatch(file, libraryName)) {
                    return path.join(dir, file);
                }
            }
        } catch {
            // Skip directory on error
        }
    }

    return undefined;
}

interface LdLibraryPathEntry {
    rawPath: string;
    workspaceFolder?: string;
}

async function getLibraryPathRootGroups(project?: BakeProject): Promise<LibraryPathGroup[]> {
    const ldDirs = await getLdLibraryPathDirectories(project);
    const ldItems = await Promise.all(
        ldDirs.map(async (dir) => {
            const exists = await pathExists(dir);
            return new LibraryPathItem(dir, exists);
        })
    );
    const ldGroup = new LibraryPathGroup("LD_LIBRARY_PATH", ldItems, "library");

    const sysDirs = getSystemLibraryPathDirectories(project);
    const sysItems = await Promise.all(
        sysDirs.map(async (dir) => {
            const exists = await pathExists(dir);
            return new LibraryPathItem(dir, exists);
        })
    );
    const sysGroup = new LibraryPathGroup("System Library Path", sysItems, "references");

    return [ldGroup, sysGroup];
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(targetPath);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

async function getLdLibraryPathDirectories(project?: BakeProject): Promise<string[]> {
    const entries = await getLdLibraryPathEntries(project);
    return resolveDirectoriesFromEntries(entries, project);
}

function getSystemLibraryPathDirectories(project?: BakeProject): string[] {
    const configuredSystemLibraryPath = vscode.workspace
        .getConfiguration("bakeProjects")
        .get<string>(SYSTEM_LIBRARY_PATH_CONFIGURATION_KEY);

    if (!configuredSystemLibraryPath || !configuredSystemLibraryPath.trim()) {
        return [];
    }

    const entry: LdLibraryPathEntry = {
        rawPath: configuredSystemLibraryPath.trim(),
        workspaceFolder: project?.location
    };

    return resolveDirectoriesFromEntries([entry], project);
}

function resolveDirectoriesFromEntries(entries: LdLibraryPathEntry[], project?: BakeProject): string[] {
    const candidateDirs: string[] = [];
    for (const entry of entries) {
        const rawPaths = splitPathList(entry.rawPath);
        for (const rawPath of rawPaths) {
            const expanded = expandPath(rawPath, project, entry.workspaceFolder);
            for (const dir of splitPathList(expanded)) {
                if (dir && !candidateDirs.includes(dir)) {
                    candidateDirs.push(dir);
                }
            }
        }
    }
    return candidateDirs;
}

function splitPathList(rawPath: string): string[] {
    const results: string[] = [];
    let current = "";
    let insideBrackets = false;

    for (let i = 0; i < rawPath.length; i++) {
        const char = rawPath[i];
        const nextChar = rawPath[i + 1];

        if (char === "$" && nextChar === "{") {
            insideBrackets = true;
            current += char;
        } else if (insideBrackets && char === "}") {
            insideBrackets = false;
            current += char;
        } else if (!insideBrackets && (char === ":" || char === ";")) {
            if (current.trim()) {
                results.push(current.trim());
            }
            current = "";
        } else {
            current += char;
        }
    }

    if (current.trim()) {
        results.push(current.trim());
    }

    return results;
}

async function getLdLibraryPathEntries(project?: BakeProject): Promise<LdLibraryPathEntry[]> {
    const entries: LdLibraryPathEntry[] = [];

    const configuredLdLibraryPath = vscode.workspace
        .getConfiguration("bakeProjects")
        .get<string>(LD_LIBRARY_PATH_CONFIGURATION_KEY);
    if (configuredLdLibraryPath && configuredLdLibraryPath.trim()) {
        entries.push({
            rawPath: configuredLdLibraryPath.trim(),
            workspaceFolder: project?.location
        });
    }

    if (process.env.LD_LIBRARY_PATH && process.env.LD_LIBRARY_PATH.trim()) {
        entries.push({
            rawPath: process.env.LD_LIBRARY_PATH,
            workspaceFolder: project?.location
        });
    }

    const launchJsonPaths = new Set<string>();

    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            launchJsonPaths.add(path.join(folder.uri.fsPath, ".vscode", "launch.json"));
        }
    }

    if (project?.location) {
        launchJsonPaths.add(path.join(project.location, ".vscode", "launch.json"));
        launchJsonPaths.add(path.join(project.location, "launch.json"));
    }

    for (const launchJsonPath of launchJsonPaths) {
        try {
            const content = await fs.readFile(launchJsonPath, "utf8");
            const parsed = parseJsonc(content);
            const parentDir = path.dirname(launchJsonPath);
            const targetFolder = path.basename(parentDir) === ".vscode"
                ? path.dirname(parentDir)
                : parentDir;

            const values = extractLdLibraryPathFromLaunch(parsed);
            for (const val of values) {
                entries.push({
                    rawPath: val,
                    workspaceFolder: targetFolder
                });
            }
        } catch {
            // Skip missing or invalid launch.json
        }
    }

    if (entries.length === 0) {
        try {
            const launchConfig = vscode.workspace.getConfiguration("launch");
            const configurations = launchConfig.get<unknown[]>("configurations");
            if (Array.isArray(configurations)) {
                const values = extractLdLibraryPathFromLaunch({ configurations });
                for (const val of values) {
                    entries.push({
                        rawPath: val,
                        workspaceFolder: project?.location || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                    });
                }
            }
        } catch {
            // Ignore API lookup errors
        }
    }

    return entries;
}

function extractLdLibraryPathFromLaunch(parsed: unknown): string[] {
    const results: string[] = [];
    if (!isRecord(parsed)) {
        return results;
    }

    const configurations = parsed.configurations;
    if (!Array.isArray(configurations)) {
        return results;
    }

    for (const config of configurations) {
        if (!isRecord(config)) {
            continue;
        }

        if (Array.isArray(config.environment)) {
            for (const item of config.environment) {
                if (isRecord(item) && item.name === "LD_LIBRARY_PATH" && typeof item.value === "string" && item.value.trim()) {
                    results.push(item.value);
                }
            }
        } else if (isRecord(config.environment)) {
            if (typeof config.environment.LD_LIBRARY_PATH === "string" && config.environment.LD_LIBRARY_PATH.trim()) {
                results.push(config.environment.LD_LIBRARY_PATH);
            }
        }

        if (isRecord(config.env)) {
            if (typeof config.env.LD_LIBRARY_PATH === "string" && config.env.LD_LIBRARY_PATH.trim()) {
                results.push(config.env.LD_LIBRARY_PATH);
            }
        }
    }

    return results;
}

function parseJsonc(content: string): unknown {
    const stripped = stripJsonComments(content);
    return JSON.parse(stripped);
}

function stripJsonComments(jsonString: string): string {
    let isInsideString = false;
    let stringChar = "";
    let isEscaped = false;
    let result = "";

    for (let i = 0; i < jsonString.length; i++) {
        const char = jsonString[i];
        const nextChar = jsonString[i + 1];

        if (isInsideString) {
            result += char;
            if (isEscaped) {
                isEscaped = false;
            } else if (char === "\\") {
                isEscaped = true;
            } else if (char === stringChar) {
                isInsideString = false;
            }
        } else {
            if (char === '"' || char === "'") {
                isInsideString = true;
                stringChar = char;
                result += char;
            } else if (char === "/" && nextChar === "/") {
                i++;
                while (i < jsonString.length && jsonString[i] !== "\n" && jsonString[i] !== "\r") {
                    i++;
                }
                if (i < jsonString.length) {
                    result += jsonString[i];
                }
            } else if (char === "/" && nextChar === "*") {
                i += 2;
                while (i < jsonString.length - 1 && !(jsonString[i] === "*" && jsonString[i + 1] === "/")) {
                    i++;
                }
                i++;
            } else {
                result += char;
            }
        }
    }

    return result.replace(/,(\s*[}\]])/g, "$1");
}

function expandPath(rawPath: string, project?: BakeProject, targetWorkspaceFolder?: string): string {
    let expanded = rawPath.trim();

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const defaultWorkspace = targetWorkspaceFolder
        || (workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined)
        || project?.location;

    expanded = expanded.replace(/\$\{workspaceFolder:([^}]+)\}/g, (_, name: string) => {
        const matched = workspaceFolders?.find((folder) => folder.name === name);
        return matched ? matched.uri.fsPath : (defaultWorkspace ?? "");
    });

    if (defaultWorkspace) {
        expanded = expanded.replace(/\$\{(workspaceFolder|workspaceRoot)\}/g, defaultWorkspace);
    }

    expanded = expanded.replace(/\$\{env:([^}]+)\}/g, (_, varName: string) => {
        if (varName === "HOME" && !process.env.HOME) {
            return os.homedir();
        }
        return process.env[varName] ?? "";
    });

    expanded = expanded.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
        if (varName === "HOME" && !process.env.HOME) {
            return os.homedir();
        }
        return process.env[varName] ?? "";
    });

    expanded = expanded.replace(/\$([A-Za-z0-9_]+)/g, (_, varName: string) => {
        if (varName === "HOME" && !process.env.HOME) {
            return os.homedir();
        }
        return process.env[varName] ?? "";
    });

    if (expanded === "~" || expanded.startsWith("~/")) {
        expanded = path.join(os.homedir(), expanded.slice(1));
    }

    if (!path.isAbsolute(expanded)) {
        const base = defaultWorkspace || process.cwd();
        expanded = path.resolve(base, expanded);
    }

    return path.normalize(expanded);
}

function isLibraryMatch(filename: string, libraryName: string): boolean {
    const name = libraryName.trim();
    if (!name || !filename) {
        return false;
    }

    if (filename === name) {
        return true;
    }

    const baseName = name.replace(/\.(so|a|dylib|dll|lib)(\..*)?$/, "");
    const stem = baseName.startsWith("lib") ? baseName.slice(3) : baseName;

    const candidates = new Set([
        name,
        `lib${name}`,
        `${baseName}.so`,
        `${baseName}.a`,
        `${baseName}.dylib`,
        `${baseName}.dll`,
        `${baseName}.lib`,
        `lib${baseName}.so`,
        `lib${baseName}.a`,
        `lib${baseName}.dylib`,
        `lib${baseName}.dll`,
        `lib${baseName}.lib`,
        `${stem}.so`,
        `${stem}.a`,
        `lib${stem}.so`,
        `lib${stem}.a`,
        `lib${stem}.dylib`
    ]);

    if (candidates.has(filename)) {
        return true;
    }

    const prefixes = [
        `lib${stem}.so.`,
        `lib${stem}.a.`,
        `lib${stem}.dylib.`,
        `${stem}.so.`,
        `lib${baseName}.so.`,
        `${baseName}.so.`
    ];

    for (const prefix of prefixes) {
        if (filename.startsWith(prefix)) {
            return true;
        }
    }

    return false;
}

async function addTestSuite(
    target: BakeProject | TestGroup | undefined,
    provider: BakeProjectsProvider
): Promise<void> {
    const project = target instanceof TestGroup ? target.project : target instanceof BakeProject ? target : undefined;
    if (!project) {
        void vscode.window.showErrorMessage("No Bake project selected.");
        return;
    }

    const suiteId = await vscode.window.showInputBox({
        prompt: "Enter test suite ID",
        placeHolder: "e.g. Quaternion"
    });

    if (!suiteId || !suiteId.trim()) {
        return;
    }

    const cleanSuiteId = suiteId.trim();

    let targetJsonPath = path.join(project.location, "project.json");
    try {
        await fs.stat(targetJsonPath);
    } catch {
        targetJsonPath = path.join(project.metadataPath, "project.json");
        try {
            await fs.stat(targetJsonPath);
        } catch {
            void vscode.window.showErrorMessage(`Unable to locate project.json for project ${project.label?.toString() ?? ""}`);
            return;
        }
    }

    try {
        const content = await fs.readFile(targetJsonPath, "utf8");
        const json: Record<string, unknown> = JSON.parse(content);

        if (!isRecord(json.test)) {
            json.test = {};
        }

        const testObj = json.test as Record<string, unknown>;
        if (!Array.isArray(testObj.testsuites)) {
            testObj.testsuites = [];
        }

        const suitesArray = testObj.testsuites as unknown[];
        const existing = suitesArray.some(
            (s) => (isRecord(s) && firstText(s, ["id", "name", "title"]) === cleanSuiteId) || s === cleanSuiteId
        );

        if (existing) {
            void vscode.window.showWarningMessage(`Test suite "${cleanSuiteId}" already exists.`);
            return;
        }

        suitesArray.push({
            id: cleanSuiteId,
            setup: true,
            testcases: []
        });

        await fs.writeFile(targetJsonPath, JSON.stringify(json, null, 4) + "\n", "utf8");

        const srcDir = path.join(path.dirname(targetJsonPath), "src");
        await fs.mkdir(srcDir, { recursive: true });

        const ext = (json["lang.cpp"] || json["lang.c++"]) ? ".cpp" : ".c";
        const fileName = cleanSuiteId.endsWith(".c") || cleanSuiteId.endsWith(".cpp") || cleanSuiteId.endsWith(".cc")
            ? cleanSuiteId
            : `${cleanSuiteId}${ext}`;
        const srcFilePath = path.join(srcDir, fileName);

        try {
            await fs.stat(srcFilePath);
        } catch {
            const projectId = project.projectId ?? firstText(project.metadata, ["id", "name", "title", "projectName"]);
            const fileHeader = projectId ? `#include <${projectId}.h>\n\n` : "";
            await fs.writeFile(srcFilePath, fileHeader, "utf8");
        }

        provider.refresh();
        void vscode.window.showInformationMessage(`Test suite "${cleanSuiteId}" added to ${project.label?.toString() ?? "project"}.`);
    } catch (error: unknown) {
        void vscode.window.showErrorMessage(`Unable to update project.json: ${formatError(error)}`);
    }
}

export function deactivate(): void {}
