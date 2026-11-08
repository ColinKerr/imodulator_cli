/**
 * The ECSql reference panel.
 *
 * The reference is one HTML document, generated at build time from the markdown vendored in
 * web/help, so every cross reference within it is an anchor this panel can scroll to and the
 * browser's own find searches the whole thing.
 */

/** Where the generated document is served from, relative to the console's own base. */
const HELP_URL = "./help/ecsql-reference.html";

/** Narrower than this and the reference is unreadable; its code blocks alone want this much. */
const MIN_WIDTH = 260;

/** What the panel always leaves for the editor and results, however far it is dragged open. */
const MIN_PANES_WIDTH = 320;

/** Which tab of the panel is showing: `"reference"`, `"assistant"`, or a tab an extension added. */
export type HelpTab = string;

/** A tab added after the console's own (`addTab`). */
export interface AddedTab {
  id: string;
  label: string;
  /** Wider than the reference, as the Assistant is. */
  wide?: boolean;
  /** Called once, the first time the tab is shown, with the tab's own element. */
  mount(container: HTMLElement): void;
  /** Called each time the tab is shown, after `mount`. */
  onShow?(): void;
}

interface Tab {
  id: string;
  button: HTMLElement;
  pane: HTMLElement;
  wide: boolean;
  /** Set up on first show; undefined once done, or for the console's own tabs. */
  mount?: (container: HTMLElement) => void;
  onShow?: () => void;
}

export interface HelpPanelElements {
  panel: HTMLElement;
  body: HTMLElement;
  /** The floating button over the editor. */
  button: HTMLElement;
  contents: HTMLElement;
  pin: HTMLElement;
  close: HTMLElement;
  /** The panel's left edge, dragged to set its width. */
  divider: HTMLElement;
  /** The editor's text area: clicking it closes the panel unless it is pinned. */
  editor: HTMLElement;
  referenceTab: HTMLElement;
  assistantTab: HTMLElement;
  assistant: HTMLElement;
}

export class HelpPanel {
  private loaded = false;
  private pinned = false;
  private tab: HelpTab = "reference";
  private readonly tabListeners: ((tab: HelpTab) => void)[] = [];
  private readonly tabs: Tab[];

  constructor(private readonly ui: HelpPanelElements, private readonly onResize: () => void) {
    ui.button.addEventListener("click", () => void this.toggle());
    ui.close.addEventListener("click", () => this.setOpen(false));
    ui.pin.addEventListener("click", () => this.setPinned(!this.pinned));
    ui.contents.addEventListener("click", () => this.scrollTo("index"));
    this.tabs = [
      { id: "reference", button: ui.referenceTab, pane: ui.body, wide: false },
      { id: "assistant", button: ui.assistantTab, pane: ui.assistant, wide: true },
    ];
    for (const tab of this.tabs)
      tab.button.addEventListener("click", () => void this.showTab(tab.id));
    this.setTab("reference");
    this.setupResizer();

    // Pointerdown rather than click: Monaco takes the pointer for its own selection handling,
    // and this is the moment the user has plainly put their attention back in the query.
    ui.editor.addEventListener("pointerdown", () => {
      if (!this.pinned)
        this.setOpen(false);
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.pinned)
        this.setOpen(false);
    });

