const { CompositeDisposable, Disposable, Emitter, watchFile, Task } = require("lumine");
const { glob, isDynamicPattern } = require("tinyglobby");
const fs = require("fs");
const path = require("path");
const CSON = require("@lumine-code/season");

const CACHE_UPDATED_CHANNEL = "project-list:cache-updated";

// Windows reads both `\` and `/` as separators; POSIX reads a backslash as an
// ordinary character in a filename, so only `/` may be rewritten there.
const WINDOWS_SEPARATORS = path.sep === "\\";
const TRAILING_SEPARATOR = WINDOWS_SEPARATORS ? /[\\/]+$/ : /\/+$/;
const ANY_SEPARATOR = WINDOWS_SEPARATORS ? /[\\/]/g : /\//g;

// Settles a path on the platform separator, with no trailing one.
const normalizeSeparators = (aPath) =>
  aPath.replace(TRAILING_SEPARATOR, "").split(ANY_SEPARATOR).join(path.sep);

class ProjectList {
  constructor(state) {
    // initialize
    this.items = [];
    this.restart = true;
    this.restarting = false;
    this.currentProject = null;
    this.cacheFingerprint = null;
    this.emitter = new Emitter();

    // recently used projects, most recent first
    this.recentlyUsed = [
      ...new Set(
        (Array.isArray(state?.recentlyUsed) ? state.recentlyUsed : []).filter(
          (key) => typeof key === "string",
        ),
      ),
    ];
    this.recentCount = lumine.config.get("project-list.recentCount");

    // config file
    this.configPath = this.getConfigPath();

    // create select-list
    this.selectList = lumine.workspace.buildSelectList({
      className: "project-list",
      crumb: "Projects",
      emptyMessage: "No matches found",
      items: [],
      // A project is rebuilt from the config or the cache on every scan, so no
      // object survives; its title and paths are what identify it.
      getItemId: (item) => this.projectKey(item),
      search: {
        getFilterText: (item) => item.text,
        algorithm: "fuzzaldrin",
        ignoreDiacritics: true,
        scoreModifier: (score, item) => {
          // Bonus for shorter titles (common/important projects)
          const titleBonus = 1 / Math.sqrt(item.title.length);
          // Bonus for fewer tags (general projects)
          const tagBonus = 1 / Math.sqrt((item.tags?.length || 0) + 1);
          return score * titleBonus * tagBonus;
        },
      },
      renderItem: (item, options) => this.renderItem(item, options),
      recents: {
        limit: this.recentCount,
        adapter: {
          load: () => this.recentlyUsed,
          save: (recentItemIds) => {
            this.recentlyUsed = recentItemIds.slice();
          },
        },
      },
      source: {
        mode: "snapshot",
        loadingMessage: "Indexing projects…",
        load: ({ signal, publish }) =>
          this.loadProjects({ loadCache: this.nextLoadUsesCache !== false, signal, publish }),
      },
      commands: {
        "project-list:open-in-new-window": {
          description: "Open the project in a new window.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "open-in-new-window"),
        },
        "project-list:open-in-this-window": {
          description: "Open the project here, restoring the editors it was last left with.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "open-in-this-window"),
        },
        "project-list:add-to-project": {
          description: "Add the project paths to the folders of the current window.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "add-to-project"),
        },
        "project-list:insert-paths": {
          description: "Insert the project paths into the active editor.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "insert-paths"),
        },
        "project-list:open-in-dev-mode": {
          description: "Open the project in a new window in dev mode.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "open-in-dev-mode"),
        },
        "project-list:open-in-safe-mode": {
          description: "Open the project in a new window in safe mode.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "open-in-safe-mode"),
        },
        "project-list:refresh": {
          description: "Rebuild the list from the config file, skipping the cache.",
          didDispatch: () => this.updateView(false),
        },
        "project-list:open-external": {
          description: "Open each project folder in the default external program.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "open-external"),
        },
        "project-list:show-in-folder": {
          description: "Show each project folder in the system file manager.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "show-in-folder"),
        },
      },
      actions: this.projectActions(),
    });
    this.recentlyUsed = this.selectList.getRecentItemIds();

    // create disposables
    this.disposables = new CompositeDisposable();

    // watch required config
    this.disposables.add(
      lumine.config.observe("project-list.useCache", (value) => {
        this.useCache = value;
      }),
      lumine.config.observe("project-list.checkExists", (value) => {
        this.checkExists = value;
      }),
      lumine.config.observe("project-list.parseTitleTags", (value) => {
        this.parseTitleTagsEnabled = value;
        this.restart = true;
      }),
      lumine.config.onDidChange("project-list.recentCount", ({ newValue }) => {
        this.recentCount = newValue;
        this.selectList.setRecentLimit(newValue);
      }),
    );

    // track the project matching the current window
    this.disposables.add(
      lumine.project.onDidChangePaths(() => {
        this.findCurrentProject();
      }),
    );

    // sync cache updates from other windows
    this.disposables.add(
      lumine.window.onDidReceive(CACHE_UPDATED_CHANNEL, (cacheFingerprint) => {
        this.handleCacheUpdate(cacheFingerprint);
      }),
    );

    // add global & local shortcuts
    this.disposables.add(
      lumine.commands.add("lumine-workspace", {
        "project-list:toggle": () => this.selectList.toggle(),
        "project-list:update": {
          description: "Read the configured project folders again from disk.",
          didDispatch: () => this.updateView(false),
        },
        "project-list:edit": {
          description: "Open the configuration that decides which projects are listed.",
          didDispatch: () => this.editConfig(),
        },
        "project-list:clear-recent": {
          description: "Forget the recently used projects kept at the top of the list.",
          didDispatch: () => this.clearRecent(),
        },
      }),
    );

    // watch config file
    this.observeConfigFile();
  }

