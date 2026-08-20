# project-list

Quick access and switching between projects.

## Features

- **Project list**: browse and open projects saved in a `projects.json` config file.
- **Directory scanning**: auto-discover subdirectories as projects with glob patterns.
- **Glob paths**: wildcard patterns in `paths` expand to all matching directories at load time.
- **Tags support**: organize and filter projects by tags; a `#tag` query targets tags explicitly.
- **Multiple open modes**: open in a new window, open here restoring the project's own editors, or add to the current window.
- **Recently used first**: keeps the projects you acted on at the top of the unfiltered list, ruled off from the rest.
- **Performance cache**: the built list is cached and kept in sync across windows.

## Installation

To install `project-list` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/project-list`.

## Commands

Commands available in `lumine-workspace`:

- `project-list:toggle`: toggle the project list,
- `project-list:update`: rebuild the project list,
- `project-list:edit`: open the configuration file,
- `project-list:clear-recent`: forget the recently used projects.

Commands available in `.project-list`, all listed with their keybindings in the item-actions list (F12):

- `project-list:open-in-new-window`: open the selected project in a new window,
- `project-list:open-in-this-window`: open the selected project here, restoring the editors it was last left with,
- `project-list:add-to-project`: add the selected project's folders to the current window,
- `project-list:insert-paths`: insert the project paths into the active text editor,
- `project-list:open-in-dev-mode`: open the selected project in a new window in dev mode,
- `project-list:open-in-safe-mode`: open the selected project in a new window in safe mode,
- `project-list:open-external`: open the project folders externally (via open-external),
- `project-list:show-in-folder`: show the project folders in the system file manager (via open-external),
- `project-list:refresh`: rebuild the project list, skipping the cache,
- `project-list:remove-from-recent`: drop the selected project from the recent section, offered only while a recent one is selected.

Opening in this window keeps the same renderer, so packages, themes and grammars stay loaded. The current project's editors are saved before the new project's are restored, unsaved changes included, so returning to a project finds it as you left it. Only the workspace center changes — a tree view, a terminal or any other dock keeps running. A project configured for `devMode` or `safeMode` still opens a window of its own, since neither can change in place.

## Configuration

Projects are defined in `projects.json` in the Lumine config directory — open it with `project-list:edit`. The file holds an array of project objects:

| Setting    | Type                        | Description                                                                                 | Default                 |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------- | ----------------------- |
| `title`    | `string`                    | Project title shown in the list. `[tag]` patterns are styled as tags.                       | _mandatory_             |
| `paths`    | `string[]`                  | Project directories. Glob wildcards (`*`, `**`, `?`, `[...]`, `{...}`) expand at load time. | _mandatory_             |
| `tags`     | `string[]`                  | Tags used to organize and find projects.                                                    | `[]`                    |
| `scan`     | `boolean\|string\|string[]` | Scan paths and add matching subdirectories as projects. `true` is equal to `"*/"`.          | `false`                 |
| `icon`     | `string`                    | Custom icon of the project, e.g. `"icon-star"`.                                             | `"icon-file-directory"` |
| `devMode`  | `boolean`                   | Open the project in dev mode.                                                               | `false`                 |
| `safeMode` | `boolean`                   | Open the project in safe mode.                                                              | `false`                 |

Example `projects.json`:

```jsonc
[
  {
    "title": "My Library",
    "paths": ["C:/Work/library/"],
    "tags": ["work"],
    "scan": true,
  },
  {
    "title": "Packages",
    "paths": ["C:/Work/packages/*"],
    "tags": ["work"],
  },
]
```

The search query is matched against a combined text string in the format `#tag1 #tag2 Title`, so a `#`-prefixed term ranks tag matches higher. Match scores favor shorter titles and projects with fewer tags.

## Customization

Tweak the appearance of the list by adding CSS to your `styles.css`:

```css
.project-list .tag {
  color: var(--text-color-info);
}

.project-list .list-group {
  max-height: 20em;
}
```

## Services

- [`project-list`](docs/project-list.md): provided to expose the project list manager — used by tree-view's empty project view to show a "List projects" button, and by window-title to resolve the current project title via `getCurrentProject()` / `onDidChangeCurrentProject()`.
- `open-external`: consumed to open project folders externally or show them in the system file manager. For multi-path projects, the action is applied to each path.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