    // Anchors are handled here instead of by the browser: the document scrolls inside this
    // panel, and letting the href through would put a fragment on the console's own URL.
    ui.body.addEventListener("click", (event) => {
      const link = (event.target as HTMLElement).closest("a");
      const href = link?.getAttribute("href");
      if (!href?.startsWith("#"))
        return;
      event.preventDefault();
      this.scrollTo(href.slice(1));
    });
  }

  public get isOpen(): boolean {
    return !this.ui.panel.hidden;
  }

  public get isPinned(): boolean {
    return this.pinned;
  }

  public get activeTab(): HelpTab {
    return this.tab;
  }

  /** Told when the tab changes, so the Assistant can set up the first time it is shown. */
  public onTabChange(listener: (tab: HelpTab) => void): void {
    this.tabListeners.push(listener);
  }

  public async toggle(): Promise<void> {
    if (this.isOpen) {
      this.setOpen(false);
      return;
    }
    await this.showTab(this.tab);
    this.setOpen(true);
  }

  /** Open the panel on a given tab, whether or not it is already open. */
  public async open(tab: HelpTab): Promise<void> {
    await this.showTab(tab);
    if (!this.isOpen)
      this.setOpen(true);
  }

  /**
   * Add a tab after the others, with a pane of its own beside the reference and the Assistant.
   * The pane is filled by `mount` the first time the tab is shown.
   */
  public addTab(tab: AddedTab): void {
    if (this.tabs.some((other) => other.id === tab.id))
      throw new Error(`The side panel already has a tab "${tab.id}".`);
    const button = document.createElement("button");
    button.className = "help-tab";
    button.setAttribute("role", "tab");
    button.textContent = tab.label;
    const pane = document.createElement("div");
    pane.className = "help-added-pane";
    pane.setAttribute("role", "tabpanel");
    pane.hidden = true;
    // After the last tab button, and after the last pane, so the console's own come first.
    const last = this.tabs[this.tabs.length - 1];
    last.button.after(button);
    last.pane.after(pane);
    this.tabs.push({ id: tab.id, button, pane, wide: tab.wide ?? false, mount: tab.mount, onShow: tab.onShow });
    button.addEventListener("click", () => void this.showTab(tab.id));
  }

  private async showTab(tab: HelpTab): Promise<void> {
    if (!this.tabs.some((other) => other.id === tab))
      throw new Error(`The side panel has no tab "${tab}".`);
    this.setTab(tab);
    // Only the reference needs fetching, and only the first time it is asked for.
    if (tab === "reference")
      await this.load();
  }

  private setTab(tab: HelpTab): void {
    this.tab = tab;
    const onReference = tab === "reference";
    for (const { id, pane, button } of this.tabs) {
      pane.hidden = id !== tab;
      button.setAttribute("aria-selected", String(id === tab));
      button.classList.toggle("active", id === tab);
    }
    // Contents is a reference-only action; there is nothing to scroll to on the other tabs.
    this.ui.contents.hidden = !onReference;
    const shown = this.tabs.find((other) => other.id === tab);
    // The Assistant, and an added tab that asks to be, start wider than the reference, until the
    // user drags the panel to a width of their own.
    this.ui.panel.classList.toggle("assistant-open", shown?.wide ?? false);
    if (shown?.mount) {
      const mount = shown.mount;
      shown.mount = undefined;
      // An added tab is an extension's code: its failure is shown in its own pane, not thrown here.
      try {
        mount(shown.pane);
      } catch (err) {
        shown.pane.textContent = `This tab could not be set up: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    try {
      shown?.onShow?.();
    } catch (err) {
      console.error(err);
    }
    for (const listener of this.tabListeners)
      listener(tab);
    this.onResize();
  }

  /** Fetched on first open, then kept: most sessions never ask for it. */
  private async load(): Promise<void> {
    if (this.loaded)
      return;
    try {
      const response = await fetch(HELP_URL);
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
      this.ui.body.innerHTML = await response.text();
      this.loaded = true;
    } catch (err) {
      this.ui.body.textContent = `The ECSql reference could not be loaded: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  private setOpen(open: boolean): void {
    this.ui.panel.hidden = !open;
    this.ui.button.setAttribute("aria-expanded", String(open));
    if (!open)
      this.setPinned(false);
    // The panel takes its width from the panes beside it, so the editor has to re-measure.
    this.onResize();
  }

  public setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.ui.pin.setAttribute("aria-pressed", String(pinned));
    this.ui.pin.classList.toggle("pinned", pinned);
    this.ui.pin.title = pinned ? "Unpin" : "Pin open";
  }

  /**
   * Drag the panel's left edge to widen it.
   *
   * The width is set as a flex basis on the panel, so the panes beside it give up exactly the
   * space it takes. It is kept in an inline style rather than recomputed on open, which means
   * a width chosen once holds for the rest of the session.
   */
  private setupResizer(): void {
    this.ui.divider.addEventListener("pointerdown", (event) => {
      // Stops the drag from selecting the reference text it passes over.
      event.preventDefault();
      const move = (moveEvent: PointerEvent): void => {
        const area = this.ui.panel.parentElement!.getBoundingClientRect();
        const wanted = area.right - moveEvent.clientX;
        const widest = Math.max(MIN_WIDTH, area.width - MIN_PANES_WIDTH);
        this.ui.panel.style.flexBasis = `${Math.min(widest, Math.max(MIN_WIDTH, wanted))}px`;
        this.onResize();
      };
      const done = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", done);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", done);
    });
  }

  private scrollTo(id: string): void {
    const target = this.ui.body.querySelector(`#${CSS.escape(id)}`);
    target?.scrollIntoView({ block: "start" });
  }
}
