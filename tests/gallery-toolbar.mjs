import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { preview } from "vite";

const longFolder = `/${"Long folder path ".repeat(12).trim()}`;
const otherFolder = "/Second folder";
const { minWidth, minHeight } = JSON.parse(
  await readFile("src-tauri/tauri.conf.json", "utf8"),
).app.windows[0];
const server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;

async function checkLayout(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const problems = await page.locator("#gallery-workspace").evaluate((workspace) => {
    const bars = workspace.querySelectorAll(".gallery-bar");
    if (bars.length !== 1) return ["expected one shared toolbar"];
    const [bar] = bars;
    const dual = document.body.classList.contains("dual");
    const actions = ["open", "dual", "up", "new-folder", "sort-dir", "slideshow", "compare", "favorite", "refresh", "trash",
      ...(dual ? ["dual-layout", "move", "copy"] : ["transfer"])];
    const problems = [];

    function checkControls(container, controls) {
      const bounds = container.getBoundingClientRect();
      if (bounds.width === 0 || bounds.right > innerWidth + 1 || bounds.bottom > innerHeight + 1) {
        problems.push(`${container.className} extends beyond viewport`);
      }
      for (const selector of controls) {
        const control = container.querySelector(selector);
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (!rect.width || rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || !control.contains(hit)) {
          problems.push(`${selector} is clipped or covered`);
        }
      }
    }

    checkControls(bar, [...actions.map((action) => `[data-browse="${action}"]`), ".sort", ...(!dual ? [".thumb-size"] : [])]);
    const sort = bar.querySelector(".sort").getBoundingClientRect();
    const direction = bar.querySelector('[data-browse="sort-dir"]').getBoundingClientRect();
    if (Math.abs(sort.top + sort.height / 2 - direction.top - direction.height / 2) > 1) {
      problems.push("sort controls split across lines");
    }
    for (const pane of workspace.querySelectorAll(".gallery")) {
      if (pane.classList.contains("no-folder")) continue;
      checkControls(pane, [".list-search", ".clear-search"]);
      const bounds = pane.getBoundingClientRect();
      const path = pane.querySelector(".crumbs").getBoundingClientRect();
      const grid = pane.querySelector(".grid").getBoundingClientRect();
      const jump = pane.querySelector(".scroll-jump");
      const jumpBounds = jump.getBoundingClientRect();
      if (path.width < 32 || path.right > bounds.right + 1 || path.top < bar.getBoundingClientRect().bottom) {
        problems.push("folder path is clipped or covered");
      }
      if (!jump.hidden && (jumpBounds.top < grid.top || jumpBounds.bottom > grid.bottom)) {
        problems.push("scroll buttons extend beyond the gallery grid");
      }
      if (grid.height < 48) problems.push(`gallery is ${grid.height}px tall in a ${bounds.width}px pane`);
    }
    return problems;
  });
  assert.deepEqual(problems, [], `${width}×${height}: ${problems.join(", ")}`);
}

async function checkDirection(bar, expected) {
  for (const action of ["move", "copy"]) {
    const arrow = bar.locator(`[data-browse=${action}] .toward-other`);
    const direction = await arrow.evaluate((icon) => {
      const transform = getComputedStyle(icon).transform;
      const { a, b } = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
      return [Math.round(a), Math.round(b)].join(",");
    });
    assert.equal(direction, expected, `${action} points to the opposing pane`);
  }
}

async function checkTransfer(page, bar, pane, mode, folder, destination) {
  await pane.locator(".cell[data-index]").click();
  await bar.locator(`[data-browse=${mode}]`).click();
  const dialog = page.locator(".modal");
  const message = dialog.locator(".dialog-message");
  await message.waitFor();
  assert.equal(await message.textContent(), destination);
  await dialog.locator("button.primary").click();
  await page.waitForFunction(() => window.transferCalls.at(-1)?.command === "transfer_run");
  assert.deepEqual(await page.evaluate(() => window.transferCalls.slice(-2)), [
    { command: "transfer_plan", sources: [`${folder}/Sample.png`], dest: destination },
    { command: "transfer_run", mode, dest: destination },
  ]);
}

