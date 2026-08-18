import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export function webviewDocument(webview: vscode.Webview, title: string, styles: string, script: string): string {
  const nonce = randomBytes(18).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <div id="app" role="application" aria-label="${escapeHtml(title)}"></div>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
