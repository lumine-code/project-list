const fs = require("fs");
const path = require("path");

describe("Project metadata CSS roles", () => {
  it("keeps tags readable with an independently chosen syntax palette", () => {
    const stylesheet = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(__dirname, "../styles/main.css"), "utf8"),
      { priority: 1000 },
    );
    try {
      const list = document.createElement("div");
      list.className = "project-list";
      list.style.backgroundColor = "white";
      list.style.setProperty("--text-color-subtle", "rgb(40, 50, 60)");
      list.style.setProperty("--syntax-color-constant", "rgb(255, 255, 255)");
      list.innerHTML = '<span class="tag">Work</span>';
      jasmine.attachToDOM(list);
      const tag = getComputedStyle(list.firstElementChild);
      expect(tag.color).toBe("rgb(40, 50, 60)");
      expect(tag.borderTopColor).toBe("rgb(40, 50, 60)");
    } finally {
      stylesheet.dispose();
    }
  });
});
