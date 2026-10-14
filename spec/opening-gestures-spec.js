const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CompositeDisposable } = require("lumine");

describe("project-list standard opening gestures", () => {
  let owner, host, model, items, scratch, alphaPath, betaPath, extraPath, leases, external, open;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    scratch = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "project-list-gestures-")),
    );
    alphaPath = path.join(scratch, "Alpha");
    betaPath = path.join(scratch, "Beta");
    extraPath = path.join(scratch, "Extra");
    for (const directory of [alphaPath, betaPath, extraPath]) fs.mkdirSync(directory);
    leases = new CompositeDisposable();
    const main = (await lumine.packages.activatePackage("project-list")).mainModule;
    owner = main.projectList;
    items = [
      { title: "Alpha", text: "Alpha", paths: [alphaPath] },
      { title: "Beta", text: "Beta", paths: [betaPath, extraPath], devMode: true },
    ];
    owner.items = items;
    owner.restart = false;
    spyOn(owner, "loadProjects").and.resolveTo({ items });
    host = owner.ensureSelectList();
    external = {
      openExternal: jasmine.createSpy("openExternal").and.resolveTo(""),
      showInFolder: jasmine.createSpy("showInFolder").and.resolveTo(""),
    };
    owner.openExternalService = external;
    spyOn(lumine.application, "openWindow").and.resolveTo();
    open = spyOn(lumine.workspace, "open").and.callThrough();
    model = host.getModel();
    await host.show();
    await model.selectItem(items[0]);
  });

  afterEach(async () => {
    leases.dispose();
    owner.openExternalService = null;
    await lumine.packages.deactivatePackage("project-list");
    await host.destroy();
    for (const editor of lumine.workspace.getTextEditors()) {
      if (editor.getPath()?.startsWith(scratch + path.sep)) editor.destroy();
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), scratch);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Gesture fixture escaped the private temporary directory");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function targetRow(item) {
    const id = model.getItemId(item);
    const index = model.getDisplayedItems().findIndex((current) => model.getItemId(current) === id);
    return model.getElement().querySelectorAll('[role="option"]')[index];
  }

  function nextAction() {
    return new Promise((resolve) => {
      const lease = model.onDidFinishAction((result) => {
        lease.dispose();
        resolve(result);
      });
    });
  }

  async function click(item, modifiers) {
    const finished = nextAction();
    targetRow(item)
      .querySelector(".primary-line")
      .dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...modifiers,
        }),
      );
    const result = await finished;
    await flushMicrotasks();
    return result;
  }

  function chooser(listener = jasmine.createSpy("choose")) {
    leases.add(lumine.commands.add("lumine-workspace", "open-with:toggle", listener));
    return listener;
  }

  it("Alt-clicks the clicked row into Open With without invoking the ordinary action", async () => {
    const choose = chooser();
    const result = await click(items[1], { altKey: true });
    expect(result.status).toBe("success");
    expect(result.command).toBe("project-list:open-with");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.calls.mostRecent().args[0].detail.project.paths).toEqual([betaPath, extraPath]);
    expect(choose.calls.mostRecent().args[0].detail.project.devMode).toBe(true);
    expect(choose.calls.mostRecent().args[0].target).toBe(
      lumine.workspace.getMainWindow().getElement(),
    );
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(external.openExternal).not.toHaveBeenCalled();
  });

  it("opens the selected item chooser through Alt-Enter", async () => {
    const choose = chooser();
    await model.selectItem(items[1]);
    const finished = nextAction();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: model.getQueryEditor().getElement() });
    lumine.keymaps.handleKeyboardEvent(event);
    const result = await finished;
    expect(result.command).toBe("project-list:open-with");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.calls.mostRecent().args[0].detail.project.paths).toEqual([betaPath, extraPath]);
    expect(choose.calls.mostRecent().args[0].detail.project.devMode).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("Ctrl-Alt-clicks only the external action for the clicked item", async () => {
    const result = await click(items[1], { ctrlKey: true, altKey: true });
    expect(result.command).toBe("project-list:open-external");
    expect(result.status).toBe("success");
    expect(external.openExternal.calls.allArgs()).toEqual([[betaPath], [extraPath]]);
    expect(external.showInFolder).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("Ctrl-Shift-clicks only the reveal action for the clicked item", async () => {
    const result = await click(items[1], { ctrlKey: true, shiftKey: true });
    expect(result.command).toBe("project-list:show-in-folder");
    expect(result.status).toBe("success");
    expect(external.showInFolder.calls.allArgs()).toEqual([[betaPath], [extraPath]]);
    expect(external.openExternal).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("retains the picker and its native error after chooser failure", async () => {
    chooser(jasmine.createSpy("failed chooser").and.rejectWith(new Error("Chooser failed")));
    const result = await click(items[1], { altKey: true });
    expect(result.status).toBe("error");
    expect(model.getStatus()).toEqual({ type: "error", message: "Chooser failed" });
    expect(host.isVisible()).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("removes modifier listeners when a filtered row is retired", async () => {
    const choose = chooser();
    const retired = targetRow(items[1]);
    await model.setQuery("Alpha");
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      altKey: true,
    });
    retired.querySelector(".primary-line").dispatchEvent(event);
    await flushMicrotasks();
    expect(event.defaultPrevented).toBe(false);
    expect(choose).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(external.openExternal).not.toHaveBeenCalled();
  });

  it("resolves the standard opener, pending and system-action keys locally", () => {
    const input = model.getQueryEditor().getElement();
    for (const [keystrokes, command] of [
      ["alt-enter", "project-list:open-with"],
      ["shift-enter", "project-list:open-pending"],
      ["ctrl-alt-enter", "project-list:open-external"],
      ["ctrl-shift-enter", "project-list:show-in-folder"],
    ])
      expect(lumine.keymaps.findKeyBindings({ target: input, keystrokes })[0]?.command).toBe(
        command,
      );
  });

  it("keeps pending text unavailable for a project without falling through to opening it", async () => {
    const result = await click(items[1], { shiftKey: true });
    expect(result.status).toBe("unavailable");
    expect(result.command).toBe("project-list:open-pending");
    expect(host.isVisible()).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(external.openExternal).not.toHaveBeenCalled();
  });

  it("reports a failed system action in the native picker", async () => {
    external.showInFolder.and.rejectWith(new Error("System action failed"));
    const result = await click(items[1], { ctrlKey: true, shiftKey: true });
    expect(result.status).toBe("error");
    expect(model.getStatus()).toEqual({ type: "error", message: "System action failed" });
    expect(host.isVisible()).toBe(true);
  });
});
