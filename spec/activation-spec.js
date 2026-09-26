const path = require("path");

const PACKAGE_NAME = "project-list";
const PACKAGE_PATH = path.join(__dirname, "..");

describe("project-list bootstrap activation", () => {
  let pack;
  let workspaceElement;

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded(PACKAGE_NAME)) {
      await lumine.packages.unloadPackage(PACKAGE_NAME);
    }
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    pack = await lumine.packages.startPackage(PACKAGE_PATH);
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded(PACKAGE_NAME)) {
      await lumine.packages.unloadPackage(PACKAGE_NAME);
    }
  });

  it("keeps the select-list DOM out of activation", () => {
    expect(lumine.packages.getPackageLifecycleState(PACKAGE_NAME)).toBe("active");
    expect(pack.mainModule.projectList.selectListHost).toBeNull();
    expect(pack.mainModule.projectList.selectList).toBeNull();
  });

  it("creates the select list when its toggle command is used", async () => {
    await lumine.commands.dispatch(workspaceElement, "project-list:toggle");

    const { projectList } = pack.mainModule;
    expect(projectList.selectListHost).not.toBeNull();
    expect(projectList.selectListHost.isVisible()).toBe(true);
    projectList.selectListHost.hide();
  });
});
