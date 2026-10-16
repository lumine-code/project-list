describe("Project picker insertion availability", () => {
  let main, editor, other;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("project-list")).mainModule.projectList;
    editor = await lumine.workspace.open();
    other = {};
  });
  afterEach(() => main.windowLists.delete(other));
  it("uses the captured window editor rather than an unrelated active editor", () => {
    const action = main
      .projectActions(other)
      .find((action) => action.command === "project-list:insert-paths");
    main.windowLists.set(other, { editor: null });
    expect(action.enabled()).toBe(false);
    main.windowLists.set(other, { editor });
    expect(action.enabled()).toBe(true);
    editor.setReadOnly(true);
    expect(action.enabled()).toBe(false);
  });
});
