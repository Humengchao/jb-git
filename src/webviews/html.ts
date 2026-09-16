import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export function webviewDocument(title: string, styles: string, script: string): string {
  const nonce = randomBytes(18).toString("base64");
  return `<!doctype html>
<html lang="${escapeHtml(vscode.env.language || "en")}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <div id="app" role="region" aria-label="${escapeHtml(title)}"></div>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

/** JB Git's own editors that are currently open, so they can share one group. */
const liveToolPanels = new Set<vscode.WebviewPanel>();

/**
 * Where JB Git's own editors open.
 *
 * The merge editor, the rebase sequence editor and branch comparison are
 * IDEA's dialogs, not files. Opening them in the active group interleaves them
 * with the user's source tabs — a conflict editor lands between two code files
 * and sits there for the rest of the session — so they go beside the code
 * instead. `active` puts them back among the file tabs for anyone who wants
 * that.
 *
 * Beside is relative to the focused group, so a second editor opened while the
 * first one has focus would push a third column onto the screen. Reusing the
 * column a live JB Git editor already occupies keeps them all together.
 */
export function toolEditorColumn(): vscode.ViewColumn {
  if (vscode.workspace.getConfiguration("jbGit").get<string>("toolEditorLocation", "beside") === "active") {
    return vscode.ViewColumn.Active;
  }
  for (const panel of liveToolPanels) {
    if (panel.viewColumn !== undefined) return panel.viewColumn;
  }
  return vscode.ViewColumn.Beside;
}

/** Lets the next JB Git editor find this one's group; forgotten when it closes. */
export function registerToolPanel(panel: vscode.WebviewPanel): void {
  liveToolPanels.add(panel);
  panel.onDidDispose(() => liveToolPanels.delete(panel));
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