  setOpenExternalService(service) {
    this.openExternalService = service;
  }

  projectActions() {
    const recordOnSuccess = ({ item }) =>
      Boolean(this.successfulRecentActions?.delete(this.projectKey(item)));
    const itemAction = (command, group, options = {}) => ({
      command,
      context: "item",
      group,
      disposition: "close",
      dispatch: "local",
      recordsRecent: recordOnSuccess,
      ...options,
    });
    return [
      itemAction("project-list:open-in-new-window", "Open", { primary: true }),
      itemAction("project-list:open-in-this-window", "Open"),
      itemAction("project-list:open-in-dev-mode", "Open"),
      itemAction("project-list:open-in-safe-mode", "Open"),
      itemAction("project-list:open-external", "Open", {
        enabled: () => Boolean(this.openExternalService),
        disabledReason: "The open-external package is not available.",
      }),
      itemAction("project-list:show-in-folder", "Open", {
        enabled: () => Boolean(this.openExternalService),
        disabledReason: "The open-external package is not available.",
      }),
      itemAction("project-list:add-to-project", "Use"),
      itemAction("project-list:insert-paths", "Use", {
        enabled: () => Boolean(lumine.workspace.getActiveTextEditor()),
        disabledReason: "There is no active text editor.",
      }),
      {
        command: "project-list:refresh",
        context: "dialog",
        group: "List",
        disposition: "stay",
        dispatch: "local",
      },
      {
        command: "project-list:edit",
        context: "dialog",
        group: "List",
        disposition: "close",
        dispatch: "workspace",
      },
    ];
  }

  serialize() {
    return { recentlyUsed: this.selectList.getRecentItemIds() };
  }

  destroy() {
    this.disposables.dispose();
    this.emitter.dispose();
    this.selectList.destroy();
  }

  // A project's identity across scans: its title and the paths it opens.
  projectKey(item) {
    return item ? [item.title, ...item.paths].join("\n") : null;
  }

  clearRecent() {
    return this.selectList.clearRecentItems();
  }

