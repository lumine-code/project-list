describe("project-list item actions", () => {
  let main, list;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    // No activation commands here, so a plain activation resolves; it also
    // loads the package keymap the actions list reads.
    main = (await lumine.packages.activatePackage("project-list")).mainModule;
    list = main.projectList;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("project-list");
  });

  it("derives its actions from the command registrations and the keymap", () => {
    spyOn(list.selectList, "getSelectedItem").and.returnValue({
      title: "Selected",
      paths: [__dirname],
    });
    const actions = list.selectList.itemActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const here = byCommand.get("project-list:open-in-this-window");
    expect(here.name).toBe("Open In This Window");
    expect(here.description).toBe(
      "Open the project here, restoring the editors it was last left with.",
    );
    expect(here.keystrokes).toEqual(["alt-enter"]);

    expect(byCommand.get("project-list:add-to-project").keystrokes).toEqual(["shift-enter"]);
    expect(byCommand.get("project-list:refresh").keystrokes).toEqual(["f5"]);
    expect(byCommand.get("project-list:open-in-new-window").keystrokes).toEqual(["enter"]);
    expect(byCommand.get("project-list:edit").scope).toBe("list");

    // Rebuilding the list is about the list; everything else acts on the
    // project the selection is on.
    expect(byCommand.get("project-list:refresh").scope).toBe("list");
    expect(here.scope).toBe("item");

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }

    // Chrome and global commands stay out — including the workspace-level
    // update, which is why the in-list rebuild is named refresh.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("project-list:toggle")).toBe(false);
    expect(byCommand.has("project-list:update")).toBe(false);
  });

  it("offers recent-history actions only while that history exists", () => {
    spyOn(list.selectList, "getSelectedItem").and.returnValue(null);
    const hasClear = () =>
      list.selectList.itemActions().some(({ command }) => command === "project-list:clear-recent");

    expect(hasClear()).toBe(false);
    list.recentlyUsed = ["Selected\n" + __dirname];
    expect(hasClear()).toBe(true);
    expect(
      list.selectList.itemActions().find(({ command }) => command === "project-list:clear-recent")
        .scope,
    ).toBe("list");
  });

  it("hides the picker before opening its configuration", () => {
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    list.selectList.show();

    list.editConfig();

    expect(list.selectList.isVisible()).toBe(false);
    expect(lumine.workspace.open).toHaveBeenCalledWith(list.getConfigPath());
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
    spyOn(list.selectList, "getSelectedItem").and.returnValue({
      title: "Selected",
      paths: [__dirname],
    });
    list.selectList.show();

    await list.selectList.showItemActions();

    expect(list.selectList.itemActionsList.isVisible()).toBeTruthy();
    expect(lumine.workspace.getModalTrail()).toEqual(["Projects", "Actions"]);
    // The actions list wears the package class, so the package keymap
    // resolves action keystrokes inside it too.
    expect(list.selectList.itemActionsList.element.classList.contains("project-list")).toBe(true);

    const spy = spyOn(list, "performAction");
    const index = list.selectList.itemActionsList.items.findIndex(
      (item) => item.command === "project-list:add-to-project",
    );
    list.selectList.itemActionsList.selectIndex(index);
    list.selectList.itemActionsList.confirmSelection();

    expect(spy).toHaveBeenCalledWith("add-to-project");
    expect(list.selectList.isVisible()).toBeTruthy();
    expect(list.selectList.itemActionsList.isVisible()).toBeFalsy();
  });

  describe("opening in this window", () => {
    beforeEach(() => {
      spyOn(lumine.project, "setState");
      spyOn(lumine.application, "openWindow");
      spyOn(lumine.window, "close");
      spyOn(list.selectList, "getSelectedItem").and.callFake(() => list.selectedItem);
    });

    it("hands the paths to the project rather than opening a window", () => {
      list.selectedItem = { title: "Plain", paths: [__dirname] };

      list.performAction("open-in-this-window");

      expect(lumine.project.setState).toHaveBeenCalledWith([__dirname]);
      expect(lumine.application.openWindow).not.toHaveBeenCalled();
      expect(lumine.window.close).not.toHaveBeenCalled();
    });

    // Development and safe mode belong to the window, so they cannot change in
    // place — such a project still needs a window of its own.
    it("falls back to a new window for a project that asks for dev mode", () => {
      list.selectedItem = { title: "Dev", paths: [__dirname], devMode: true };

      list.performAction("open-in-this-window");

      expect(lumine.project.setState).not.toHaveBeenCalled();
      expect(lumine.application.openWindow).toHaveBeenCalled();
      expect(lumine.application.openWindow.calls.mostRecent().args[0].newWindow).toBe(true);
    });
  });
});
