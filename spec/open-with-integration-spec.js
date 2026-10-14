const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("project-list native Open With flow", () => {
  let list, chooser, host, scratch, roots, item, previousPaths;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    previousPaths = lumine.project.getPaths();
    scratch = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "project-opener-flow-")),
    );
    roots = [path.join(scratch, "first"), path.join(scratch, "second")];
    for (const directory of roots) fs.mkdirSync(directory);
    item = { title: "Multi", text: "Multi", paths: roots };
    chooser = (await lumine.packages.activatePackage("open-with")).mainModule;
    list = (await lumine.packages.activatePackage("project-list")).mainModule.projectList;
    list.items = [item];
    list.restart = false;
    spyOn(list, "loadProjects").and.resolveTo({ items: [item] });
    host = list.ensureSelectList();
    await host.show();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.workspace, "openEditorWindow").and.rejectWith(
      new Error("No native test window requested"),
    );
    spyOn(lumine.project, "setState").and.resolveTo(true);
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("open-with");
    await lumine.packages.deactivatePackage("project-list");
    await host.destroy();
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), scratch);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Project flow fixture escaped the private temporary directory");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function openChooser() {
    const result = await host.getModel().runAction("project-list:open-with");
    expect(result.status).toBe("success");
    const record = chooser.pickers.get(lumine.workspace.getMainWindow());
    expect(record.context.project.paths).toEqual(roots);
    expect(record.host.getModel().getSelectedItem().id).toBe("project-folder");
    expect(record.host.isVisible()).toBe(true);
    expect(host.isVisible()).toBe(false);
    expect(lumine.workspace.getModalTrail()).toEqual(["Projects", "Open With"]);
    return record;
  }

  it("opens every project root in one new window with its dev and safe mode metadata", async () => {
    item.devMode = true;
    item.safeMode = true;
    const { host: child, context } = await openChooser();
    expect(context.project.devMode).toBe(true);
    expect(context.project.safeMode).toBe(true);
    const result = await child.getModel().confirmSelection();

    expect(result.status).toBe("success");
    expect(result.command).toBe("open-with:new-window");
    expect(lumine.application.openWindow).toHaveBeenCalledOnceWith({
      pathsToOpen: roots,
      newWindow: true,
      reuseEmptyWindow: false,
      devMode: true,
      safeMode: true,
    });
    expect(lumine.project.setState).not.toHaveBeenCalled();
    expect(lumine.workspace.openEditorWindow).not.toHaveBeenCalled();
    expect(child.isDestroyed()).toBe(true);
  });

  it("switches the current project to all roots through the child picker", async () => {
    const { host: child } = await openChooser();
    const result = await child.getModel().runAction("open-with:this-window");

    expect(result.status).toBe("success");
    expect(lumine.project.setState).toHaveBeenCalledOnceWith(roots);
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(lumine.workspace.openEditorWindow).not.toHaveBeenCalled();
    expect(child.isDestroyed()).toBe(true);
  });
});
