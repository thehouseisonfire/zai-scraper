declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  type TurndownPlugin = Parameters<TurndownService["use"]>[0];

  interface TurndownGfmPlugin {
    gfm: TurndownPlugin;
    tables: TurndownPlugin;
    strikethrough: TurndownPlugin;
    taskListItems: TurndownPlugin;
  }

  const plugin: TurndownGfmPlugin;

  export default plugin;
}
