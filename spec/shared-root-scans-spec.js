const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Project List distinct scans on one configured root", () => {
  let list, directory, temporary;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.clipboard, "write");
    jasmine.attachToDOM(lumine.workspace.getElement());
    temporary = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporary, "project-scans-owned-")),
    );
    for (const name of ["alpha-one", "beta-one"]) fs.mkdirSync(path.join(directory, name));
    lumine.config.set("project-list.useCache", false);
  });
  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("project-list"))
      await lumine.packages.unloadPackage("project-list");
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(fs.realpathSync.native(directory)) !== temporary ||
      !path.basename(directory).startsWith("project-scans-owned-")
    )
      throw Error("Unsafe project scan fixture cleanup");
    for (const name of ["alpha-one", "beta-one"]) fs.rmdirSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  async function show(entries) {
    const configDirectory = fs.realpathSync.native(lumine.getConfigDirPath());
    const relative = path.relative(temporary, configDirectory);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("Config directory is not private");
    fs.writeFileSync(path.join(configDirectory, "projects.json"), JSON.stringify(entries));
    list = (await lumine.packages.activatePackage("project-list")).mainModule.projectList;
    await lumine.commands.dispatch(lumine.workspace.getElement(), "project-list:toggle");
    await conditionPromise(() => !list.restart && !list.restarting);
    await conditionPromise(() => list.selectList.getItems().length >= entries.length);
    return list.selectList
      .getItems()
      .map((item) => item.title)
      .sort();
  }
  it("includes each distinct configured scan pattern instead of keeping only the first", async () => {
    const titles = await show([
      { title: "Alpha group", paths: [directory], scan: "alpha-*" },
      { title: "Beta group", paths: [directory], scan: "beta-*" },
    ]);
    expect(titles).toEqual(["Alpha group", "Beta group", "alpha-one", "beta-one"]);
  });
  it("retains an ordinary array of scan patterns on a single entry", async () => {
    const titles = await show([{ title: "Both", paths: [directory], scan: ["alpha-*", "beta-*"] }]);
    expect(titles).toEqual(["Both", "alpha-one", "beta-one"]);
  });
  it("keeps overlapping scans unique on the same root", async () => {
    const titles = await show([
      { title: "All projects", paths: [directory], scan: "*" },
      { title: "Beta group", paths: [directory], scan: "beta-*" },
    ]);
    expect(titles).toEqual(["All projects", "Beta group", "alpha-one", "beta-one"]);
  });
});
