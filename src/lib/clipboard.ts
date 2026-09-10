/**
 * Copy text to the clipboard, with a legacy fallback.
 *
 * `navigator.clipboard.writeText` is only available in secure contexts
 * (HTTPS/localhost). The Gateway is routinely opened over plain HTTP on a
 * LAN address, where `navigator.clipboard` is undefined and the copy
 * buttons silently fail. The `execCommand("copy")` fallback works there.
 *
 * Resolves true when the text was copied, false when the operator must copy
 * manually. Never throws. Must be called from a user gesture.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permissions denied or clipboard API unusable — try the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
