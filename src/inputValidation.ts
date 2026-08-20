/** Fast, inline validation for the most common Git-name mistakes. Git remains the final authority. */
export function validateGitRefName(value: string, allowEmpty = false): string | undefined {
  const name = value.trim();
  if (!name) return allowEmpty ? undefined : "Enter a name.";
  if (name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) {
    return "This is not a valid Git ref name.";
  }
  if (name.includes("..") || name.includes("@{") || name.includes("//") || /[\x00-\x20\x7f~^:?*\[\\]/.test(name)) {
    return "Git names cannot contain spaces, control characters, '..', '@{' or ~ ^ : ? * [ \\.";
  }
  if (name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    return "Each path component must be non-empty and cannot start with '.' or end with '.lock'.";
  }
  return undefined;
}

export function validateRemoteName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter a remote name.";
  if (/\s|[\x00-\x1f\x7f~^:?*\[\\]/.test(name) || name.startsWith("-") || name.includes("..")) {
    return "Use a simple remote name without spaces or Git revision punctuation.";
  }
  return undefined;
}

export function validatePathInput(value: string, allowEmpty = false): string | undefined {
  if (!value.trim()) return allowEmpty ? undefined : "Enter a path.";
  if (/[\r\n\0]/.test(value)) return "Paths cannot contain line breaks or NUL characters.";
  return undefined;
}

export function validateSingleLine(value: string, label = "Value"): string | undefined {
  if (!value.trim()) return `Enter ${label.toLowerCase()}.`;
  if (/[\r\n\0]/.test(value)) return `${label} must be a single line.`;
  return undefined;
}
