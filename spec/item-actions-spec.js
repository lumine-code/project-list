const path = require("path");
const fs = require("fs");
const temp = require("@lumine-code/fs-temp").track();

describe("project-list item actions", () => {
  let main, list;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    // No activation commands here, so a plain activation resolves; it also
    // loads the package keymap the actions list reads.
    main = (await lumine.packages.activatePackage("project-list")).mainModule;
    list = main.projectList;
    list.ensureSelectList();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("project-list");
  });

  it("describes its declared actions through the command registry and keymap", async () => {
    list.selectListHost.getPanel();
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
    expect(byCommand.get("project-list:copy-paths").keystrokes).toEqual(["alt-c"]);
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

  it("hides the picker before opening its configuration", () => {
    const hide = spyOn(list.selectListHost, "hide");
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
    list.selectListHost.show();

    expect(await list.selectListHost.showActions()).toBe(true);

    expect(lumine.workspace.getModalTrail()).toEqual(["Projects", "Actions"]);
    expect(lumine.workspace.popModal()).toBe(true);

    const spy = spyOn(list, "performAction").and.returnValue(true);
    await list.selectList.runAction("project-list:add-to-project");

    expect(spy).toHaveBeenCalledWith(item, "add-to-project");
    expect(list.selectListHost.isVisible()).toBeFalse();
  });

  describe("opening in this window", () => {
    beforeEach(() => {
      spyOn(lumine.project, "setState").and.resolveTo(true);
      spyOn(lumine.application, "openWindow");
      spyOn(lumine.window, "close");
      spyOn(lumine.window, "isDevMode").and.returnValue(false);
      spyOn(lumine.window, "isSafeMode").and.returnValue(false);
    });

    it("hands the paths to the project rather than opening a window", () => {
      list.selectedItem = { title: "Plain", paths: [__dirname] };

      list.performAction(list.selectedItem, "open-in-this-window");

      expect(lumine.project.setState).toHaveBeenCalledWith([__dirname]);
      expect(lumine.application.openWindow).not.toHaveBeenCalled();
      expect(lumine.window.close).not.toHaveBeenCalled();
    });

    it("returns the asynchronous switch result, including cancellation", async () => {
      lumine.project.setState.and.resolveTo(false);

      expect(
        await list.performAction({ title: "Plain", paths: [__dirname] }, "open-in-this-window"),
      ).toBe(false);
    });

    it("propagates a restoration failure to the action runner", async () => {
      const error = new Error("Unable to restore the project");
      lumine.project.setState.and.rejectWith(error);

      await expectAsync(
        list.performAction({ title: "Plain", paths: [__dirname] }, "open-in-this-window"),
      ).toBeRejectedWith(error);
    });

    it("waits for a switch and deduplicates repeated picker actions", async () => {
      let finish;
      lumine.project.setState.and.returnValue(new Promise((resolve) => (finish = resolve)));
      const item = { title: "Plain", text: "Plain", paths: [__dirname] };
      list.restart = false;
      list.items = [item];
      await list.selectList.setItems([item]);
      list.selectListHost.show();

      const first = list.selectList.runAction("project-list:open-in-this-window");
      const second = list.selectList.runAction("project-list:open-in-this-window");
      await conditionPromise(() => lumine.project.setState.calls.count() === 1);

      expect(list.selectListHost.isVisible()).toBeTrue();
      finish(true);
      await Promise.all([first, second]);
      expect(lumine.project.setState).toHaveBeenCalledTimes(1);
      expect(list.selectListHost.isVisible()).toBeFalse();
    });

    it("dispatches alt-enter from the picker's mini editor", async () => {
      const item = { title: "Plain", text: "Plain", paths: [__dirname] };
      list.restart = false;
      list.items = [item];
      await list.selectList.setItems([item]);
      list.selectListHost.show();
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "target", {
        value: list.selectList.getQueryEditor().getElement(),
      });

      lumine.keymaps.handleKeyboardEvent(event);

      await conditionPromise(() => lumine.project.setState.calls.count() === 1);
      expect(lumine.project.setState).toHaveBeenCalledWith([__dirname]);
      expect(lumine.application.openWindow).not.toHaveBeenCalled();
    });

    it("falls back to a new window for a project that asks for dev mode", () => {
      list.selectedItem = { title: "Dev", paths: [__dirname], devMode: true };

      list.performAction(list.selectedItem, "open-in-this-window");

      expect(lumine.project.setState).not.toHaveBeenCalled();
      expect(lumine.application.openWindow).toHaveBeenCalled();
      expect(lumine.application.openWindow.calls.mostRecent().args[0].newWindow).toBe(true);
      expect(lumine.window.close).not.toHaveBeenCalled();
    });

    it("keeps the source window open when safe mode requires a new window", () => {
      list.performAction(
        { title: "Safe", paths: [__dirname], safeMode: true },
        "open-in-this-window",
      );

      expect(lumine.project.setState).not.toHaveBeenCalled();
      expect(lumine.application.openWindow).toHaveBeenCalledWith({
        pathsToOpen: [__dirname],
        errs: [],
        safeMode: true,
        newWindow: true,
      });
      expect(lumine.window.close).not.toHaveBeenCalled();
    });

    for (const mode of ["devMode", "safeMode"]) {
      it(`switches in place when ${mode} is already active`, async () => {
        lumine.window[mode === "devMode" ? "isDevMode" : "isSafeMode"].and.returnValue(true);

        expect(
          await list.performAction(
            { title: "Matching Mode", paths: [__dirname], [mode]: true },
            "open-in-this-window",
          ),
        ).toBe(true);
        expect(lumine.project.setState).toHaveBeenCalledWith([__dirname]);
        expect(lumine.application.openWindow).not.toHaveBeenCalled();
        expect(lumine.window.close).not.toHaveBeenCalled();
      });
    }

    it("refuses a partial multi-folder switch when a folder disappeared", () => {
      const dir = temp.mkdirSync("project-list-missing-");
      const missing = path.join(dir, "gone");
      spyOn(lumine.notifications, "addError");

      expect(
        list.performAction(
          { title: "Partial", paths: [__dirname, missing] },
          "open-in-this-window",
        ),
      ).toBe(false);
      expect(lumine.project.setState).not.toHaveBeenCalled();
      expect(lumine.application.openWindow).not.toHaveBeenCalled();
      expect(lumine.notifications.addError).toHaveBeenCalledWith(
        "Project directory is unavailable",
        { detail: missing },
      );
    });

    it("preserves a filesystem root as an absolute project path", async () => {
      const root = path.parse(__dirname).root;
      const item = list.prepareItem({ title: "Root", paths: [root] });

      expect(item.paths).toEqual([root]);
      expect(await list.expandGlobPaths([root])).toEqual([root]);
      await list.performAction(item, "open-in-this-window");
      expect(lumine.project.setState).toHaveBeenCalledWith([root]);
    });

    it("accepts a directory link without a trailing separator", async () => {
      const dir = fs.realpathSync.native(temp.mkdirSync("project-list-link-"));
      const target = path.join(dir, "target");
      const link = path.join(dir, "link");
      fs.mkdirSync(target);
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

      await list.performAction({ title: "Link", paths: [link] }, "open-in-this-window");

      expect(lumine.project.setState).toHaveBeenCalledWith([link]);
    });

    it("reports filesystem access failures without starting a switch", () => {
      const original = fs.statSync;
      spyOn(fs, "statSync").and.callFake((target, ...args) => {
        if (target === __dirname) throw new Error("Access denied");
        return original(target, ...args);
      });
      spyOn(lumine.notifications, "addError");

      expect(
        list.performAction({ title: "Denied", paths: [__dirname] }, "open-in-this-window"),
      ).toBe(false);
      expect(lumine.project.setState).not.toHaveBeenCalled();
      expect(lumine.notifications.addError).toHaveBeenCalled();
    });
  });

  it("copies the selected project's paths", () => {
    spyOn(lumine.clipboard, "write");
    list.selectedItem = { title: "Selected", paths: [__dirname, path.join(__dirname, "..")] };

    list.performAction(list.selectedItem, "copy-paths");

    expect(lumine.clipboard.write).toHaveBeenCalledWith(
      [__dirname, path.join(__dirname, "..")].join("\n"),
    );
  });
});
