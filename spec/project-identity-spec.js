const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();

describe("project-list structural and root identity", () => {
  let list, directory, firstPath, secondPath;

  beforeEach(async () => {
    directory = fs.realpathSync.native(temp.mkdirSync("project-identity-"));
    firstPath = path.join(directory, "first");
    secondPath = path.join(directory, "second");
    fs.mkdirSync(firstPath);
    fs.mkdirSync(secondPath);
    list = (await lumine.packages.activatePackage("project-list")).mainModule.projectList;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("project-list");
  });

  function entries() {
    const ordinary = list.prepareItem({ title: "Alpha", paths: [firstPath, secondPath] });
    const multiline = list.prepareItem({
      title: `Alpha\n${ordinary.paths[0]}`,
      paths: [secondPath],
    });
    return [ordinary, multiline];
  }

  it("keeps delimiter-containing title/root tuples distinct in the actual select list", async () => {
    const [ordinary, multiline] = entries();
    expect(list.projectKey(ordinary)).not.toBe(list.projectKey(multiline));
    const model = list.ensureSelectList().getModel();
    await expectAsync(model.setItems([ordinary, multiline])).toBeResolved();
    expect(model.getItems().length).toBe(2);
  });

  it("preserves selection when a scan returns new objects with the same literal tuple", async () => {
    const model = list.ensureSelectList().getModel();
    const original = entries();
    await model.setItems(original);
    await model.selectIndex(1);
    const selectedId = list.projectKey(model.getSelectedItem());
    const refreshed = entries();
    await model.setItems(refreshed);
    expect(model.getSelectedItem()).toBe(refreshed[1]);
    expect(list.projectKey(model.getSelectedItem())).toBe(selectedId);
  });

  it("retains ordered path identity and null identity without conflating matching root sets", () => {
    const first = list.prepareItem({
      title: 'Quotes " and tabs\t',
      paths: [firstPath, secondPath],
    });
    const reordered = list.prepareItem({ title: first.title, paths: [secondPath, firstPath] });
    expect(list.projectKey(first)).not.toBe(list.projectKey(reordered));
    expect(
      list.projectKey(list.prepareItem({ title: first.title, paths: first.paths.slice() })),
    ).toBe(list.projectKey(first));
    expect(list.projectKey(null)).toBeNull();
    list.items = [first];
    spyOn(lumine.project, "getPaths").and.returnValue([secondPath, firstPath]);
    expect(list.findCurrentProject()).toBe(first);
  });

  it("does not drop a configured missing root when matching current folders", () => {
    const missing = path.join(directory, "missing");
    const item = list.prepareItem({ title: "Complete set", paths: [firstPath, missing] });
    list.items = [item];
    const paths = spyOn(lumine.project, "getPaths").and.returnValue([firstPath]);
    expect(list.findCurrentProject()).toBeNull();
    paths.and.returnValue([missing, firstPath]);
    expect(list.findCurrentProject()).toBe(item);
    expect(item.paths).toEqual([firstPath + path.sep, missing + path.sep]);
  });

  if (process.platform === "win32") {
    it("matches physically identical Windows folders with different casing", () => {
      lumine.project.setPaths([firstPath]);
      const current = lumine.project.getPaths()[0];
      const configured = current.toUpperCase();
      const before = fs.statSync(current, { bigint: true });
      const after = fs.statSync(configured, { bigint: true });
      expect(before.dev).toBe(after.dev);
      expect(before.ino).toBe(after.ino);
      const item = list.prepareItem({ title: "Native identity", paths: [configured] });
      list.items = [item];
      expect(list.findCurrentProject()).toBe(item);
    });

    it("deduplicates existing Windows aliases without changing the stored tuple", () => {
      const configured = firstPath.toUpperCase();
      const item = list.prepareItem({ title: "Alias roots", paths: [firstPath, configured] });
      list.items = [item];
      spyOn(lumine.project, "getPaths").and.returnValue([firstPath]);
      expect(list.findCurrentProject()).toBe(item);
      expect(item.paths).toEqual([firstPath + path.sep, configured + path.sep]);
    });

    it("keeps distinct filesystem identities distinct even if native string relativity folds their case", () => {
      const configured = firstPath.toUpperCase();
      const originalStat = fs.statSync.bind(fs);
      spyOn(fs, "statSync").and.callFake((target, options) => {
        const stat = originalStat(target, options);
        if (target === configured + path.sep) {
          return { isDirectory: () => true, dev: stat.dev, ino: stat.ino + 1n };
        }
        return stat;
      });
      const item = list.prepareItem({ title: "Distinct identities", paths: [configured] });
      list.items = [item];
      spyOn(lumine.project, "getPaths").and.returnValue([firstPath]);
      expect(list.findCurrentProject()).toBeNull();
    });

    it("uses exact spelling for missing Windows roots rather than folding unknown identities", () => {
      const missing = path.join(directory, "missing");
      const item = list.prepareItem({ title: "Unknown identity", paths: [missing.toUpperCase()] });
      list.items = [item];
      const roots = spyOn(lumine.project, "getPaths").and.returnValue([missing]);
      expect(list.findCurrentProject()).toBeNull();
      roots.and.returnValue([missing.toUpperCase()]);
      expect(list.findCurrentProject()).toBe(item);
    });
  } else {
    it("preserves distinct existing POSIX roots that differ in case", () => {
      const lower = path.join(directory, "case");
      const upper = path.join(directory, "CASE");
      fs.mkdirSync(lower);
      fs.mkdirSync(upper);
      const item = list.prepareItem({ title: "Uppercase", paths: [upper] });
      list.items = [item];
      const roots = spyOn(lumine.project, "getPaths").and.returnValue([lower]);
      expect(list.findCurrentProject()).toBeNull();
      roots.and.returnValue([upper]);
      expect(list.findCurrentProject()).toBe(item);
    });
  }
});