  getConfigPath() {
    return (
      CSON.resolve(path.join(lumine.getConfigDirPath(), "projects")) ||
      path.join(lumine.getConfigDirPath(), "projects.json")
    );
  }

  getCachePath() {
    return path.join(this.getCacheDirectoryPath(), "projects.json");
  }

  getCacheDirectoryPath() {
    return path.join(lumine.getConfigDirPath(), "compile-cache");
  }

  ensureCacheDirectory() {
    const cacheDir = this.getCacheDirectoryPath();
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    return cacheDir;
  }

  getCacheFingerprint() {
    try {
      const stat = fs.statSync(this.getCachePath());
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  async updateView(loadCache = true) {
    this.restart = true;
    this.nextLoadUsesCache = loadCache;
    if (this.selectList.isVisible()) return this.selectList.reload();

    const publication = await this.loadProjects({ loadCache, signal: null, publish: null });
    return this.selectList.update(publication);
  }

  async loadProjects({ loadCache = true, signal, publish }) {
    if (!this.restart && loadCache) return { items: this.items ?? [], status: this.loadStatus };
    if (this.activeLoad) {
      await this.activeLoad;
      this.throwIfAborted(signal);
      return { items: this.items ?? [], status: this.loadStatus };
    }

    this.activeLoad = this.performLoadProjects({ loadCache, signal, publish });
    try {
      return await this.activeLoad;
    } finally {
      this.activeLoad = null;
      this.loadingPublisher = null;
      this.restarting = false;
      this.nextLoadUsesCache = true;
    }
  }

  async performLoadProjects({ loadCache, signal, publish }) {
    this.restart = false;
    this.restarting = true;
    this.loadingPublisher = publish;
    this.throwIfAborted(signal);

    // initialize
    this.items = null;
    const errors = [];

    // try load cache if needed
    if (loadCache && this.useCache && !this.items) {
      try {
        this.loadCache();
      } catch (err) {
        errors.push(`loadCache: ${err}`);
      }
    }

    // try build cache if needed
    if (!this.items) {
      try {
        await this.buildCache({ signal, publish });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        errors.push(`buildCache: ${err}`);
      }
    }

    // if nothing works then...
    if (!this.items) {
      this.items = [];
    }

    // track current project
    this.findCurrentProject();
    this.loadStatus = errors.length
      ? { type: "error", message: errors.join("\n"), sticky: true }
      : null;
    return {
      items: this.items,
      // A cache failure is not an answer to the query, so it survives typing
      // rather than vanishing on the first keystroke.
      status: this.loadStatus,
    };
  }

  async updateViewSchedule() {
    this.restart = true;
    if (this.selectList.isVisible()) {
      await this.updateView();
    }
  }

  updateLoading() {
    if (this.loadingPublisher) {
      return this.loadingPublisher({ items: this.items.slice(), loadingBadge: this.items.length });
    }
    if (this.selectList.isVisible()) {
      return this.selectList.update({ items: this.items, loadingBadge: this.items.length });
    }
  }

  throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error("Project indexing was cancelled.");
    error.name = "AbortError";
    throw error;
  }

  async ensureConfigFile() {
    if (!fs.existsSync(this.configPath)) {
      await fs.promises.mkdir(path.dirname(this.configPath), { recursive: true });
      await fs.promises.writeFile(this.configPath, "[]");
    }
  }

  async observeConfigFile() {
    await this.ensureConfigFile();
    const watcher = watchFile(this.configPath);
    this.disposables.add(
      watcher,
      watcher.onDidChange(
        debounce(async () => {
          this.clearCache();
          await this.updateViewSchedule();
        }, 100),
      ),
    );
  }

  handleCacheUpdate(cacheFingerprint) {
    if (this.restarting) {
      return;
    }
    if (!this.useCache) {
      return;
    }
    if (cacheFingerprint === this.cacheFingerprint) {
      return;
    }
    try {
      if (this.loadCache()) {
        this.findCurrentProject();
        this.selectList.setItems(this.items);
      }
    } catch {
      // a stale or malformed cache is rebuilt on the next update
    }
  }

  renderItem(item, { matchIndices, highlight }) {
    // Text format: "Title #tag1 #tag2"
    let li = document.createElement("li");
    li.classList.add("two-lines");
    let e1 = document.createElement("div");
    e1.classList.add("primary-line");
    const indices = matchIndices || [];

    // Render tags first (visual order) - offset: 0 (tags are first in text)
    let tagOffset = 0;
    if (item.tags) {
      for (let tag of item.tags) {
        let et = document.createElement("span");
        et.classList.add("tag");
        tagOffset += 1; // for #
        et.appendChild(
          highlight(
            tag,
            indices.map((x) => x - tagOffset),
          ),
        );
        tagOffset += tag.length + 1; // tag + space
        e1.appendChild(et);
      }
    }

    // Parse and render [tag] patterns from title (if enabled) - offset: after tags
    if (this.parseTitleTagsEnabled) {
      let titleOffset = tagOffset;
      const titleParts = this.parseTitleTags(item.title);
      for (let part of titleParts) {
        if (part.isTag) {
          let et = document.createElement("span");
          et.classList.add("square");
          let text = "[" + part.text + "]";
          et.appendChild(
            highlight(
              text,
              indices.map((x) => x - titleOffset),
            ),
          );
          titleOffset += text.length;
          e1.appendChild(et);
        } else {
          e1.appendChild(
            highlight(
              part.text,
              indices.map((x) => x - titleOffset),
            ),
          );
          titleOffset += part.text.length;
        }
      }
    } else {
      // Render title as-is - offset: after tags
      e1.appendChild(
        highlight(
          item.title,
          indices.map((x) => x - tagOffset),
        ),
      );
    }

    li.appendChild(e1);
    for (let dirPath of item.paths) {
      let ep = document.createElement("div");
      ep.classList.add("secondary-line");
      const icon = item.devMode
        ? "beaker"
        : item.safeMode
          ? "shield"
          : item.icon
            ? item.icon
            : null;
      const iconTarget = icon
        ? {
            name: icon.startsWith("icon-") ? icon.slice("icon-".length) : icon,
            context: "project-list",
          }
        : {
            path: dirPath,
            context: "project-list",
            hints: { directory: true },
          };
      lumine.icons.applyTo(ep, iconTarget, { classes: ["icon-line"], setData: false });
      let ei = document.createElement("span");
      ei.textContent = dirPath;
      ep.appendChild(ei);
      li.appendChild(ep);
    }
    return li;
  }

  performAction(item, mode = "open-in-new-window") {
    if (!item) return false;
    const data = this.prepareData(item);
    if (!data.pathsToOpen.length) {
      return false;
    }
    if (mode === "open-in-new-window") {
      lumine.application.openWindow({ ...data, newWindow: true });
    } else if (mode === "open-in-dev-mode") {
      lumine.application.openWindow({ ...data, newWindow: true, devMode: true });
    } else if (mode === "open-in-safe-mode") {
      lumine.application.openWindow({ ...data, newWindow: true, safeMode: true });
    } else if (mode === "open-in-this-window") {
      // Development and safe mode belong to the window, so a project that asks
      // for either still needs one of its own.
      if (item.devMode || item.safeMode) {
        const closing = lumine.project.getPaths().length > 0;
        lumine.application.openWindow({ ...data, newWindow: true });
        if (closing) {
          lumine.window.close();
        }
        (this.successfulRecentActions ??= new Set()).add(this.projectKey(item));
        return true;
      }
      lumine.project.setState(data.pathsToOpen);
    } else if (mode === "add-to-project") {
      lumine.project.addPaths(data.pathsToOpen, { mustExist: true });
    } else if (mode === "open-external") {
      if (!this.openExternalService) {
        lumine.notifications.addWarning("The `open-external` package is not available");
        return false;
      }
      for (let projectPath of data.pathsToOpen) {
        this.openExternalService.openExternal(projectPath);
      }
    } else if (mode === "show-in-folder") {
      if (!this.openExternalService) {
        lumine.notifications.addWarning("The `open-external` package is not available");
        return false;
      }
      for (let projectPath of data.pathsToOpen) {
        this.openExternalService.showInFolder(projectPath);
      }
    } else if (mode === "insert-paths") {
      const editor = lumine.workspace.getActiveTextEditor();
      // No editor behind the picker is already on screen, and nothing failed.
      if (!editor) return false;
      editor.insertText(data.pathsToOpen.join("\n"), { selection: true });
    }
    (this.successfulRecentActions ??= new Set()).add(this.projectKey(item));
    return true;
  }

  async saveCache() {
    const cachePath = this.getCachePath();
    const cacheDir = this.ensureCacheDirectory();
    const tempPath = path.join(
      cacheDir,
      `projects-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json.tmp`,
    );
    fs.writeFileSync(tempPath, JSON.stringify(this.items));
    fs.renameSync(tempPath, cachePath);
    this.cacheFingerprint = this.getCacheFingerprint();
    await lumine.window.broadcast(CACHE_UPDATED_CHANNEL, this.cacheFingerprint);
  }

  loadCache() {
    const cachePath = this.getCachePath();
    if (!fs.existsSync(cachePath)) {
      return false;
    }
    const items = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!Array.isArray(items)) {
      return false;
    }
    this.items = items;
    this.cacheFingerprint = this.getCacheFingerprint();
    return true;
  }

