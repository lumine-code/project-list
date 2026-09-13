const path = require("path");
const { Icon } = require("lumine");

describe("project-list item rendering", () => {
  let list, iconRegistration;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const main = (await lumine.packages.activatePackage("project-list")).mainModule;
    list = main.projectList;

    const item = {
      title: "Alpha",
      paths: [path.join(__dirname, "alpha") + path.sep],
      text: "Alpha",
    };
    list.restart = false;
    list.items = [item];
    await list.selectList.setItems(list.items);
  });

  afterEach(async () => {
    iconRegistration?.dispose();
    await lumine.packages.deactivatePackage("project-list");
  });

  it("routes project paths through the shared icon registry", () => {
    const line = list.selectList.getElement().querySelector(".secondary-line");
    expect(line).toHaveClass("icon-file-directory");

    iconRegistration = lumine.icons.addProvider(
      {
        id: "project-list-spec",
        handles: ["path"],
        usesContext: true,
        iconFor(target) {
          return target.context === "project-list" ? Icon.classes(["icon-flame"]) : null;
        },
      },
      { priority: 100 },
    );
    expect(line).toHaveClass("icon-flame");
  });
});
