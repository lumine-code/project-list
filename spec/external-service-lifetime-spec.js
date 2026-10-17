describe("Project list external opener service ownership", () => {
  let main, leases;

  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("project-list")).mainModule;
    leases = [];
  });

  afterEach(async () => {
    leases.forEach((lease) => lease.dispose());
    await lumine.packages.deactivatePackage("project-list");
  });

  function provide() {
    const service = { openExternal() {}, showInFolder() {} };
    const lease = lumine.packages.serviceHub.provide("open-external", "1.0.0", service);
    leases.push(lease);
    return { service, lease };
  }

  it("keeps the current opener when an older hub edge is withdrawn", () => {
    const first = provide();
    const current = provide();
    expect(main.projectList.openExternalService).toBe(current.service);
    first.lease.dispose();
    expect(main.projectList.openExternalService).toBe(current.service);
  });

  it("falls back to a remaining opener when the newest hub edge is withdrawn", () => {
    const first = provide();
    const current = provide();
    current.lease.dispose();
    expect(main.projectList.openExternalService).toBe(first.service);
  });

  it("does not clear a replacement activation from a retained old consumer lease", async () => {
    const previous = main.consumeOpenExternal({ openExternal() {}, showInFolder() {} });
    await lumine.packages.deactivatePackage("project-list");
    main = (await lumine.packages.activatePackage("project-list")).mainModule;
    const current = provide();
    previous.dispose();
    expect(main.projectList.openExternalService).toBe(current.service);
  });
});
