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
- Adds a collapsible **Tests** item to every project and discovers Bake projects under its `test` directory
- Shows installed libraries listed in language-specific `lib` fields, such as `lang.c.lib`, marking missing libraries as "not found"
- Displays root groups for **LD_LIBRARY_PATH** and **System Library Path** to inspect and open configured library directories
- Right-click library items or library path entries to open their location in the system file explorer
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

Each project also includes a collapsible **Tests** item. Expanding it recursively searches the project's `test` directory for nested Bake `project.json` files and lists each discovered test project.

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

Each project row exposes commands in the view and inline actions. The **Tests** item exposes the test action:

- Open Bake Project
- Bake: Run
- Bake: Build Recursive
- Bake: Rebuild
- Bake: Rebuild Recursive
- Bake: Uninstall
- Refresh Bake Projects
- Bake: Run Tests

Each command runs in a VS Code terminal using the project's filesystem location.

### Terminal commands used by the extension

- `bake run <location>`
- `bake test <location>`
- `bake build -r <location>`
- `bake rebuild <location>`
- `bake rebuild -r <location>`
- `bake uninstall <project-id>`

The rebuild and uninstall actions use shell-safe quoting for the project path or identifier.

## Extension Settings

This extension contributes the following settings:

- `bakeProjects.buildTool`: The Bake build tool to use when running project commands (`bake` or `bake3`). Default: `"bake"`.
- `bakeProjects.directory`: The directory under your home folder containing the `meta` folder (e.g., `"bake"` or `"bake3"`). Default: `"bake3"`.
- `bakeProjects.ldLibraryPath`: The `LD_LIBRARY_PATH` search paths used to locate library folders when using the right-click "Open Folder" menu on libraries. Default: `""`.
- `bakeProjects.systemLibraryPath`: System library search paths separated by colons used as fallback when locating libraries (e.g. `/usr/local/lib:/usr/lib:/lib:/usr/lib64:/lib64:/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu`). Default contains standard system paths.

### Configuration Example

Add the following to your VS Code `settings.json`:

```json
{
  "bakeProjects.buildTool": "bake3",
  "bakeProjects.directory": "bake3",
  "bakeProjects.ldLibraryPath": "${workspaceFolder}/bin/x64-Linux-debug:${env:HOME}/bake3/x64-Linux/debug/lib/:/usr/local/lib/",
  "bakeProjects.systemLibraryPath": "/usr/local/lib:/usr/lib:/lib:/usr/lib64:/lib64:/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu"
}
```

### Library Folder Lookup (`bakeProjects.ldLibraryPath` & `bakeProjects.systemLibraryPath`)

Right-clicking a library entry under a project's **Lib** group and selecting **Open Folder** attempts to locate the library file and open its location in your operating system's file explorer.

The lookup checks paths in the following fallback order:

1. `bakeProjects.ldLibraryPath` setting
2. `LD_LIBRARY_PATH` system environment variable
3. `LD_LIBRARY_PATH` defined in `.vscode/launch.json`
4. `bakeProjects.systemLibraryPath` setting (system library paths)

Supported path variables:
- `${workspaceFolder}` / `${workspaceRoot}`
- `${env:HOME}` / `${HOME}` / `$HOME` / `~`
- `${env:VAR}` / `$VAR` / `${VAR}`

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
