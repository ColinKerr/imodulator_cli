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
}

export class HelpPanel {
  private loaded = false;
  private pinned = false;

  constructor(private readonly ui: HelpPanelElements, private readonly onResize: () => void) {
    ui.button.addEventListener("click", () => void this.toggle());
    ui.close.addEventListener("click", () => this.setOpen(false));
    ui.pin.addEventListener("click", () => this.setPinned(!this.pinned));
    ui.contents.addEventListener("click", () => this.scrollTo("index"));
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

  public async toggle(): Promise<void> {
    if (this.isOpen) {
      this.setOpen(false);
      return;
    }
    await this.load();
    this.setOpen(true);
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

  private setPinned(pinned: boolean): void {
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
