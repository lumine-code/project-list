describe("project-list cache synchronization", () => {
  let main, list;

  beforeEach(async () => {
    spyOn(lumine.window, "onDidReceive").and.callThrough();
    main = (await lumine.packages.activatePackage("project-list")).mainModule;
    list = main.projectList;
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
});
