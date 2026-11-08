// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpPanel } from "../../../web/src/help-panel";

/** The side panel's markup, as `web/index.html` has it. */
function panel(): HelpPanel {
  document.body.innerHTML = `
    <div id="editor"></div><button id="help"></button>
    <aside id="help-panel" hidden><div id="help-divider"></div><div class="help-main">
      <div class="help-header"><div class="help-tabs">
        <button id="tab-reference"></button><button id="tab-assistant"></button>
      </div><button id="help-contents"></button><button id="help-pin"></button><button id="help-close"></button></div>
      <div id="help-body"></div>
      <div id="assistant-panel" hidden></div>
    </div></aside>`;
  const $ = (id: string): HTMLElement => document.getElementById(id)!;
  return new HelpPanel({
    panel: $("help-panel"), body: $("help-body"), button: $("help"), contents: $("help-contents"),
    pin: $("help-pin"), close: $("help-close"), divider: $("help-divider"), editor: $("editor"),
    referenceTab: $("tab-reference"), assistantTab: $("tab-assistant"), assistant: $("assistant-panel"),
  }, () => {});
}

describe("the side panel's tabs", () => {
  beforeEach(() => {
    // The reference is fetched when its tab is shown; these tests never need it.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>reference</p>")));
  });

  it("adds a tab after the console's own, with a pane of its own, filled on first show", async () => {
    const help = panel();
    const mount = vi.fn((container: HTMLElement) => {
      container.textContent = "extra content";
    });
    const onShow = vi.fn();
    help.addTab({ id: "extra", label: "Extra", wide: true, mount, onShow });

    const tabs = [...document.querySelectorAll(".help-tabs button")].map((button) => button.id || button.textContent);
    expect(tabs).toEqual(["tab-reference", "tab-assistant", "Extra"]);
    expect(mount).not.toHaveBeenCalled();

    await help.open("extra");
    expect(help.isOpen).toBe(true);
    expect(help.activeTab).toBe("extra");
    const pane = document.querySelector(".help-added-pane") as HTMLElement;
    expect(pane.hidden).toBe(false);
    expect(pane.textContent).toBe("extra content");
    expect(document.getElementById("help-body")!.hidden).toBe(true);
    expect(document.getElementById("assistant-panel")!.hidden).toBe(true);
    expect(document.getElementById("help-panel")!.classList.contains("assistant-open")).toBe(true);

    await help.open("reference");
    expect(pane.hidden).toBe(true);
    expect(document.getElementById("help-panel")!.classList.contains("assistant-open")).toBe(false);

    (document.querySelector(".help-tabs button:last-child") as HTMLElement).click();
    await Promise.resolve();
    expect(help.activeTab).toBe("extra");
    expect(mount).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledTimes(2);
  });

  it("refuses a second tab with the same id, and an unknown tab", async () => {
    const help = panel();
    expect(() => help.addTab({ id: "assistant", label: "Again", mount: () => {} })).toThrow(/already has a tab "assistant"/);
    await expect(help.open("nowhere")).rejects.toThrow(/no tab "nowhere"/);
  });

  it("shows a tab's failure in its own pane, and the panel keeps working", async () => {
    const help = panel();
    help.addTab({ id: "broken", label: "Broken", mount: () => {
      throw new Error("no server");
    } });
    await help.open("broken");
    expect((document.querySelector(".help-added-pane") as HTMLElement).textContent).toMatch(/could not be set up: no server/);
    await help.open("assistant");
    expect(help.activeTab).toBe("assistant");
  });
});
