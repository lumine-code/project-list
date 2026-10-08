const { CompositeDisposable, Disposable, Emitter, watchFile, Task } = require("lumine");
const fs = require("fs");
const path = require("path");

const CACHE_UPDATED_CHANNEL = "project-list:cache-updated";
// Older caches discarded unavailable roots and cannot describe a complete
// project safely. Rebuild them from the configuration rather than adopting one.
const CACHE_VERSION = 1;

// Windows reads both `\` and `/` as separators; POSIX reads a backslash as an
// ordinary character in a filename, so only `/` may be rewritten there.
const WINDOWS_SEPARATORS = path.sep === "\\";
const TRAILING_SEPARATOR = WINDOWS_SEPARATORS ? /[\\/]+$/ : /\/+$/;
const ANY_SEPARATOR = WINDOWS_SEPARATORS ? /[\\/]/g : /\//g;

// Settles a path on the platform separator, retaining filesystem root separators.
const normalizeSeparators = (aPath) => {
  let normalized = path.normalize(aPath.split(ANY_SEPARATOR).join(path.sep));
  if (WINDOWS_SEPARATORS)
    normalized = normalized.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const root = path.parse(normalized).root;
  const trimmed = normalized.replace(TRAILING_SEPARATOR, "");
  return trimmed.length < root.length ? root : trimmed;
};

const withTrailingSeparator = (aPath) => {
  const normalized = normalizeSeparators(aPath);
  return normalized.endsWith(path.sep) ? normalized : normalized + path.sep;
};

class ProjectList {
  constructor() {
    // initialize
    this.items = [];
    this.restart = true;
    this.restarting = false;
    this.currentProject = null;
    this.cacheFingerprint = null;
    this.loadRevision = 0;
    this.activeOperation = null;
    this.activeLoad = null;
    this.emitter = new Emitter();

    this.configPath = null;
    this.selectListHost = null;
    this.selectList = null;

    // create disposables
    this.disposables = new CompositeDisposable();

    // watch required config
    this.disposables.add(
      lumine.config.observe("project-list.useCache", (value) => {
        this.setConfigOption("useCache", value);
      }),
      lumine.config.observe("project-list.checkExists", (value) => {
        this.setConfigOption("checkExists", value);
      }),
      lumine.config.observe("project-list.parseTitleTags", (value) => {
        this.setConfigOption("parseTitleTagsEnabled", value);
      }),
    );

    // track the project matching the current window
    this.disposables.add(
      lumine.project.onDidChangePaths(() => {
        const operation = this.activeOperation;
        if (operation) {
          this.invalidateLoad("project-changed");
          this.selectList?.cancelSource("project-changed");
          this.restart = true;
        }
        this.findCurrentProject();
        if (operation) void this.updateView(operation.loadCache);
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
        "project-list:toggle": () => this.ensureSelectList().toggle(),
        "project-list:edit": {
          description: "Open the configuration that decides which projects are listed.",
          didDispatch: () => this.editConfig(),
        },
      }),
    );

    // Resolving and watching the user config both touch the filesystem. They
    // are startup maintenance, not part of registering the package's public
    // commands or service, so leave them until the activation batch yields.
    queueMicrotask(() => {
      if (!this.disposables.disposed) void this.observeConfigFile();
    });
  }

