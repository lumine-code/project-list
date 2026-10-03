const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();

describe("project-list cache synchronization", () => {
  let main, list, cacheDir, cachePath;

  beforeEach(async () => {
    spyOn(lumine.window, "onDidReceive").and.callThrough();
    main = (await lumine.packages.activatePackage("project-list")).mainModule;
    list = main.projectList;
    cacheDir = fs.realpathSync.native(temp.mkdirSync("project-list-cache-"));
    cachePath = path.join(cacheDir, "projects.json");
    spyOn(list, "getCacheDirectoryPath").and.returnValue(cacheDir);
    spyOn(list, "getCachePath").and.returnValue(cachePath);
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("project-list");
  });

  it("subscribes through the public window service", () => {
    const [eventName, callback] = lumine.window.onDidReceive.calls.mostRecent().args;
    expect(eventName).toBe("project-list:cache-updated");
    expect(typeof callback).toBe("function");
  });

  it("broadcasts a saved cache through the public window service", async () => {
    spyOn(lumine.window, "broadcast").and.resolveTo();
    list.items = [];

    await list.saveCache();

    expect(lumine.window.broadcast).toHaveBeenCalledWith(
      "project-list:cache-updated",
      list.cacheFingerprint,
    );
  });

  it("saves the cache schema version alongside the complete project entries", async () => {
    spyOn(lumine.window, "broadcast").and.resolveTo();
    const item = list.prepareItem({
      title: "Cached",
      tags: ["work"],
      paths: [cacheDir, path.join(cacheDir, "missing")],
    });
    list.items = [item];

    await list.saveCache();

    expect(JSON.parse(fs.readFileSync(cachePath, "utf8"))).toEqual({
      version: 1,
      items: [item],
    });
  });

  it("normalizes compatible cache entries before exposing them", () => {
    let cachedPath = `${cacheDir}${path.sep}.${path.sep}`;
    if (process.platform === "win32") {
      cachedPath = cachedPath.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    }
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        items: [
          {
            title: "Cached",
            tags: ["work"],
            paths: [cachedPath, cacheDir],
            text: "An obsolete search string",
          },
        ],
      }),
    );

    expect(list.loadCache()).toBe(true);
    expect(list.items).toEqual([
      {
        title: "Cached",
        tags: ["work"],
        paths: [cacheDir + path.sep],
        text: "#work Cached",
      },
    ]);
    expect(list.cacheFingerprint).toBe(list.getCacheFingerprint());
  });

  it("rejects the legacy array cache without replacing the current entries", () => {
    const currentItems = [{ title: "Current", paths: [cacheDir] }];
    list.items = currentItems;
    list.cacheFingerprint = "current";
    fs.writeFileSync(
      cachePath,
      JSON.stringify([{ title: "Legacy", paths: [path.join(cacheDir, "other")] }]),
    );

    expect(list.loadCache()).toBe(false);
    expect(list.items).toBe(currentItems);
    expect(list.cacheFingerprint).toBe("current");
  });

  it("rejects an unsupported cache version without replacing the current entries", () => {
    const currentItems = [{ title: "Current", paths: [cacheDir] }];
    list.items = currentItems;
    list.cacheFingerprint = "current";
    fs.writeFileSync(cachePath, JSON.stringify({ version: 2, items: [] }));

    expect(list.loadCache()).toBe(false);
    expect(list.items).toBe(currentItems);
    expect(list.cacheFingerprint).toBe("current");
  });

  it("rejects a compatible cache whose entries are not an array", () => {
    const currentItems = [{ title: "Current", paths: [cacheDir] }];
    list.items = currentItems;
    fs.writeFileSync(cachePath, JSON.stringify({ version: 1, items: {} }));

    expect(list.loadCache()).toBe(false);
    expect(list.items).toBe(currentItems);
  });
});
