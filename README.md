# Bake Projects

A VS Code extension for browsing and working with Bake projects from your local Bake installation.

## Features

- Lists installed Bake projects from `${env:HOME}/bake/meta/*/project.json`
- Groups projects by their `type` or `kind` value from `project.json`
- Shows each project's identity, version, summary, language, and metadata fields
- Opens a project in a new VS Code window using its resolved project location
- Lets you run common Bake commands directly from each project row
- Tracks a workspace-specific current project selected from a local `project.json`
- Highlights the current project and the transitive dependency chain used by it
- Expands project dependencies from the `use` field and keeps walking recursively
- Shows installed libraries listed in language-specific `lib` fields, such as `lang.c.lib`
- Supports uninstalling a project from the extension UI
- Refreshes the project list when the Bake metadata directory changes

## What the extension shows

The Bake Projects view appears in the Activity Bar as a dedicated panel named "Bake Projects". It scans the Bake metadata directory and creates one row per discovered project.

Each project row displays:

- the project name, using `id`, `name`, `title`, or `projectName` from `project.json`
- the project description, if available
- an active or dependency status when relevant
- the project type, language, and metadata details when expanded

Project rows are grouped by type, and the active project is shown above the groups.

## Project location resolution

When you open a project, the extension resolves its actual location by:

1. checking `project.json` for a `location` field
2. falling back to `project.json`'s nested `value.location` if present
3. otherwise reading `source.txt` under the project metadata directory
4. finally falling back to the metadata directory itself

This makes project opening work reliably both for projects with explicit paths and for projects discovered via Bake metadata.

## Current project support

Right-click a local `project.json` file in the Explorer and choose "Bake: Set as Current Project".

The selected project is saved per workspace and treated as the active project even if it is not currently installed under `${env:HOME}/bake/meta`.

The active project is shown with a star icon and a status label of "Active". If the project is installed under Bake metadata, it stays in its type group and still appears at the top of the list.

## Dependency tracing

When a current project is available, the extension reads its `use` field and follows dependencies recursively.

- direct dependencies are shown when expanding a project
- libraries configured in `lang.*.lib` are shown in a separate Lib group when installed
- transitive dependencies are also discovered through nested `use` entries
- dependency rows are marked with "Used by Active" in green
- expanding a dependency continues walking its own dependencies
- refresh clears and recalculates those highlights from the current project

This makes it easy to understand which projects are part of the active project's dependency tree.

## Commands available in the project tree

Each project row exposes commands in the view and inline actions:

- Open Bake Project
- Bake: Run
- Bake: Build Recursive
- Bake: Rebuild
- Bake: Rebuild Recursive
- Bake: Uninstall
- Refresh Bake Projects

Each command runs in a VS Code terminal using the project's filesystem location.

### Terminal commands used by the extension

- `bake run <location>`
- `bake build -r <location>`
- `bake rebuild <location>`
- `bake rebuild -r <location>`
- `bake uninstall <project-id>`

The rebuild and uninstall actions use shell-safe quoting for the project path or identifier.

### Build tool setting

Use the `bakeProjects.buildTool` setting to select the command used by project actions:

- `bake` (default)
- `bake3`

For example, add the following to VS Code settings to use Bake3:

```json
"bakeProjects.buildTool": "bake3"
```

## How to use it

1. Install the extension.
2. Open the Bake Projects view in the Activity Bar.
3. Browse installed projects by type.
4. Expand a project to inspect metadata and dependency relationships.
5. Click the project buttons or menu actions to open, rebuild, run, or uninstall it.
6. Select a local `project.json` from the Explorer to mark a project as the active workspace project.

## Development

Install the project dependencies, then compile the extension:

```bash
npm install
npm run compile
```

To recompile automatically while editing, use:

```bash
npm run watch
```

To compile, create a new VSIX, install it in VS Code, and reload the window:

```bash
npm run package:install
```

This bumps the patch version before packaging. To create a VSIX without installing it, use:

```bash
npm run package
```
