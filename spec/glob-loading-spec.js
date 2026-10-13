describe("project-list glob loading", () => {
  let loader, list;

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("project-list");
    list = pack.mainModule.projectList;
    loader = require("../lib/glob-loader");
  });

  it("shares concurrent first requests for the native glob module", async () => {
    const runtime = { glob() {}, isDynamicPattern() {} };
    const imports = jasmine.createSpy("importGlob").and.resolveTo(runtime);
    const load = loader.createGlobLoader(imports);
    const first = load();
    const second = load();

    expect(first).toBe(second);
    expect(imports).not.toHaveBeenCalled();
    await expectAsync(first).toBeResolvedTo(runtime);
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it("allows another request after a failed import", async () => {
    const failure = new Error("glob unavailable");
    const imports = jasmine.createSpy("importGlob").and.rejectWith(failure);
    const load = loader.createGlobLoader(imports);
    await expectAsync(load()).toBeRejectedWith(failure);
    imports.and.resolveTo({});
    await expectAsync(load()).toBeResolved();
    expect(imports).toHaveBeenCalledTimes(2);
  });

  it("does not start a glob after cancellation during its import", async () => {
    let release;
    spyOn(loader, "loadGlob").and.returnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const glob = jasmine.createSpy("glob").and.resolveTo([]);
    const controller = new AbortController();
    const pending = list.expandGlobPaths(["**"], { signal: controller.signal });
    controller.abort();
    release({ glob, isDynamicPattern: () => true });

    await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    expect(glob).not.toHaveBeenCalled();
  });

  it("does not import when the caller has already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    spyOn(loader, "loadGlob").and.callThrough();
    await expectAsync(list.expandGlobPaths(["**"], { signal: controller.signal })).toBeRejected();
    expect(loader.loadGlob).not.toHaveBeenCalled();
  });
});
