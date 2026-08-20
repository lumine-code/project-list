const path = require("path");

describe("project-list recent projects", () => {
  let main, list, workspaceElement;

  const alpha = { title: "Alpha", paths: [path.join(__dirname, "alpha") + path.sep] };
  const beta = { title: "Beta", paths: [path.join(__dirname, "beta") + path.sep] };
  const gamma = { title: "Gamma", paths: [path.join(__dirname, "gamma") + path.sep] };

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    lumine.config.set("project-list.recentCount", 10);

    main = (await lumine.packages.activatePackage("project-list")).mainModule;
    list = main.projectList;
    list.clearRecent();

    // The list is normally built from the user's projects file; the specs
    // seed it directly rather than writing one.
    list.restart = false;
    list.items = [alpha, beta, gamma].map((item) => ({ ...item, text: item.title }));
    await list.selectList.update({ items: list.items, recentIds: list.recentlyUsed });
  });

  afterEach(async () => {
    list.setOpenExternalService(null);
    await lumine.packages.deactivatePackage("project-list");
  });

  function seeded(title) {
    return list.items.find((item) => item.title === title);
  }

  it("keeps the projects it opened at the top, ruled off from the rest", async () => {
    list.recordRecent(seeded("Gamma"));
    await list.selectList.update({});

    expect(list.selectList.items[0].title).toBe("Gamma");
    const separator = list.selectList.element.querySelector(".select-list-separator");
    expect(separator.previousElementSibling.textContent).toContain("Gamma");
    expect(separator.nextElementSibling.textContent).not.toContain("Gamma");
  });

  it("identifies a project by its title and paths, so a rebuilt copy still matches", async () => {
    list.recordRecent(seeded("Beta"));

    // A rescan produces equal-but-not-identical objects.
    list.items = [alpha, beta, gamma].map((item) => ({ ...item, text: item.title }));
    await list.selectList.update({ items: list.items, recentIds: list.recentlyUsed });

    expect(list.selectList.items[0].title).toBe("Beta");
  });

  it("records the project for every action over it, not only an open", () => {
    spyOn(lumine.application, "openWindow");
    spyOn(list.selectList, "getSelectedItem").and.returnValue(seeded("Alpha"));
    spyOn(list, "prepareData").and.returnValue({ pathsToOpen: [__dirname] });
    list.setOpenExternalService({
      openExternal: jasmine.createSpy("openExternal"),
      showInFolder: jasmine.createSpy("showInFolder"),
    });

    list.performAction("show-in-folder");
    expect(list.openExternalService.showInFolder).toHaveBeenCalledWith(__dirname);
    expect(list.recentlyUsed).toEqual([list.projectKey(seeded("Alpha"))]);

    list.clearRecent();
    list.performAction("open-in-new-window");
    expect(list.recentlyUsed).toEqual([list.projectKey(seeded("Alpha"))]);
    expect(main.serialize()).toEqual({ recentlyUsed: list.recentlyUsed });
  });

  it("records nothing when the project resolves to no paths at all", () => {
    spyOn(list.selectList, "getSelectedItem").and.returnValue(seeded("Alpha"));
    spyOn(list, "prepareData").and.returnValue({ pathsToOpen: [] });

    list.performAction("open-in-new-window");

    expect(list.recentlyUsed).toEqual([]);
  });

  it("stands the section down under a query", async () => {
    list.recordRecent(seeded("Gamma"));
    list.selectList.show();
    list.selectList.refs.queryEditor.setText("alpha");
    await lumine.views.getNextUpdatePromise();

    expect(list.selectList.element.querySelector(".select-list-separator")).toBeNull();
  });

  it("caps the list at the configured count", () => {
    lumine.config.set("project-list.recentCount", 2);
    list.recordRecent(seeded("Alpha"));
    list.recordRecent(seeded("Beta"));
    list.recordRecent(seeded("Gamma"));

    expect(list.recentlyUsed).toEqual([
      list.projectKey(seeded("Gamma")),
      list.projectKey(seeded("Beta")),
    ]);
  });

  it("forgets everything on clear-recent", async () => {
    list.recordRecent(seeded("Gamma"));
    await list.selectList.update({});

    lumine.commands.dispatch(workspaceElement, "project-list:clear-recent");
    await list.selectList.update({});

    expect(list.recentlyUsed).toEqual([]);
    expect(list.selectList.element.querySelector(".select-list-separator")).toBeNull();
  });
});
