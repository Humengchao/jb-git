import * as vscode from "vscode";

export class ErrorNode extends vscode.TreeItem {
  public constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(message || "Unable to load Git data", vscode.TreeItemCollapsibleState.None);
    this.tooltip = message;
    this.contextValue = "jbGit.error";
    this.iconPath = new vscode.ThemeIcon("error");
  }
}
