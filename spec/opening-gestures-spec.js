const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CompositeDisposable } = require("lumine");

describe("project-list standard opening gestures", () => {
  const primaryClick = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
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
    leases.add(lumine.commands.add("lumine-workspace", "launcher:open", listener));
    return listener;
  }

  it("keeps Alt-click choosing an opener and Cmd/Ctrl-click opening the clicked project here", async () => {
    const choose = chooser();
    const result = await click(items[1], { altKey: true });
    expect(result.status).toBe("success");
    expect(result.command).toBe("project-list:open");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.calls.mostRecent().args[0].detail.project.paths).toEqual([betaPath, extraPath]);
    expect(choose.calls.mostRecent().args[0].detail.project.devMode).toBe(true);
    expect(choose.calls.mostRecent().args[0].target).toBe(
      lumine.workspace.getMainWindow().getElement(),
    );
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(external.openExternal).not.toHaveBeenCalled();

    const switching = spyOn(lumine.project, "setState").and.resolveTo(true);
    delete items[1].devMode;
    await model.selectItem(items[0]);
    const current = await click(items[1], primaryClick);
    expect(current.command).toBe("project-list:open-in-this-window");
    expect(current.status).toBe("success");
    expect(switching).toHaveBeenCalledOnceWith([betaPath, extraPath]);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(external.openExternal).not.toHaveBeenCalled();
    expect(external.showInFolder).not.toHaveBeenCalled();
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
    expect(result.command).toBe("project-list:open");
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

  it("Alt-Shift-clicks only the reveal action for the clicked item", async () => {
    const result = await click(items[1], { altKey: true, shiftKey: true });
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

  it("resolves opening keys and preserves a cancelled current-window request", async () => {
    const input = model.getQueryEditor().getElement();
    for (const [keystrokes, command] of [
      ["alt-enter", "project-list:open"],
      [
        process.platform === "darwin" ? "cmd-enter" : "ctrl-enter",
        "project-list:open-in-this-window",
      ],
      ["ctrl-alt-enter", "project-list:open-external"],
      ["alt-shift-enter", "project-list:show-in-folder"],
    ])
      expect(lumine.keymaps.findKeyBindings({ target: input, keystrokes })[0]?.command).toBe(
        command,
      );

    const switching = spyOn(lumine.project, "setState").and.resolveTo(false);
    delete items[1].devMode;
    await model.selectItem(items[1]);
    const finished = nextAction();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      ctrlKey: process.platform !== "darwin",
      metaKey: process.platform === "darwin",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: input });
    lumine.keymaps.handleKeyboardEvent(event);
    const result = await finished;
    expect(result.command).toBe("project-list:open-in-this-window");
    expect(result.status).toBe("success");
    expect(result.value).toEqual([false]);
    expect(switching).toHaveBeenCalledOnceWith([betaPath, extraPath]);
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a failed system action in the native picker", async () => {
    external.showInFolder.and.rejectWith(new Error("System action failed"));
    const result = await click(items[1], { altKey: true, shiftKey: true });
    expect(result.status).toBe("error");
    expect(model.getStatus()).toEqual({ type: "error", message: "System action failed" });
    expect(host.isVisible()).toBe(true);
  });

  it("uses Ctrl-Shift-click only to select the clicked row", async () => {
    const actions = jasmine.createSpy("finished action");
    const lease = model.onDidFinishAction(actions);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      shiftKey: true,
      ctrlKey: true,
    });
    targetRow(items[1]).querySelector(".primary-line").dispatchEvent(event);
    await flushMicrotasks();
    lease.dispose();
    expect(model.getItemId(model.getSelectedItem())).toBe(model.getItemId(items[1]));
    expect(event.defaultPrevented).toBe(true);
    expect(actions).not.toHaveBeenCalled();
    expect(host.isVisible()).toBe(true);
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(external.openExternal).not.toHaveBeenCalled();
    expect(external.showInFolder).not.toHaveBeenCalled();
  });

  it("restores Add to Project without Open Pending or the obsolete reveal alias", async () => {
    const input = model.getQueryEditor().getElement();
    expect(
      lumine.commands
        .findCommands({ target: input })
        .some(({ name }) => name === "project-list:open-pending"),
    ).toBe(false);
    expect(
      lumine.keymaps.findKeyBindings({ target: input, keystrokes: "shift-enter" })[0]?.command,
    ).toBe("project-list:add-to-project");
    expect(
      lumine.keymaps
        .findKeyBindings({ target: input, keystrokes: "ctrl-shift-enter" })
        .some((binding) => binding.command.startsWith("project-list:")),
    ).toBe(false);

    const previousPaths = lumine.project.getPaths();
    await model.selectItem(items[0]);
    try {
      const finished = nextAction();
      const event = new MouseEvent("click", {
        button: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      targetRow(items[1]).querySelector(".primary-line").dispatchEvent(event);
      const result = await finished;
      expect(result.status).toBe("success");
      expect(result.command).toBe("project-list:add-to-project");
      for (const directory of [betaPath, extraPath])
        expect(lumine.project.getPaths()).toContain(directory);
      expect(host.isVisible()).toBe(false);
      expect(lumine.application.openWindow).not.toHaveBeenCalled();
    } finally {
      lumine.project.setPaths(previousPaths);
      await lumine.fileWatchClient.settlePendingTeardown();
    }
  });
});