  ensureSelectList() {
    if (this.selectListHost) return this.selectListHost;

    const selectListOptions = {
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
        "project-list:copy-paths": {
          description: "Copy the project paths to the clipboard.",
          didDispatch: ({ detail }) => this.performAction(detail.item, "copy-paths"),
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
    };
    this.selectListHost = lumine.workspace.addSelectList(selectListOptions, {
      className: "project-list",
      crumb: "Projects",
    });
    this.selectList = this.selectListHost.getModel();
    return this.selectListHost;
  }

  setOpenExternalService(service) {
    this.openExternalService = service;
  }

  projectActions() {
    const itemAction = (command, group, options = {}) => ({
      command,
      context: "item",
      group,
      disposition: "close",
      dispatch: "local",
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
      itemAction("project-list:copy-paths", "Use"),
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

  destroy() {
    this.invalidateLoad("disposed");
    this.disposables.dispose();
    this.emitter.dispose();
    this.selectListHost?.destroy();
    this.selectListHost = null;
    this.selectList = null;
  }

  // A project's identity across scans: its title and the paths it opens.
  projectKey(item) {
    return item ? [item.title, ...item.paths].join("\n") : null;
  }

  getConfigPath() {
    const CSON = require("@lumine-code/season");
    return (this.configPath ??=
      CSON.resolve(path.join(lumine.getConfigDirPath(), "projects")) ||
      path.join(lumine.getConfigDirPath(), "projects.json"));
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
    if (this.disposables.disposed) return;
    this.restart = true;
    this.nextLoadUsesCache = loadCache;
    if (this.selectListHost?.isVisible()) return this.selectList.reload();

    const publication = await this.loadProjects({ loadCache, signal: null, publish: null });
    if (!publication || this.disposables.disposed) return;
    return this.selectList ? this.selectList.update(publication) : publication;
  }

  setConfigOption(name, value) {
    const previous = this[name];
    this[name] = value;
    if (previous === undefined || previous === value) return;
    const reload =
      this.activeOperation != null || !this.restart || this.selectListHost?.isVisible();
    this.clearCache();
    this.restart = true;
    this.selectList?.cancelSource("configuration-changed");
    if (reload) void this.updateView(false);
  }

  invalidateLoad(reason) {
    this.loadRevision++;
    const operation = this.activeOperation;
    this.activeOperation = null;
    this.activeLoad = null;
    this.loadingPublisher = null;
    this.restarting = false;
    if (operation && !operation.controller.signal.aborted) operation.controller.abort(reason);
  }

  isCurrentLoad(operation) {
    return (
      operation != null &&
      !this.disposables.disposed &&
      this.activeOperation === operation &&
      operation.revision === this.loadRevision &&
      !operation.controller.signal.aborted &&
      this.getConfigPath() === operation.configPath &&
      (operation.configFingerprint === undefined ||
        this.getConfigFingerprint(operation.configPath) === operation.configFingerprint)
    );
  }

  assertCurrentLoad(operation) {
    if (this.isCurrentLoad(operation)) return;
    const error = new Error("Project indexing was cancelled.");
    error.name = "AbortError";
    throw error;
  }

  getConfigFingerprint(configPath = this.getConfigPath()) {
    try {
      const stat = fs.statSync(configPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  async loadProjects({ loadCache = true, signal, publish } = {}) {
    if (this.disposables.disposed || signal?.aborted) return;
    if (!this.activeOperation && !this.restart && loadCache) {
      return { items: this.items ?? [], status: this.loadStatus };
    }
    this.invalidateLoad("superseded");
    const operation = {
      revision: this.loadRevision,
      controller: new AbortController(),
      loadCache,
      publish,
      useCache: this.useCache,
      checkExists: this.checkExists,
      configPath: this.getConfigPath(),
      cachePath: this.getCachePath(),
      cacheDirectoryPath: this.getCacheDirectoryPath(),
      items: null,
      tasks: new Set(),
    };
    this.activeOperation = operation;
    this.restarting = true;
    const abort = () => operation.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const pending = this.performLoadProjects(operation);
    this.activeLoad = pending;
    try {
      return await pending;
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      // A failed scan must retire its siblings as well; Promise.all rejects
      // before the other workers have finished sending directory results.
      if (operation.tasks.size && !operation.controller.signal.aborted) {
        operation.controller.abort("load-settled");
      }
      if (this.activeOperation === operation) {
        this.activeOperation = null;
        this.activeLoad = null;
        this.restarting = false;
        this.nextLoadUsesCache = true;
      }
    }
  }

  async performLoadProjects(operation) {
    this.assertCurrentLoad(operation);
    const errors = [];

    if (operation.loadCache && operation.useCache) {
      try {
        this.loadCache(operation);
      } catch (err) {
        errors.push(`loadCache: ${err}`);
      }
    }

    if (!operation.items) {
      try {
        await this.buildCache(operation);
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        errors.push(`buildCache: ${err}`);
      }
    }

    this.assertCurrentLoad(operation);
    this.items = operation.items ?? [];
    if (operation.cacheFingerprint !== undefined)
      this.cacheFingerprint = operation.cacheFingerprint;
    this.restart = false;
    this.loadStatus = errors.length
      ? { type: "error", message: errors.join("\n"), sticky: true }
      : null;
    this.findCurrentProject();
    this.assertCurrentLoad(operation);
    return {
      items: this.items,
      // A cache failure is not an answer to the query, so it survives typing
      // rather than vanishing on the first keystroke.
      status: this.loadStatus,
    };
  }

  async updateViewSchedule() {
    this.invalidateLoad("configuration-changed");
    this.restart = true;
    if (this.selectListHost?.isVisible()) {
      await this.updateView();
    }
  }

  updateLoading(operation) {
    if (!this.isCurrentLoad(operation)) return;
    const publication = { items: operation.items.slice(), loadingBadge: operation.items.length };
    if (operation.publish) {
      return operation.publish(publication);
    }
    if (this.selectListHost?.isVisible()) {
      return this.selectList.update(publication);
    }
  }

  throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error("Project indexing was cancelled.");
    error.name = "AbortError";
    throw error;
  }

  async ensureConfigFile() {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
      if (this.disposables.disposed) return;
      try {
        await fs.promises.writeFile(configPath, "[]", { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
  }

  async observeConfigFile() {
    await this.ensureConfigFile();
    if (this.disposables.disposed) return;
    const watcher = watchFile(this.getConfigPath());
    const reload = debounce(async () => {
      if (this.disposables.disposed) return;
      const needed = this.configReloadNeeded || this.activeOperation != null || !this.restart;
      this.configReloadNeeded = false;
      this.clearCache();
      this.restart = true;
      if (needed || this.selectListHost?.isVisible()) await this.updateView(false);
    }, 100);
    const changed = () => {
      this.configReloadNeeded ||= this.activeOperation != null || !this.restart;
      this.invalidateLoad("configuration-changed");
      this.selectList?.cancelSource("configuration-changed");
      this.restart = true;
      reload();
    };
    this.disposables.add(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidInvalidate(changed),
      new Disposable(() => reload.cancel()),
      watcher.onDidError((error) => console.error("Unable to watch project configuration", error)),
    );
    watcher.ready.then(reload, () => {});
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
        this.selectList?.setItems(this.items);
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
      // Switching only part of a multi-folder project would restore a different
      // session. Leave this window alone until all requested folders exist.
      if (data.errs.length) return false;
      // A mode already active in this window needs no replacement. Opening a
      // window is a request, not an acknowledgement that it loaded successfully,
      // so keep the outgoing window and its work available.
      if (
        (item.devMode && !lumine.window.isDevMode()) ||
        (item.safeMode && !lumine.window.isSafeMode())
      ) {
        lumine.application.openWindow({ ...data, newWindow: true });
        return true;
      }
      return lumine.project.setState(data.pathsToOpen);
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
    } else if (mode === "copy-paths") {
      lumine.clipboard.write(data.pathsToOpen.join("\n"));
    }
    return true;
  }

  async saveCache(operation = null) {
    if (this.disposables.disposed) return;
    if (operation) this.assertCurrentLoad(operation);
    const cachePath = operation?.cachePath ?? this.getCachePath();
    const cacheDir = operation?.cacheDirectoryPath ?? this.getCacheDirectoryPath();
    fs.mkdirSync(cacheDir, { recursive: true });
    const tempPath = path.join(
      cacheDir,
      `projects-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json.tmp`,
    );
    try {
      fs.writeFileSync(
        tempPath,
        JSON.stringify({ version: CACHE_VERSION, items: operation?.items ?? this.items }),
      );
      if (operation) this.assertCurrentLoad(operation);
      fs.renameSync(tempPath, cachePath);
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
    const fingerprint = this.getCacheFingerprint();
    if (operation) operation.cacheFingerprint = fingerprint;
    else this.cacheFingerprint = fingerprint;
    await lumine.window.broadcast(CACHE_UPDATED_CHANNEL, fingerprint);
    if (operation) this.assertCurrentLoad(operation);
  }

  loadCache(operation = null) {
    if (this.disposables.disposed) return false;
    if (operation) this.assertCurrentLoad(operation);
    const cachePath = operation?.cachePath ?? this.getCachePath();
    if (!fs.existsSync(cachePath)) {
      return false;
    }
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (cache?.version !== CACHE_VERSION || !Array.isArray(cache.items)) {
      return false;
    }
    const items = cache.items.map((item) => this.prepareItem(item));
    if (operation) {
      operation.items = items;
      operation.cacheFingerprint = this.getCacheFingerprint();
    } else {
      this.items = items;
      this.cacheFingerprint = this.getCacheFingerprint();
    }
    return true;
  }

  clearCache() {
    this.invalidateLoad("cache-invalidated");
    try {
      fs.rmSync(this.getCachePath(), { force: true });
    } catch {
      // cache file may be gone already
    }
    this.cacheFingerprint = null;
  }

  async buildCache(operation) {
    if (!operation?.controller) {
      await this.loadProjects({
        loadCache: false,
        signal: operation?.signal,
        publish: operation?.publish,
      });
      return;
    }
    this.assertCurrentLoad(operation);
    await this.ensureConfigFile();
    this.assertCurrentLoad(operation);
    operation.configFingerprint = this.getConfigFingerprint(operation.configPath);
    const configData = require("@lumine-code/season").readFileSync(operation.configPath);
    if (configData instanceof Error) {
      throw new Error(configData.message);
    }
    operation.items = [];
    for (const configuredItem of configData) {
      this.assertCurrentLoad(operation);
      try {
        const item = { ...configuredItem, paths: [...configuredItem.paths] };
        item.paths = await this.expandGlobPaths(item.paths);
        this.assertCurrentLoad(operation);
        if (operation.checkExists) {
          let paths = [];
          for (let ppath of item.paths) {
            try {
              const stats = await fs.promises.stat(ppath);
              this.assertCurrentLoad(operation);
              if (stats.isDirectory()) paths.push(ppath);
            } catch {
              this.assertCurrentLoad(operation);
              // skip paths that do not exist
            }
          }
          if (paths.length === 0) {
            continue;
          }
          // Keep missing roots visible to action validation. Silently dropping
          // one here would turn a later switch into a different saved session.
        }
        operation.items.push(this.prepareItem(item));
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        // skip malformed config entries
      }
    }
    this.updateLoading(operation);
    const scans = new Map();
    for (let item of operation.items.slice()) {
      if (item.scan) {
        for (let dirPath of item.paths) {
          if (scans.has(dirPath)) {
            continue;
          }
          scans.set(dirPath, this.scanDir(dirPath, item.tags, item.scan, operation));
        }
      }
    }
    await Promise.all(scans.values());
    this.assertCurrentLoad(operation);
    if (operation.useCache) {
      await this.saveCache(operation);
    }
  }

  scanDir(dirPath, tags, scanList, operation) {
    this.assertCurrentLoad(operation);
    return new Promise((resolve, reject) => {
      if (scanList == true) {
        scanList = "*/";
      }
      const workerPath = path.join(__dirname, "scan.js");
      const task = Task.once(workerPath, dirPath, scanList);
      const subscriptions = new CompositeDisposable();
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        operation.controller.signal.removeEventListener("abort", abort);
        subscriptions.dispose();
        operation.tasks.delete(task);
        task.terminate();
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        const error = new Error("Project indexing was cancelled.");
        error.name = "AbortError";
        finish(error);
      };
      operation.tasks.add(task);
      subscriptions.add(
        task.on("project-list:entries", (entries) => {
          if (settled) return;
          if (!this.isCurrentLoad(operation)) return abort();
          try {
            for (const entry of entries) {
              operation.items.push(
                this.prepareItem({
                  title: entry,
                  tags,
                  paths: [path.join(dirPath, entry)],
                }),
              );
            }
            this.updateLoading(operation);
            finish();
          } catch (error) {
            finish(error);
          }
        }),
        task.on("task:completed", () => finish()),
        task.on("task:cancelled", abort),
        task.on("task:error", (error) => finish(new Error(String(error)))),
      );
      operation.controller.signal.addEventListener("abort", abort, { once: true });
      if (operation.controller.signal.aborted) abort();
    });
  }

  findCurrentProject() {
    let current = null;
    if (this.items) {
      const proPaths = [...new Set(lumine.project.getPaths().map(withTrailingSeparator))];
      for (let item of this.items) {
        const itemPaths = [...new Set(item.paths.map(withTrailingSeparator))];
        if (itemPaths.length !== proPaths.length) {
          continue;
        }
        if (proPaths.every((proPath) => itemPaths.includes(proPath))) {
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
    const { glob, isDynamicPattern } = require("tinyglobby");
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
    this.selectListHost?.hide();
    lumine.workspace.open(this.getConfigPath());
  }

  prepareItem(item) {
    // Format: "#tag1 #tag2 Title" - tags first for better fuzzy matching
    item.text = (item.tags ? item.tags.map((x) => `#${x}`).join(" ") + " " : "") + item.title;
    item.paths = [...new Set(item.paths.map(withTrailingSeparator))];
    return item;
  }

  prepareData(item) {
    const pathsToOpen = [];
    const errs = [];
    for (let projectPath of item.paths) {
      try {
        // Follow directory links, just as the project's directory provider does.
        // One stat also avoids the exists/lstat race and catches access failures.
        if (!fs.statSync(projectPath).isDirectory()) throw new Error("Not a directory");
        pathsToOpen.push(normalizeSeparators(projectPath));
      } catch {
        errs.push(projectPath);
      }
    }
    if (errs.length) {
      lumine.notifications.addError("Project directory is unavailable", {
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
  const schedule = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      func.apply(this, args);
    }, timeout);
  };
  schedule.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return schedule;
}

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "project-list",
      tips: ["You can switch to another project with {{ 'project-list:toggle' | keystroke }}"],
    };
  },

  activate() {
    this.projectList = new ProjectList();
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
