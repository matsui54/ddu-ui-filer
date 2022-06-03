import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v1.5.0/types.ts";
import {
  batch,
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v1.5.0/deps.ts";

type DoActionParams = {
  name?: string;
  items?: DduItem[];
  params?: unknown;
};

type HighlightGroup = {
  floating?: string;
};

type Params = {
  collapsedIcon: string;
  expandedIcon: string;
  highlights: HighlightGroup;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "botright" | "topleft";
  winCol: number;
  winHeight: number;
  winRow: number;
  winWidth: number;
};

export type ActionData = {
  isDirectory?: boolean;
  path?: string;
};

export class Ui extends BaseUi<Params> {
  private buffers: Record<string, number> = {};
  private items: DduItem[] = [];
  private selectedItems: Set<number> = new Set();
  private saveTitle = "";

  refreshItems(args: {
    items: DduItem[];
  }): void {
    this.items = this.getSortedItems(args.items);
    this.selectedItems.clear();
  }

  expandItem(args: {
    parent: DduItem;
    children: DduItem[];
  }): void {
    // Search parent.
    const index = this.items.findIndex(
      (item: DduItem) =>
        item.word == args.parent.word &&
        item.__sourceIndex == args.parent.__sourceIndex,
    );
    if (index >= 0) {
      this.items = this.items.slice(0, index + 1).concat(args.children).concat(
        this.items.slice(index + 1),
      );
    } else {
      this.items = this.items.concat(args.children);
    }

    this.selectedItems.clear();
  }

  async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    const bufferName = `ddu-ff-${args.options.name}`;
    const initialized = this.buffers[args.options.name];
    const bufnr = initialized
      ? this.buffers[args.options.name]
      : await this.initBuffer(args.denops, bufferName);
    this.buffers[args.options.name] = bufnr;

    await this.setDefaultParams(args.denops, args.uiParams);

    const hasNvim = args.denops.meta.host == "nvim";
    const floating = args.uiParams.split == "floating" && hasNvim;
    const winHeight = Number(args.uiParams.winHeight);
    const winid = await fn.bufwinid(args.denops, bufnr);
    if (winid < 0) {
      const direction = args.uiParams.splitDirection;
      if (args.uiParams.split == "horizontal") {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      } else if (args.uiParams.split == "vertical") {
        const header = `silent keepalt vertical ${direction} `;
        await args.denops.cmd(
          header +
            `sbuffer +vertical\\ resize\\ ${args.uiParams.winWidth} ${bufnr}`,
        );
      } else if (floating) {
        await args.denops.call("nvim_open_win", bufnr, true, {
          "relative": "editor",
          "row": Number(args.uiParams.winRow),
          "col": Number(args.uiParams.winCol),
          "width": Number(args.uiParams.winWidth),
          "height": winHeight,
        });

        if (args.uiParams.highlights?.floating) {
          await fn.setwinvar(
            args.denops,
            await fn.bufwinnr(args.denops, bufnr),
            "&winhighlight",
            args.uiParams.highlights.floating,
          );
        }
      } else if (args.uiParams.split == "no") {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      } else {
        await args.denops.call(
          "ddu#util#print_error",
          `Invalid split param: ${args.uiParams.split}`,
        );
        return;
      }
    }

    // Note: buffers may be restored
    if (!this.buffers[args.options.name] || winid < 0) {
      await this.initOptions(args.denops, args.options, bufnr);
    }

    const header =
      `[ddu-${args.options.name}] ${this.items.length}/${args.context.maxItems}`;
    const linenr = "printf('%'.(len(line('$'))+2).'d/%d',line('.'),line('$'))";
    const async = `${args.context.done ? "" : "[async]"}`;
    const laststatus = await op.laststatus.get(args.denops);
    if (hasNvim && (floating || laststatus == 0)) {
      if (this.saveTitle == "") {
        this.saveTitle = await args.denops.call(
          "nvim_get_option",
          "titlestring",
        ) as string;
      }

      args.denops.call(
        "nvim_set_option",
        "titlestring",
        header + " %{" + linenr + "}%*" + async,
      );
    } else {
      await fn.setwinvar(
        args.denops,
        await fn.bufwinnr(args.denops, bufnr),
        "&statusline",
        header + " %#LineNR#%{" + linenr + "}%*" + async,
      );
    }

    // Update main buffer
    await args.denops.call(
      "ddu#ui#filer#_update_buffer",
      args.uiParams,
      bufnr,
      [...this.selectedItems],
      this.items.map((c, i) => {
        return {
          highlights: c.highlights ?? [],
          row: i + 1,
          prefix: "",
        };
      }).filter((c) => c.highlights),
      this.items.map((c) =>
        " ".repeat(c.__level) +
        (!(c.action as ActionData).isDirectory
          ? " "
          : c.__expanded
          ? args.uiParams.expandedIcon
          : args.uiParams.collapsedIcon) +
        " " + (c.display ?? c.word)
      ),
      false,
      0,
    );

    const saveCursor = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_filer_cursor_pos",
      [],
    ) as number[];
    const saveText = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_filer_cursor_text",
      "",
    ) as string;
    let currentText = "";
    if (saveCursor.length != 0) {
      const buflines = await fn.getbufline(args.denops, bufnr, saveCursor[1]);
      if (buflines.length != 0) {
        currentText = buflines[0];
      }
    }
    if (
      saveCursor.length != 0 && this.items.length != 0 &&
      currentText == saveText
    ) {
      await fn.cursor(args.denops, saveCursor[1], saveCursor[2]);
    } else {
      await fn.cursor(args.denops, 1, 1);
    }
  }

  async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    await vars.b.set(
      args.denops,
      "ddu_ui_filer_cursor_pos",
      await fn.getcurpos(args.denops),
    );
    await vars.b.set(
      args.denops,
      "ddu_ui_filer_cursor_text",
      await fn.getline(args.denops, "."),
    );

    if (
      args.uiParams.split == "no" || (await fn.winnr(args.denops, "$")) == 1
    ) {
      await args.denops.cmd(`buffer ${args.context.bufNr}`);
    } else {
      await args.denops.cmd("close!");
      await fn.win_gotoid(args.denops, args.context.winId);
    }

    // Restore options
    if (this.saveTitle != "") {
      args.denops.call(
        "nvim_set_option",
        "titlestring",
        this.saveTitle,
      );

      this.saveTitle = "";
    }

    // Close preview window
    await args.denops.cmd("pclose!");

    await args.denops.call("ddu#event", args.options.name, "close");
  }

  private async getItems(denops: Denops): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.selectedItems.size == 0) {
      const idx = await this.getIndex(denops);
      items = [this.items[idx]];
    } else {
      items = [...this.selectedItems].map((i) => this.items[i]);
    }

    return items.filter((item) => item);
  }

  actions: UiActions<Params> = {
    collapseItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const startIndex = await this.getIndex(args.denops);
      const closeItem = this.items[startIndex];

      if (!(closeItem.action as ActionData).isDirectory) {
        return ActionFlags.None;
      }

      closeItem.__expanded = false;

      const endIndex = startIndex + this.items.slice(startIndex + 1).findIndex(
        (item: DduItem) => item.__level <= closeItem.__level,
      );

      this.items = this.items.slice(0, startIndex + 1).concat(
        this.items.slice(endIndex + 1),
      );
      this.selectedItems.clear();

      return ActionFlags.Redraw;
    },
    expandItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const idx = await this.getIndex(args.denops);
      const item = this.items[idx];

      if (item.__expanded) {
        return ActionFlags.None;
      }

      await args.denops.call(
        "ddu#expand_item",
        args.options.name,
        item,
      );

      item.__expanded = true;

      return ActionFlags.None;
    },
    getItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const idx = await this.getIndex(args.denops);
      const item = this.items[idx];
      const bufnr = this.buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_filer_item", item);

      return ActionFlags.None;
    },
    itemAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const params = args.actionParams as DoActionParams;
      const items = params.items ?? await this.getItems(args.denops);
      if (items.length == 0) {
        return ActionFlags.None;
      }

      await args.denops.call(
        "ddu#item_action",
        args.options.name,
        params.name ?? "default",
        items,
        params.params ?? {},
      );

      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    preview: async (_: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      return ActionFlags.Persist;
    },
    quit: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.quit({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
      });
      await args.denops.call("ddu#pop", args.options.name);
      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    refreshItems: async (_: {
      denops: Denops;
    }) => {
      return ActionFlags.RefreshItems;
    },
    updateOptions: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      await args.denops.call("ddu#redraw", args.options.name, {
        updateOptions: args.actionParams,
      });
      return ActionFlags.None;
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      if (this.items.length == 0) {
        return ActionFlags.None;
      }

      const idx = await this.getIndex(args.denops);
      if (this.selectedItems.has(idx)) {
        this.selectedItems.delete(idx);
      } else {
        this.selectedItems.add(idx);
      }

      return ActionFlags.Redraw;
    },
  };

  params(): Params {
    return {
      collapsedIcon: "+",
      expandedIcon: "-",
      highlights: {},
      split: "horizontal",
      splitDirection: "botright",
      winCol: 0,
      winHeight: 20,
      winRow: 0,
      winWidth: 0,
    };
  }

  private async initBuffer(
    denops: Denops,
    bufferName: string,
  ): Promise<number> {
    const bufnr = await fn.bufadd(denops, bufferName);
    await fn.bufload(denops, bufnr);
    return bufnr;
  }

  private async initOptions(
    denops: Denops,
    options: DduOptions,
    bufnr: number,
  ): Promise<void> {
    const winid = await fn.bufwinid(denops, bufnr);

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddu_ui_name", options.name);

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);

      await fn.setbufvar(denops, bufnr, "&bufhidden", "unload");
      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddu-filer");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);
    });
  }

  private async setDefaultParams(denops: Denops, uiParams: Params) {
    if (uiParams.winRow == 0) {
      uiParams.winRow = Math.trunc(
        (await denops.call("eval", "&lines") as number) / 2 - 10,
      );
    }
    if (uiParams.winCol == 0) {
      uiParams.winCol = Math.trunc(
        (await op.columns.getGlobal(denops)) / 4,
      );
    }
    if (uiParams.winWidth == 0) {
      uiParams.winWidth = Math.trunc((await op.columns.getGlobal(denops)) / 2);
    }
  }

  private async getIndex(
    denops: Denops,
  ): Promise<number> {
    return (await fn.line(denops, ".")) - 1;
  }

  private getSortedItems(
    items: DduItem[],
  ): DduItem[] {
    const sourceItems: Record<number, DduItem[]> = {};
    let sourceIndexes: number[] = [];
    for (const item of items) {
      if (!sourceItems[item.__sourceIndex]) {
        sourceItems[item.__sourceIndex] = [];
      }
      sourceItems[item.__sourceIndex].push(item);
      sourceIndexes.push(item.__sourceIndex);
    }

    // Uniq
    sourceIndexes = [...new Set(sourceIndexes)];

    let ret: DduItem[] = [];
    for (const index of sourceIndexes) {
      const sortedSourceItems = sourceItems[index].sort((a, b) => {
        const nameA = (a.action as ActionData).path ?? a.word;
        const nameB = (b.action as ActionData).path ?? b.word;
        return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
      });
      const dirs = sortedSourceItems.filter(
        (item) => (item.action as ActionData)?.isDirectory,
      );
      const files = sortedSourceItems.filter(
        (item) => !(item.action as ActionData)?.isDirectory,
      );
      ret = ret.concat(dirs);
      ret = ret.concat(files);
    }
    return ret;
  }
}