  clearCache() {
    try {
      fs.rmSync(this.getCachePath(), { force: true });
    } catch {
      // cache file may be gone already
    }
    this.cacheFingerprint = null;
  }

  async buildCache({ signal } = {}) {
    this.throwIfAborted(signal);
    await this.ensureConfigFile();
    const configData = CSON.readFileSync(this.configPath);
    if (configData instanceof Error) {
      throw new Error(configData.message);
    }
    this.items = [];
    for (const item of configData) {
      this.throwIfAborted(signal);
      try {
        item.paths = await this.expandGlobPaths(item.paths);
        if (this.checkExists) {
          let paths = [];
          for (let ppath of item.paths) {
            try {
              await fs.promises.access(ppath);
              paths.push(ppath);
            } catch {
              // skip paths that do not exist
            }
          }
          if (paths.length === 0) {
            continue;
          }
          item.paths = paths;
        }
        this.items.push(this.prepareItem(item));
      } catch {
        // skip malformed config entries
      }
    }
    this.updateLoading();
    const tasks = [];
    for (let item of this.items) {
      if (item.scan) {
        for (let dirPath of item.paths) {
          if (dirPath in tasks) {
            continue;
          }
          tasks[dirPath] = this.scanDir(dirPath, item.tags, item.scan);
        }
      }
    }
    await Promise.all(Object.values(tasks));
    this.throwIfAborted(signal);
    if (this.useCache) {
      await this.saveCache();
    }
  }