try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch();
    try {
      for (const locale of ["ko-KR", "en-US"]) {
        const page = await browser.newPage({ locale, viewport: { width: 1200, height: 800 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/sample-thumbnail?*", (route) => route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80" fill="#436078"/></svg>',
        }));
        await page.addInitScript(({ folder, otherFolder }) => {
          let callback = 0;
          const scenario = new URLSearchParams(location.search);
          const empty = scenario.has("empty");
          const oneOpen = scenario.has("oneOpen");
          const emptyList = { favorites: [], recent: [] };
          window.transferCalls = [];
          window.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
            transformCallback: () => ++callback,
            convertFileSrc: () => "/sample-thumbnail",
            invoke: async (command, args) => {
              if (command === "browse") return { folders: [],
                images: [{ name: "Sample.png", path: `${args.dir}/Sample.png`, size: 256, modified: 0 }] };
              if (command === "transfer_plan") {
                window.transferCalls.push({ command, sources: args.sources, dest: args.dest });
                return { files: [{ src: args.sources[0], name: "Sample.png", pair: false, exists: false, group: 0 }],
                  pairs: 0, same_folder: false, copy_only: false };
              }
              if (command === "transfer_run") {
                window.transferCalls.push({ command, mode: args.mode, dest: args.dest });
                return { done: [], failed: [], skipped: 0, overwritten: 0, cancelled: false };
              }
              return ({
                settings_get: { sidebarWidth: 520, startup: empty ? "empty" : "last", mainFolder: folder,
                  dualFolder: oneOpen ? "" : otherFolder, dual: empty || oneOpen },
                image_extensions: ["png"], video_extensions: [], take_launch_paths: [],
                library_get: emptyList, folder_roots: { drives: [], places: [] },
                "plugin:event|listen": callback, "plugin:dialog|open": otherFolder,
              })[command];
            },
          };
        }, { folder: longFolder, otherFolder });
        await page.goto(url);
        await page.locator(".crumbs .current").waitFor();
        assert.equal(await page.locator("html").getAttribute("lang"), locale.slice(0, 2));
        await checkLayout(page, minWidth, minHeight);
        await checkLayout(page, 1200, 800);
        assert.equal(await page.locator("#sidebar").evaluate((sidebar) => sidebar.offsetWidth), 520);
        const bar = page.locator(".gallery-bar");
        const dualToggle = bar.locator("[data-browse=dual]");
        const layout = bar.locator("[data-browse=dual-layout]");
        const move = bar.locator("[data-browse=move]");
        const copy = bar.locator("[data-browse=copy]");
        const first = page.locator(".gallery").first();
        const second = page.locator(".gallery").nth(1);
        await dualToggle.click();
        await second.locator(".crumbs .current").waitFor();
        assert.equal(await first.locator(".crumbs .current").getAttribute("title"), longFolder);
        assert.equal(await second.locator(".crumbs .current").getAttribute("title"), otherFolder);
        await checkDirection(bar, "-1,0");
        await checkTransfer(page, bar, second, "move", otherFolder, longFolder);
        await checkLayout(page, minWidth, minHeight);
        const open = bar.locator("[data-browse=open]");
        await open.focus();
        await page.keyboard.press("Tab");
        assert.equal(await second.locator(".grid").evaluate((grid) => grid === document.activeElement), false,
          "Tab in the toolbar does not switch panes");
        if (name === "webkit" && !await dualToggle.evaluate((button) => button === document.activeElement)) {
          // WebKit's default tab order skips buttons without Option.
          await open.focus();
          await page.keyboard.press("Alt+Tab");
        }
        assert.equal(await dualToggle.evaluate((button) => button === document.activeElement), true,
          "Tab can reach the next toolbar button in dual mode");
        const movePosition = await move.boundingBox();
        await first.locator(".grid").focus();
        await checkDirection(bar, "1,0");
        assert.deepEqual(await move.boundingBox(), movePosition);
        await page.keyboard.press("Tab");
        assert.equal(await second.locator(".grid").evaluate((grid) => grid === document.activeElement), true,
          "Tab from the gallery grid still switches panes");
        await checkDirection(bar, "-1,0");
        await layout.click();
        await checkDirection(bar, "0,-1");
        await second.locator(".grid").click();
        await checkLayout(page, minWidth, minHeight);
        await checkLayout(page, 800, minHeight);
        await first.locator(".grid").focus();
        await checkDirection(bar, "0,1");
        await checkLayout(page, 1200, 800);
        await checkTransfer(page, bar, first, "copy", longFolder, otherFolder);
        await first.locator(".grid").click(); // Clear selection so the status line does not consume the minimum-height fixture.
        await first.locator(".list-search").fill("a long search query");
        await checkLayout(page, minWidth, minHeight);
        await first.locator(".grid").focus();
        await page.keyboard.press("Control+b");
        await page.locator("body.sidebar-hidden").waitFor();
        await checkLayout(page, minWidth, minHeight);
        await checkLayout(page, 1200, 800);
        await first.locator(".clear-search").click();
        await first.locator(".cell[data-index]").click();
        await first.locator(".gallery-status").waitFor();
        assert.match(await first.locator(".gallery-status").textContent(), /Sample\.png$/);
        await page.goto(`${url}/?oneOpen`);
        await second.locator(".gallery-path-placeholder").waitFor();
        assert.equal(await move.isDisabled(), true, "No move when the other pane has no folder");
        assert.equal(await copy.isDisabled(), true, "No copy when the other pane has no folder");
        await second.locator(".grid").focus();
        await open.click();
        await second.locator(".crumbs .current").waitFor();
        assert.equal(await second.locator(".crumbs .current").getAttribute("title"), otherFolder);
        assert.equal(await first.locator(".crumbs .current").getAttribute("title"), longFolder);
        assert.equal(await copy.isEnabled(), true);
        await page.goto(`${url}/?empty`);
        await second.locator(".gallery-path-placeholder").waitFor();
        await checkLayout(page, minWidth, minHeight);
        await layout.click();
        await checkLayout(page, minWidth, minHeight);
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`${name} ${locale}: gallery toolbar layout and keyboard passed`);
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.httpServer.closeAllConnections();
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
