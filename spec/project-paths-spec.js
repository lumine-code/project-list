const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();

describe("project-list project paths", () => {
  let list, dir;

  beforeEach(async () => {
    dir = fs.realpathSync.native(temp.mkdirSync("project-list-paths-"));
    const pack = await lumine.packages.activatePackage("project-list");
    list = pack.mainModule.projectList;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("project-list");
  });

  it("recognizes a filesystem root as the current project", () => {
    const root = path.parse(dir).root;
    const item = list.prepareItem({ title: "Root", paths: [root] });
    list.items = [item];
    spyOn(lumine.project, "getPaths").and.returnValue([root]);

    expect(item.paths).toEqual([root]);
    expect(list.findCurrentProject()).toBe(item);
    expect(list.getCurrentProject()).toBe(item);
  });

  it("normalizes dot segments before opening and matching the current project", () => {
    const dotted = `${dir}${path.sep}.${path.sep}child${path.sep}..${path.sep}`;
    const item = list.prepareItem({ title: "Normalized", paths: [dotted] });
    list.items = [item];
    spyOn(lumine.project, "getPaths").and.returnValue([dir]);

    expect(item.paths).toEqual([dir + path.sep]);
    expect(list.prepareData(item).pathsToOpen).toEqual([dir]);
    expect(list.findCurrentProject()).toBe(item);
  });

  it("opens repeated spellings of the same root only once", () => {
    const item = list.prepareItem({
      title: "Repeated",
      paths: [dir, dir + path.sep, `${dir}${path.sep}.${path.sep}`],
    });
    list.items = [item];
    spyOn(lumine.project, "getPaths").and.returnValue([dir]);

    expect(item.paths).toEqual([dir + path.sep]);
    expect(list.prepareData(item).pathsToOpen).toEqual([dir]);
    expect(list.findCurrentProject()).toBe(item);
  });

  it("recognizes duplicate and unnormalized roots from an older cache", () => {
    const item = {
      title: "Cached",
      paths: [dir + path.sep, `${dir}${path.sep}.${path.sep}`],
    };
    list.items = [item];
    spyOn(lumine.project, "getPaths").and.returnValue([dir]);

    expect(list.findCurrentProject()).toBe(item);
  });

  if (process.platform === "win32") {
    it("matches a lowercase configured drive to the editor's normalized drive", () => {
      if (!/^[A-Z]:/.test(dir)) {
        pending("The temporary directory does not use a drive letter.");
        return;
      }
      const configuredPath = dir[0].toLowerCase() + dir.slice(1);
      const item = list.prepareItem({ title: "Lowercase Drive", paths: [configuredPath] });
      list.items = [item];
      spyOn(lumine.project, "getPaths").and.returnValue([dir]);

      expect(item.paths).toEqual([dir + path.sep]);
      expect(list.prepareData(item).pathsToOpen).toEqual([dir]);
      expect(list.findCurrentProject()).toBe(item);
    });
  } else {
    it("preserves a literal trailing backslash in a directory name", async () => {
      const literal = path.join(dir, "literal") + "\\";
      fs.mkdirSync(literal);
      const item = list.prepareItem({ title: "Literal Backslash", paths: [literal] });
      list.items = [item];
      spyOn(lumine.project, "getPaths").and.returnValue([literal]);

      expect(await list.expandGlobPaths([literal])).toEqual([literal]);
      expect(item.paths).toEqual([literal + path.sep]);
      expect(list.prepareData(item).pathsToOpen).toEqual([literal]);
      expect(list.findCurrentProject()).toBe(item);
    });
  }

  describe("existing project filtering", () => {
    let configPath;

    beforeEach(() => {
      configPath = path.join(dir, "projects.json");
      list.useCache = false;
      list.checkExists = true;
      spyOn(list, "getConfigPath").and.returnValue(configPath);
      spyOn(list, "ensureConfigFile").and.resolveTo();
    });

    it("retains missing configured roots when another root exists", async () => {
      const existing = path.join(dir, "existing");
      const missing = path.join(dir, "missing");
      fs.mkdirSync(existing);
      fs.writeFileSync(
        configPath,
        JSON.stringify([{ title: "Incomplete", paths: [existing, missing] }]),
      );

      await list.buildCache();

      expect(list.items.length).toBe(1);
      expect(list.items[0].paths).toEqual([existing + path.sep, missing + path.sep]);
    });

    it("omits a project whose configured roots are all missing", async () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify([
          { title: "Missing", paths: [path.join(dir, "first"), path.join(dir, "second")] },
        ]),
      );

      await list.buildCache();

      expect(list.items).toEqual([]);
    });

    it("omits a project whose only existing path is a file", async () => {
      const file = path.join(dir, "loose.txt");
      fs.writeFileSync(file, "Not a project directory.\n");
      fs.writeFileSync(configPath, JSON.stringify([{ title: "File", paths: [file] }]));

      await list.buildCache();

      expect(list.items).toEqual([]);
    });
  });
});
