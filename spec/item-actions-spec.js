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

  it("describes its declared actions through the command registry and keymap", async () => {
    const item = {
      title: "Selected",
      paths: [__dirname],
      text: "Selected",
    };
    list.restart = false;
    list.items = [item];
    await list.selectList.setItems([item]);
    const actions = list.selectList.getAvailableActions();
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
    expect(byCommand.get("project-list:edit").context).toBe("dialog");

    // Rebuilding the list is about the list; everything else acts on the
    // project the selection is on.
    expect(byCommand.get("project-list:refresh").context).toBe("dialog");
    expect(here.context).toBe("item");

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

  it("offers the core recent-history actions only while that history exists", async () => {
    const hasClear = () =>
      list.selectList
        .getAvailableActions()
        .some(({ command }) => command === "select-list:clear-recents");

    expect(hasClear()).toBe(false);
    await list.selectList.setRecentItemIds(["Selected\n" + __dirname]);
    expect(hasClear()).toBe(true);
    expect(
      list.selectList
        .getAvailableActions()
        .find(({ command }) => command === "select-list:clear-recents").context,
    ).toBe("dialog");
  });

  it("hides the picker before opening its configuration", () => {
    const hide = spyOn(list.selectList, "hide");
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());

    list.editConfig();

    expect(hide).toHaveBeenCalled();
    expect(lumine.workspace.open).toHaveBeenCalledWith(list.getConfigPath());
  });

  it("shows the centralized actions picker and runs an action on the model", async () => {
    const item = {
      title: "Selected",
      paths: [__dirname],
      text: "Selected",
    };
    list.restart = false;
    list.items = [item];
    await list.selectList.setItems([item]);
    list.selectList.show();

    expect(await list.selectList.showActions()).toBe(true);

    expect(lumine.workspace.getModalTrail()).toEqual(["Projects", "Actions"]);
    expect(lumine.workspace.popModal()).toBe(true);

    const spy = spyOn(list, "performAction").and.returnValue(true);
    await list.selectList.runAction("project-list:add-to-project");

    expect(spy).toHaveBeenCalledWith(item, "add-to-project");
    expect(list.selectList.isVisible()).toBeFalse();
  });

  describe("opening in this window", () => {
    beforeEach(() => {
      spyOn(lumine.project, "setState");
      spyOn(lumine.application, "openWindow");
      spyOn(lumine.window, "close");
    });

    it("hands the paths to the project rather than opening a window", () => {
      list.selectedItem = { title: "Plain", paths: [__dirname] };

      list.performAction(list.selectedItem, "open-in-this-window");

      expect(lumine.project.setState).toHaveBeenCalledWith([__dirname]);
      expect(lumine.application.openWindow).not.toHaveBeenCalled();
      expect(lumine.window.close).not.toHaveBeenCalled();
    });

    // Development and safe mode belong to the window, so they cannot change in
    // place — such a project still needs a window of its own.
    it("falls back to a new window for a project that asks for dev mode", () => {
      list.selectedItem = { title: "Dev", paths: [__dirname], devMode: true };

      list.performAction(list.selectedItem, "open-in-this-window");

      expect(lumine.project.setState).not.toHaveBeenCalled();
      expect(lumine.application.openWindow).toHaveBeenCalled();
      expect(lumine.application.openWindow.calls.mostRecent().args[0].newWindow).toBe(true);
    });
  });
});