  scanDir(dirPath, tags, scanList) {
    return new Promise((resolve) => {
      if (scanList == true) {
        scanList = "*/";
      }
      const workerPath = path.join(__dirname, "scan.js");
      const task = Task.once(workerPath, dirPath, scanList);
      task.on("project-list:entries", (entries) => {
        for (let entry of entries) {
          const item = {
            title: entry,
            tags: tags,
            paths: [path.join(dirPath, entry)],
          };
          this.items.push(this.prepareItem(item));
        }
        this.updateLoading();
        resolve();
      });
    });
  }

  findCurrentProject() {
    let current = null;
    if (this.items) {
      const proPaths = lumine.project.getPaths().map((proPath) => proPath + path.sep);
      for (let item of this.items) {
        if (item.paths.length !== proPaths.length) {
          continue;
        }
        if (proPaths.every((proPath) => item.paths.includes(proPath))) {
          current = item;
          break;
        }
      }
    }
    const changed = this.projectKey(current) !== this.projectKey(this.currentProject);
    this.currentProject = current;
    if (changed) {
      this.emitter.emit("did-change-current-project", current);
    }
    return current;
  }

  getCurrentProject() {
    return this.currentProject;
  }

  onDidChangeCurrentProject(callback) {
    return this.emitter.on("did-change-current-project", callback);
  }

