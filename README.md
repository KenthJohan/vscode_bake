# Bake Projects

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

This bumps the patch version before packaging. To create a VSIX without
installing it, use `npm run package`.

The Bake Projects activity-bar icon lists projects found at
`${env:HOME}/bake/meta/*/project.json`. Each project row shows its Bake ID,
type, and language where present. Projects are grouped by their `type` from
`project.json`; expand a group, then a project, to see its metadata. Use the
open action to open its project location in a new VS Code window. The location
uses `project.json`'s `location` field when present, otherwise Bake's
`source.txt` metadata.

Use the refresh icon in the view title to rescan the directory.

Each project row has buttons that run these commands in a VS Code terminal:

- `bake rebuild <location>`
- `bake -r <location>`
- `bake rebuild -r <location>`

Right-click a `project.json` file in the Explorer and select **Bake: Set as
Current Project**. The selected project is marked **Active** in the Bake
Projects view for that workspace, even when it is not installed under the Bake
metadata directory. It appears above the type groups and remains in its type
group when it is installed there.

Expand a project to walk its dependencies. The extension reads the `use` field
from `project.json` when the project list is loaded or refreshed and when a
project is expanded. The all-projects view highlights the active project's
transitive dependencies recursively as green **Used by Active** rows. Refresh
recalculates the highlights, and expanding a dependency continues walking its
own dependencies.
