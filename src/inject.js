// HTML injection shared by static and proxy modes.

export const OVERLAY_TAG = '<script src="/__wed/overlay.js" data-wed-overlay defer></script>';

/** Insert the overlay script before </body>, or append it when there is no </body>. */
export function injectOverlay(html) {
  if (html.includes('data-wed-overlay')) return html;
  const i = html.toLowerCase().lastIndexOf('</body>');
  if (i === -1) return html + '\n' + OVERLAY_TAG;
  return html.slice(0, i) + OVERLAY_TAG + html.slice(i);
}

export function looksLikeHtml(contentType) {
  return /text\/html/i.test(contentType || '');
}
