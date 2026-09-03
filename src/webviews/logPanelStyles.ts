/**
 * The Git tool window's stylesheet.
 *
 * Its own file because it is a plain `String.raw` constant with no
 * interpolation, and because the panel it belonged to had grown past 4,500
 * lines with the host logic, the styles and the Webview script all in one
 * place.
 */
export const logStyles = String.raw`
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body, #app { width: 100%; height: 100%; margin: 0; padding: 0; }
  body { overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-panel-background, var(--vscode-editor-background)); font: var(--vscode-font-size, 13px) var(--vscode-font-family); }
  button, select, input, textarea { color: inherit; font: inherit; }
  button { border: 0; background: transparent; cursor: pointer; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .root { height: 100%; display: grid; grid-template-rows: 34px 38px minmax(0, 1fr); }
  .tool-tabs { display: flex; align-items: end; gap: 2px; padding: 0 8px; overflow-x: auto; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-panel-background); }
  .tool-tab { height: 33px; padding: 0 12px; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); }
  .tool-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .toolbar select, .toolbar input { height: 26px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .toolbar select { max-width: 220px; padding: 2px 5px; }
  .search { width: min(330px, 32vw); padding: 3px 7px; }
  .issue-link { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .issue-link:hover { text-decoration: underline; }
  /* A whole-history search is a different state from filtering the window, and
     has to look like one. */
  .commit-search.deep-active { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 12%, var(--vscode-input-background)); }
  .icon-button { min-width: 27px; height: 27px; padding: 0 7px; border-radius: 3px; }
  .icon-button:hover, .action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .spacer { flex: 1; }
  .branch-label { color: var(--vscode-descriptionForeground); }
  .workspace { --branch-width: 185px; --details-width: 300px; min-width: 0; min-height: 0; display: grid; grid-template-columns: var(--branch-width) 9px minmax(260px, 1fr) 9px var(--details-width); overflow: hidden; }
  .workspace.compact { grid-template-columns: minmax(260px, 1fr) 9px var(--details-width); }
  .workspace.compact > .branches, .workspace.compact > .column-splitter[data-side="branch"] { display: none; }
  .workspace.tiny { grid-template-columns: minmax(260px, 1fr); }
  .workspace.tiny > .column-splitter[data-side="details"], .workspace.tiny > .details { display: none; }
  .pane { min-width: 0; min-height: 0; overflow: auto; }
  .column-splitter { position: relative; min-width: 9px; cursor: col-resize; background: transparent; outline: none; touch-action: none; }
  .column-splitter::before { content: ''; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px; background: var(--vscode-panel-border); }
  .column-splitter:hover::before, .column-splitter.dragging::before, .column-splitter:focus-visible::before { left: 3px; width: 2px; background: var(--vscode-focusBorder); }
  .branches { overscroll-behavior: contain; scrollbar-gutter: stable; }
  .pane-title { position: sticky; top: 0; z-index: 2; height: 28px; display: flex; align-items: center; padding: 0 9px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .branch-section { padding: 5px 0 2px; }
  .pane-action { width: 21px; height: 21px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 3px; color: var(--vscode-icon-foreground); font-size: 12px; font-weight: 400; }
  .pane-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .pane-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .branch-star { flex: none; margin-left: 4px; padding: 0 2px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .branch-star.on { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow, #d99b42)); }
  .branch-row:not(:hover) .branch-star:not(.on) { visibility: hidden; }
  .branch-filter { width: calc(100% - 12px); height: 23px; margin: 5px 6px 3px; padding: 0 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font-size: 11px; }
  .section-title { height: 23px; display: flex; align-items: center; padding: 0 9px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .branch-row { height: 25px; width: 100%; display: flex; align-items: center; gap: 6px; padding: 0 9px 0 16px; text-align: left; white-space: nowrap; }
  .branch-row:hover { background: var(--vscode-list-hoverBackground); }
  .branch-row.active, .branch-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .branch-row.current::before { content: '✓'; width: 11px; margin-left: -11px; color: var(--vscode-charts-green); }
  /* IDEA's incoming/outgoing markers, right-aligned so branch names stay scannable. */
  .branch-track { margin-left: auto; display: inline-flex; gap: 5px; font-size: 11px; font-variant-numeric: tabular-nums; }
  .track-in { color: var(--vscode-charts-blue, #3794ff); }
  .track-out { color: var(--vscode-charts-green, #73c991); }
  .track-gone { color: var(--vscode-descriptionForeground); font-style: italic; }
  .branch-row.active .track-in, .branch-row.selected .track-in,
  .branch-row.active .track-out, .branch-row.selected .track-out { color: inherit; }
  .branch-name { overflow: hidden; text-overflow: ellipsis; }
  .commit-pane { overflow: hidden; display: grid; grid-template-rows: 35px minmax(0, 1fr); }
  .commit-filters { min-width: 0; display: flex; align-items: center; gap: 2px; padding: 4px 5px; overflow: visible; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .commit-search { width: 150px; min-width: 82px; max-width: 180px; flex: 0 1 150px; height: 27px; padding: 3px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .filter-button { height: 27px; flex: none; padding: 0 7px; border-radius: 3px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .filter-button:hover, .filter-button.active { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .sort-button { min-width: 31px; padding: 0 6px; font-size: 15px; }
  .filter-popover { position: fixed; z-index: 1000; width: min(360px, calc(100vw - 12px)); padding: 8px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); box-shadow: 0 8px 24px rgba(0,0,0,.38); }
  .filter-popover-title { margin: 0 0 6px; color: var(--vscode-descriptionForeground); }
  .filter-popover input { width: 100%; height: 28px; padding: 3px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .filter-popover-actions { display: flex; justify-content: flex-end; gap: 5px; margin-top: 8px; }
  .commit-scroll { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .table-head, .commit-row { display: grid; grid-template-columns: minmax(300px, 1fr) 145px 135px 82px; align-items: center; }
  .table-head { position: sticky; top: 0; z-index: 3; height: 27px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); color: var(--vscode-descriptionForeground); font-size: 11px; }
  .table-head > span { padding: 0 7px; border-right: 1px solid var(--vscode-panel-border); }
  .commit-list { min-height: 0; overflow: visible; }
  .load-more { display: block; min-height: 30px; margin: 8px auto 14px; padding: 4px 12px; border-radius: 3px; color: var(--vscode-textLink-foreground); background: var(--vscode-button-secondaryBackground); }
  .load-more:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .commit-row { min-height: 27px; cursor: pointer; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .commit-row:focus-visible, .file-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .commit-row > div { min-width: 0; padding: 0 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subject-cell { height: 27px; display: flex; align-items: center; gap: 5px; padding-left: 0 !important; }
  canvas { flex: none; width: 72px; height: 27px; }
  canvas.graph-interactive { cursor: pointer; }
  .refs { display: flex; gap: 3px; flex: none; max-width: 190px; overflow: hidden; }
  .ref { display: inline-flex; align-items: center; gap: 3px; max-width: 132px; padding: 1px 6px 1px 4px; border-radius: 8px; background: color-mix(in srgb, var(--vscode-charts-blue) 24%, transparent); color: var(--vscode-foreground); font-size: 10px; }
  .ref-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ref-icon { display: flex; flex: none; }
  .ref-icon svg { width: 10px; height: 10px; }
  .ref-remote { background: color-mix(in srgb, var(--vscode-charts-purple) 24%, transparent); }
  .ref-tag { background: color-mix(in srgb, var(--vscode-charts-yellow) 30%, transparent); }
  .ref-head { box-shadow: inset 0 0 0 1px var(--vscode-charts-green); font-weight: 600; }
  .detail-refs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
  .detail-refs .ref { max-width: none; padding: 2px 8px 2px 6px; font-size: 11px; }
  .detail-refs .ref-icon svg { width: 11px; height: 11px; }
  .subject { overflow: hidden; text-overflow: ellipsis; }
  .muted { color: var(--vscode-descriptionForeground); }
  .details { --message-height: 160px; display: grid; grid-template-rows: minmax(70px, 1fr) 9px var(--message-height); overflow: hidden; }
  .commit-details { min-height: 0; padding: 10px; overflow: auto; overscroll-behavior: contain; }
  .detail-subject { font-size: 14px; font-weight: 600; margin-bottom: 7px; white-space: pre-wrap; }
  .detail-multi { margin: 4px 0 8px; overflow-y: auto; }
  .multi-commit { padding: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .multi-hint { font-size: 11px; }
  .detail-meta { display: grid; grid-template-columns: 54px 1fr; gap: 4px 6px; color: var(--vscode-descriptionForeground); }
  .detail-meta strong { color: var(--vscode-foreground); font-weight: 400; overflow-wrap: anywhere; }
  .detail-body { margin-top: 9px; white-space: pre-wrap; line-height: 1.45; }
  .reword-editor { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .reword-editor textarea { width: 100%; min-height: 96px; padding: 6px 8px; resize: vertical; border: 1px solid var(--vscode-focusBorder); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); line-height: 1.45; }
  .reword-actions { display: flex; gap: 6px; align-items: center; }
  .reword-actions .hint { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .primary-action { height: 25px; padding: 0 9px; border-radius: 3px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .action { height: 25px; padding: 0 7px; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .files { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .detail-splitter { position: relative; min-height: 9px; cursor: row-resize; background: transparent; outline: none; touch-action: none; }
  .detail-splitter::before { content: ''; position: absolute; left: 0; right: 0; top: 4px; height: 1px; background: var(--vscode-panel-border); }
  .detail-splitter:hover::before, .detail-splitter.dragging::before, .detail-splitter:focus-visible::before { height: 2px; background: var(--vscode-focusBorder); }
  .file-tree-root { min-width: max-content; padding-bottom: 8px; }
  .tree-row { height: 25px; display: flex; align-items: center; gap: 5px; padding-right: 7px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .tree-row:hover { background: var(--vscode-list-hoverBackground); }
  .tree-twisty { width: 12px; text-align: center; }
  .tree-folder { color: var(--vscode-foreground); }
  .tree-count { margin-left: 2px; font-size: 11px; }
  .file-row { min-height: 25px; display: grid; grid-template-columns: 23px minmax(0, 1fr); align-items: center; padding: 0 7px; cursor: pointer; }
  .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .file-status { font-weight: 700; }
  .file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .context-menu { position: fixed; z-index: 1000; min-width: 230px; max-width: min(360px, calc(100vw - 12px)); max-height: calc(100vh - 12px); overflow: auto; padding: 5px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); box-shadow: 0 8px 24px rgba(0,0,0,.38); }
  .context-menu-item { width: 100%; min-height: 28px; display: flex; align-items: center; gap: 8px; padding: 4px 9px; border-radius: 4px; text-align: left; white-space: nowrap; }
  .context-menu-item:hover, .context-menu-item:focus-visible { outline: 0; background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); }
  .context-menu-item:disabled { opacity: .45; pointer-events: none; }
  .context-menu-icon { width: 17px; text-align: center; color: var(--vscode-descriptionForeground); }
  .context-menu-separator { height: 1px; margin: 5px 3px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
  .context-menu-heading { padding: 6px 9px 3px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .empty { padding: 28px 14px; text-align: center; color: var(--vscode-descriptionForeground); }
  .error { margin: 10px; padding: 8px; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); }
  .console-toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .console-toolbar select { height: 26px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  .console { min-height: 0; overflow: auto; padding: 7px 10px 28px; background: var(--vscode-terminal-background, var(--vscode-editor-background)); color: var(--vscode-terminal-foreground, var(--vscode-foreground)); font: 12px/1.45 var(--vscode-editor-font-family); white-space: pre-wrap; overflow-wrap: anywhere; }
  .trace { margin-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); }
  .trace summary { min-height: 28px; display: flex; align-items: center; gap: 7px; cursor: pointer; list-style: none; }
  .trace summary::-webkit-details-marker { display: none; }
  .trace summary::before { content: '›'; width: 10px; color: var(--vscode-descriptionForeground); }
  .trace[open] summary::before { content: '⌄'; }
  .trace-output { padding: 0 0 8px 17px; }
  .trace-status-ok { color: var(--vscode-testing-iconPassed); }
  .trace-status-error { color: var(--vscode-testing-iconFailed); }
  .trace-background { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 10px; }
  .trace-command { color: var(--vscode-terminal-ansiCyan); }
  .trace-cwd, .trace-time { color: var(--vscode-descriptionForeground); }
  .trace-error { color: var(--vscode-terminal-ansiRed); }
  .count { display: inline-grid; place-items: center; min-width: 16px; height: 16px; margin-left: 5px; padding: 0 4px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; }
  .changes-toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
  .changes-toolbar select { max-width: 240px; height: 26px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .changes-workspace { --commit-width: 340px; min-height: 0; display: grid; grid-template-columns: minmax(220px, 1fr) 9px var(--commit-width); overflow: hidden; }
  .changes-list { min-width: 0; min-height: 0; overflow: auto; }
  .changes-splitter { position: relative; min-width: 9px; cursor: col-resize; outline: none; touch-action: none; }
  .changes-splitter::before { content: ''; position: absolute; inset: 0 auto 0 4px; width: 1px; background: var(--vscode-panel-border); }
  .changes-splitter:hover::before, .changes-splitter:focus-visible::before, .changes-splitter.dragging::before { left: 3px; width: 2px; background: var(--vscode-focusBorder); }
  .operation { margin: 6px; padding: 7px 8px; border-radius: 3px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  .operation-actions { margin-top: 6px; display: flex; gap: 5px; }
  .small-button { min-height: 24px; padding: 3px 7px; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .change-group { margin-top: 2px; }
  .group-header { height: 27px; display: flex; align-items: center; gap: 5px; padding: 0 8px; font-weight: 600; user-select: none; }
  .group-header:hover { background: var(--vscode-list-hoverBackground); }
  .group-header:focus-visible, .change-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .twisty { width: 12px; color: var(--vscode-descriptionForeground); }
  .active-dot { color: var(--vscode-charts-blue); }
  .changelist-actions { display: flex; align-items: center; opacity: .75; }
  .group-header:hover .changelist-actions, .group-header:focus-within .changelist-actions { opacity: 1; }
  .changelist-description { padding: 1px 10px 5px 48px; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: pre-wrap; }
  .select-all { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .change-item { min-width: 0; }
  .change-row { min-height: 26px; display: grid; grid-template-columns: 20px 24px 20px minmax(0, 1fr) auto; align-items: center; padding: 0 6px 0 8px; }
  .change-row:hover, .change-row:focus-within { background: var(--vscode-list-hoverBackground); }
  .change-row input { margin: 0; }
  .hunk-toggle { width: 20px; height: 24px; padding: 0; color: var(--vscode-descriptionForeground); background: transparent; }
  .hunk-toggle:disabled { visibility: hidden; }
  .change-status { width: 18px; font-weight: 700; text-align: center; }
  .status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .status-A { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-gitDecoration-untrackedResourceForeground)); }
  .status-q { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .status-R, .status-C { color: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-gitDecoration-modifiedResourceForeground)); }
  .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .status-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .status-bang { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
  .change-file { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
  /* The file name inherits its row's status colour, the way IDEA colours the
     names themselves; directory and stage marks keep their own muted colour. */
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .render-error { max-width: 560px; margin: 40px auto; padding: 0 16px; display: grid; gap: 10px; }
  .render-error-title { font-weight: 600; font-size: 14px; }
  .render-error-detail { margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-errorForeground); background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  .render-error-actions { display: flex; gap: 8px; }
  .directory, .stage-mark { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .partial-mark { color: var(--vscode-charts-purple, var(--vscode-descriptionForeground)); border-color: currentColor; }
  .stage-mark { margin-left: auto; padding: 0 4px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  .worktree-mark { border-style: dashed; }
  .row-actions { display: none; align-items: center; }
  .change-row:hover .row-actions, .change-row:focus-within .row-actions { display: flex; }
  .row-action { width: 24px; height: 24px; border-radius: 2px; }
  .state-diff { width: 22px; font-size: 10px; font-weight: 700; color: var(--vscode-textLink-foreground); }
  .row-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .change-hunks { margin: 0 8px 7px 28px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden; background: var(--vscode-editor-background); }
  .hunk-group + .hunk-group { border-top: 1px solid var(--vscode-panel-border); }
  .hunk-group-title { padding: 5px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); }
  .hunk-block + .hunk-block { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent); }
  .hunk-header { min-height: 29px; display: flex; align-items: center; gap: 6px; padding: 3px 7px; }
  .hunk-header code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
  /* Which Changelist a change belongs to, read at a glance beside its header. */
  /* The list name matters more here than the @@ header beside it, so the
     header is what gives way when the row is narrow. */
  .hunk-owner { flex: 0 0 auto; max-width: 14em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border-radius: 9px; font-size: 11px;
    color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .hunk-preview { max-height: 220px; margin: 0; padding: 5px 8px 8px; overflow: auto; font: 11px/1.35 var(--vscode-editor-font-family); }
  .hunk-add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .hunk-delete { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .hunk-context { color: var(--vscode-editor-foreground); }
  .hunk-empty { padding: 8px; color: var(--vscode-descriptionForeground); }
  .commit-form { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto auto minmax(60px, 1fr) auto auto; gap: 0; background: var(--vscode-panel-background, var(--vscode-editor-background)); }
  .commit-form-title { height: 28px; display: flex; align-items: center; padding: 0 9px; font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  /* Stacked, not side by side: the commit column is ~340px, and next to the
     select the help text wrapped into a six-line sliver. */
  .commit-mode-row { display: grid; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .commit-mode-help { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.25; }
  /* A native select and native checkboxes were the only browser-default controls
     left in the panel, so the commit form read as a web form dropped into the
     editor. Both are drawn from the theme instead; the select's own arrow is
     dropped for a chevron on the shell, because a CSP with no img-src cannot
     load a background image for it. */
  .select-shell { position: relative; display: flex; min-width: 0; }
  .select-shell::after { content: ''; position: absolute; right: 9px; top: 50%; width: 5px; height: 5px; margin-top: -4px; border-right: 1px solid var(--vscode-dropdown-foreground, var(--vscode-foreground)); border-bottom: 1px solid var(--vscode-dropdown-foreground, var(--vscode-foreground)); transform: rotate(45deg); opacity: .7; pointer-events: none; }
  .select-shell select { width: 100%; min-width: 0; height: 26px; padding: 0 24px 0 8px; appearance: none; font: inherit; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; cursor: pointer; text-overflow: ellipsis; }
  .select-shell select:hover { border-color: var(--vscode-focusBorder); }
  .select-shell select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input[type="checkbox"] { appearance: none; flex: none; width: 15px; height: 15px; margin: 0; position: relative; border: 1px solid var(--vscode-checkbox-border, var(--vscode-dropdown-border, var(--vscode-panel-border))); border-radius: 3px; background: var(--vscode-checkbox-background, var(--vscode-input-background)); cursor: pointer; }
  input[type="checkbox"]:hover { border-color: var(--vscode-focusBorder); }
  input[type="checkbox"]:checked { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid var(--vscode-button-foreground); border-width: 0 1.6px 1.6px 0; transform: rotate(45deg); }
  input[type="checkbox"]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .commit-message { width: calc(100% - 14px); min-height: 60px; margin: 7px; padding: 7px 8px; resize: none; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .commit-message::placeholder { color: var(--vscode-input-placeholderForeground); }
  .commit-options { min-height: 32px; display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 4px 9px 7px; color: var(--vscode-foreground); }
  .commit-options label { display: flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer; user-select: none; }
  .commit-options .author-toggle { height: 22px; padding: 0 7px; border-radius: 3px; background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
  .commit-options .author-toggle.active { border-color: var(--vscode-focusBorder); }
  .commit-author-row { display: flex; align-items: center; gap: 8px; padding: 0 9px 7px; }
  .commit-author-row[hidden] { display: none; }
  .commit-author-row input { flex: 1; min-width: 0; height: 24px; padding: 0 7px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .commit-author-row input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .commit-options #selected-count { color: var(--vscode-descriptionForeground); }
  .commit-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(100px, auto); gap: 4px; padding: 0 7px 7px; }
  .primary { min-height: 29px; padding: 4px 10px; border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .primary:disabled, .secondary:disabled, .action:disabled { opacity: .45; cursor: default; }
  .secondary { min-height: 29px; padding: 4px 8px; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .shelf-pane { min-height: 0; overflow: auto; padding: 3px 0 16px; }
  .shelf-row { margin: 2px 6px; padding: 7px 9px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 8px; border-radius: 3px; }
  .shelf-row:hover { background: var(--vscode-list-hoverBackground); }
  .shelf-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shelf-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .shelf-actions { grid-row: 1 / 3; grid-column: 2; display: flex; align-items: center; gap: 4px; }
  @media (max-width: 1000px) {
    .table-head, .commit-row { grid-template-columns: minmax(210px, 1fr) 82px; }
    .table-head > :nth-child(3), .table-head > :nth-child(4), .commit-row > :nth-child(3), .commit-row > :nth-child(4) { display: none; }
    .commit-details { padding: 8px; }
    .detail-meta { grid-template-columns: 44px 1fr; font-size: 11px; }
  }
  @media (max-width: 760px) { .filter-button .filter-value { display: none; } }
  @media (max-width: 650px) { .toolbar, .changes-toolbar { overflow-x: auto; } }
  @media (max-width: 760px) { .commit-options { gap: 9px; font-size: 11px; } }
  @media (max-width: 520px) {
    .changes-workspace { --commit-height: 220px; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(150px, 1fr) 9px var(--commit-height); }
    .changes-splitter { min-height: 9px; cursor: row-resize; }
    .changes-splitter::before { inset: 4px 0 auto; width: auto; height: 1px; }
    .changes-splitter:hover::before, .changes-splitter:focus-visible::before, .changes-splitter.dragging::before { top: 3px; left: 0; width: auto; height: 2px; }
  }
`;
