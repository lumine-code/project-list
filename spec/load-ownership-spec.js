const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();
const { Disposable, Task } = require("lumine");

describe("project-list asynchronous load ownership", () => {
  let list, directory, configPath, cachePath, tasks;

  function writeConfig(title) {
    fs.writeFileSync(configPath, JSON.stringify([{ title, paths: [directory], scan: true }]));
  }

  async function flush() {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  }

  function deferred() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  beforeEach(async () => {
    list = (await lumine.packages.activatePackage("project-list")).mainModule.projectList;
    let watcher;
    await conditionPromise(() => {
      watcher = [...list.disposables.disposables].find((resource) => resource.ready?.then);
      return watcher;
    });
    await watcher.ready;
    advanceClock(100);
    await flush();

    directory = fs.realpathSync.native(temp.mkdirSync("project-list-owned-"));
    configPath = path.join(directory, "projects.json");
    cachePath = path.join(directory, "cache", "projects.json");
    writeConfig("Original");
    list.configPath = configPath;
    spyOn(list, "getCacheDirectoryPath").and.returnValue(path.dirname(cachePath));
    spyOn(list, "getCachePath").and.returnValue(cachePath);
    spyOn(lumine.window, "broadcast").and.resolveTo();
    lumine.config.set("project-list.checkExists", false);
    tasks = [];
    spyOn(Task, "once").and.callFake(() => {
      const callbacks = new Map();
      const task = {
        on(name, callback) {
          callbacks.set(name, callback);
          if (name === "project-list:entries") task.queuedEntries = callback;
          return new Disposable(() => callbacks.delete(name));
        },
        terminate: jasmine.createSpy("terminate").and.returnValue(true),
        deliver(entries) {
          task.queuedEntries(entries);
        },
        fail(error) {
          callbacks.get("task:error")?.(error);
        },
      };
      tasks.push(task);
      return task;
    });
  });

  afterEach(async () => {
    if (lumine.packages.isPackageActive("project-list")) {
      await lumine.packages.deactivatePackage("project-list");
    }
  });

  it("settles and stops a scan on deactivation without changing cache or committed entries", async () => {
    const committed = list.items;
    const pending = list.updateView(false);
    await conditionPromise(() => tasks.length === 1);
    await lumine.packages.deactivatePackage("project-list");
    tasks[0].deliver(["late-folder"]);
    await expectAsync(pending).toBeResolved();

    expect(list.items).toBe(committed);
    expect(tasks[0].terminate).toHaveBeenCalled();
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(lumine.window.broadcast).not.toHaveBeenCalled();
  });

  it("keeps a newer refresh and ignores the previous worker's queued result", async () => {
    const first = list.updateView(false);
    await conditionPromise(() => tasks.length === 1);
    writeConfig("Newest");
    list.clearCache();
    const second = list.updateView(false);
    await flush();
    expect(tasks.length).toBe(2);
    if (tasks[1]) tasks[1].deliver(["new-folder"]);
    else tasks[0].deliver(["old-folder"]);
    await second;
    tasks[0].deliver(["late-old-folder"]);
    await first;

    expect(list.items.map((item) => item.title)).toEqual(["Newest", "new-folder"]);
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8")).items.map((item) => item.title)).toEqual([
      "Newest",
      "new-folder",
    ]);
  });

  it("does not expose partial worker data as the committed cache", async () => {
    const committed = list.items;
    const pending = list.updateView(false);
    await conditionPromise(() => tasks.length === 1);

    expect(list.items).toBe(committed);
    expect(fs.existsSync(cachePath)).toBe(false);
    tasks[0].deliver(["ready-folder"]);
    await pending;
    expect(list.items.map((item) => item.title)).toEqual(["Original", "ready-folder"]);
  });

  it("restarts pending scans for a new project generation and matches its latest roots", async () => {
    const currentRoot = path.join(directory, "current");
    fs.mkdirSync(currentRoot);
    lumine.project.setPaths([directory]);
    const pending = list.updateView(false);
    await conditionPromise(() => tasks.length === 1);
    lumine.project.setPaths([currentRoot]);
    await flush();
    const current = list.activeLoad;
    expect(tasks.length).toBe(2);
    if (tasks[1]) tasks[1].deliver(["current"]);
    else tasks[0].deliver(["outdated"]);
    await current;
    tasks[0].deliver(["late-outdated"]);
    await pending;

    expect(list.getCurrentProject()?.title).toBe("current");
    expect(list.items.some((item) => item.title.includes("outdated"))).toBe(false);
  });

  it("abandons a source load when its caller aborts without writing a cache", async () => {
    const controller = new AbortController();
    const pending = list.loadProjects({
      loadCache: false,
      signal: controller.signal,
      publish: null,
    });
    await conditionPromise(() => tasks.length === 1);
    controller.abort();
    tasks[0].deliver(["late-folder"]);
    await expectAsync(pending).toBeResolved();

    expect(tasks[0].terminate).toHaveBeenCalled();
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(lumine.window.broadcast).not.toHaveBeenCalled();
  });

  it("rejects changed configuration contents before a queued worker can write cache", async () => {
    const pending = list.updateView(false);
    await conditionPromise(() => tasks.length === 1);
    writeConfig("A different configuration with a different size");
    tasks[0].deliver(["obsolete"]);
    await pending;

    expect(list.items).toEqual([]);
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(lumine.window.broadcast).not.toHaveBeenCalled();
  });

  it("does not commit instance state after a cache broadcast outlives disposal", async () => {
    const committed = list.items;
    const broadcast = deferred();
    lumine.window.broadcast.and.returnValue(broadcast.promise);
    const pending = list.updateView(false);
    await conditionPromise(() => tasks.length === 1);
    tasks[0].deliver(["finished"]);
    await conditionPromise(() => lumine.window.broadcast.calls.count() === 1);
    const saved = fs.readFileSync(cachePath, "utf8");
    await lumine.packages.deactivatePackage("project-list");

    broadcast.resolve();
    await pending;
    expect(list.items).toBe(committed);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(saved);
  });

  it("preserves the real Task scan protocol and cache format", async () => {
    Task.once.and.callThrough();
    fs.mkdirSync(path.join(directory, "scan-alpha"));
    fs.mkdirSync(path.join(directory, "scan-beta"));
    fs.writeFileSync(
      configPath,
      JSON.stringify([{ title: "Scanned", paths: [directory], scan: "scan-*" }]),
    );

    await list.updateView(false);

    expect(list.items.map((item) => item.title).sort()).toEqual([
      "Scanned",
      "scan-alpha",
      "scan-beta",
    ]);
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(cache.version).toBe(1);
    expect(JSON.stringify(cache.items)).toBe(JSON.stringify(list.items));
    expect(Task.once).toHaveBeenCalledWith(
      path.join(__dirname, "../lib/scan.js"),
      directory + path.sep,
      "scan-*",
    );
  });

  it("settles sibling workers when one scan fails and ignores their queued entries", async () => {
    const other = path.join(directory, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(
      configPath,
      JSON.stringify([{ title: "Both roots", paths: [directory, other], scan: true }]),
    );
    const pending = list.updateView(false);
    await conditionPromise(() => tasks.length === 2);
    tasks[0].fail("Unable to scan the first root");
    const publication = await pending;
    const committed = list.items.slice();
    tasks[1].deliver(["late-other-root"]);

    expect(publication.status.type).toBe("error");
    expect(tasks[0].terminate).toHaveBeenCalled();
    expect(tasks[1].terminate).toHaveBeenCalled();
    expect(list.items).toEqual(committed);
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});
