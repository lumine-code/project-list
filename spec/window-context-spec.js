describe("project pickers in editor windows", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("project-list");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("project-list");
    await lumine.workspace.discardEditorWindows();
  });
  it("shares the index while preserving local queries and insertion targets", async () => {
    const workspace = lumine.workspace;
    const first = await workspace.open();
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    const list = lumine.packages.getActivePackage("project-list").mainModule.projectList;
    let watcher;
    await conditionPromise(() => {
      watcher = [...list.disposables.disposables].find((resource) => resource.ready?.then);
      return watcher;
    });
    await watcher.ready;
    let finish;
    const items = [{ title: "Project", paths: [__dirname], tags: [], text: "Project" }];
    const load = spyOn(list, "performLoadProjects").and.callFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const localOpening = lumine.commands.dispatch(first.getElement(), "project-list:toggle");
    await conditionPromise(() => !!finish);
    const remoteOpening = lumine.commands.dispatch(second.getElement(), "project-list:toggle");
    await conditionPromise(() => list.activeOperation.clients.size === 2);
    expect(load).toHaveBeenCalledTimes(1);
    finish({ items, status: null });
    await Promise.all([localOpening, remoteOpening]);
    const local = list.windowLists.get(workspace.getMainWindow());
    const remote = list.windowLists.get(extra);
    expect(local.host.isVisible()).toBe(true);
    expect(remote.model.getElement().ownerDocument).toBe(extra.getDocument());
    await local.model.setQuery("local");
    await remote.model.selectItem(items[0]);
    await remote.model.runAction("project-list:insert-paths");
    expect(second.getText()).toBe(__dirname);
    expect(first.getText()).toBe("");
    expect(local.model.getQuery()).toBe("local");
  });
});
