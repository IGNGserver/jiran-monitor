// Browser clipboard service shared by the HTTP transport and the facade's
// browser fallback. The async Clipboard API is unavailable on intentionally
// plain-HTTP Hub pages, so keep a user-gesture-compatible fallback for those
// deployments instead of making the copy action silently fail.

function restoreFocus(element) {
  if (!element || typeof element.focus !== 'function') return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    try { element.focus(); } catch {}
  }
}

function copyWithSelection(text) {
  if (typeof document === 'undefined'
    || typeof document.createElement !== 'function'
    || typeof document.execCommand !== 'function') return false;

  const parent = document.body || document.documentElement;
  if (!parent || typeof parent.appendChild !== 'function') return false;

  const previousFocus = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute?.('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  let copied;
  parent.appendChild(textarea);
  try {
    restoreFocus(textarea);
    textarea.select?.();
    textarea.setSelectionRange?.(0, text.length);
    copied = document.execCommand('copy') === true;
  } catch {
    copied = false;
  }

  try {
    if (typeof parent.removeChild === 'function') parent.removeChild(textarea);
    else textarea.remove?.();
  } catch {
    textarea.remove?.();
  }
  restoreFocus(previousFocus);
  return copied;
}

export async function copyTextWithFallback(value) {
  const text = String(value ?? '');
  const insecureContext = typeof window !== 'undefined' && window.isSecureContext === false;
  const writeText = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText : null;

  if (!insecureContext && typeof writeText === 'function') {
    try {
      await writeText.call(navigator.clipboard, text);
      return true;
    } catch {
      // Permission denial, browser policy, and focus errors can all be handled
      // by the same selection fallback below.
    }
  }

  return copyWithSelection(text);
}