  parseTitleTags(title) {
    const parts = [];
    let lastIndex = 0;
    const regex = /\[([^\]]+)\]/g;
    let match;

    while ((match = regex.exec(title)) !== null) {
      // Add text before the tag
      if (match.index > lastIndex) {
        parts.push({
          text: title.substring(lastIndex, match.index),
          isTag: false,
        });
      }

      // Add the tag content
      parts.push({
        text: match[1],
        isTag: true,
      });

      lastIndex = regex.lastIndex;
    }

    // Add remaining text after the last tag
    if (lastIndex < title.length) {
      parts.push({
        text: title.substring(lastIndex),
        isTag: false,
      });
    }

    return parts;
  }

  async expandGlobPaths(paths) {
    const expanded = await Promise.all(
      paths.map((p) => {
        // Globs speak `/`. On Windows the config may use `\`, which glob syntax
        // reads as an escape character, so normalize the separators there
        // first — but never on POSIX, where a backslash is an ordinary
        // character in a filename.
        //
        // Not `convertPathToPattern()`: that one *escapes* glob symbols so a
        // literal path matches itself, which is the opposite of what a user's
        // `projects.cson` pattern means.
        const pattern = WINDOWS_SEPARATORS ? p.split(ANY_SEPARATOR).join("/") : p;
        return isDynamicPattern(pattern)
          ? glob(pattern, {
              absolute: true,
              onlyDirectories: true,
              expandDirectories: false,
            })
          : Promise.resolve([p]);
      }),
    );
    // Literals arrive however the user wrote them and matches arrive
    // `/`-separated with a trailing slash, so settle on one form before
    // sorting. `prepareItem` re-adds the trailing separator later.
    return expanded.flat().map(normalizeSeparators).sort();
  }

  editConfig() {
    this.selectList.hide();
    lumine.workspace.open(this.getConfigPath());
  }

  prepareItem(item) {
    // Format: "#tag1 #tag2 Title" - tags first for better fuzzy matching
    item.text = (item.tags ? item.tags.map((x) => `#${x}`).join(" ") + " " : "") + item.title;
    item.paths = item.paths.map((ppath) => normalizeSeparators(ppath) + path.sep);
    return item;
  }

  prepareData(item) {
    const pathsToOpen = [];
    const errs = [];
    for (let projectPath of item.paths) {
      if (fs.existsSync(projectPath) && fs.lstatSync(projectPath).isDirectory()) {
        pathsToOpen.push(projectPath.replace(/[\\/]+$/, ""));
      } else {
        errs.push(projectPath);
      }
    }
    if (errs.length) {
      lumine.notifications.addError("Directory does not exist", {
        detail: errs.join("\n"),
      });
    }
    let params = { pathsToOpen: pathsToOpen, errs: errs };
    if (item.devMode) {
      params.devMode = true;
    }
    if (item.safeMode) {
      params.safeMode = true;
    }
    return params;
  }
}

function debounce(func, timeout) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func.apply(this, args);
    }, timeout);
  };
}

module.exports = {
  activate(state) {
    this.projectList = new ProjectList(state);
  },

  serialize() {
    return this.projectList.serialize();
  },

  deactivate() {
    this.projectList.destroy();
  },

  provideProjectList() {
    return this.projectList;
  },

  consumeOpenExternal(service) {
    this.projectList.setOpenExternalService(service);
    return new Disposable(() => {
      this.projectList.setOpenExternalService(null);
    });
  },
};
