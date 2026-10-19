'use strict';

// Patches applied to the vendored Fluent web-components bundle.
//
// `@fluentui/web-components@3.1.3` (the newest release) ships a prebuilt bundle
// that inlines `@microsoft/fast-element@3.0.3`. In that version
// `ElementController.forCustomElement` subscribes two anonymous handlers per
// element instance to its (shared, never-collected) element definition and
// never unsubscribes them, so every Fluent element ever created stays reachable
// for the life of the page. The shared UI rebuilds Fluent controls whenever a
// stats frame changes what a view shows, which made the desktop renderer grow
// by megabytes per minute (hundreds of detached `fluent-radio`/`fluent-button`
// instances in a heap snapshot after a few minutes against a live Hub).
//
// fast-element 3.0.4 fixed it upstream ("a subscriber was created per element
// instead of per definition"): it only subscribes while the definition's
// template is still pending, and the subscriber removes itself once it fires.
// This patch ports exactly that behaviour onto the minified bundle. Each patch
// asserts that it matched once, so a bundle update that changes the code shape
// fails `npm run update:fluent-assets` loudly instead of silently shipping the
// leak again; a bundle that already contains the fix is left alone.

const PATCHES = Object.freeze([
  {
    id: 'fast-element-3.0.4-controller-subscriber-leak',
    leaking: 'return m.getNotifier(n).subscribe({handleChange:()=>{Ge.forCustomElement(e,!0),e.$fastController.connect()}},"template"),m.getNotifier(n).subscribe({handleChange:()=>{Ge.forCustomElement(e,!0),e.$fastController.connect()}},"shadowOptions"),e.$fastController=new Fs(e,n)',
    fixed: 'if(n.template===void 0){const tmNotifier=m.getNotifier(n),tmSubscriber={handleChange:()=>{tmNotifier.unsubscribe(tmSubscriber,"template"),Ge.forCustomElement(e,!0),e.isConnected&&e.$fastController.connect()}};tmNotifier.subscribe(tmSubscriber,"template")}return e.$fastController=new Fs(e,n)'
  }
]);

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function patchFluentBundle(source) {
  let text = String(source);
  const applied = [];
  for (const patch of PATCHES) {
    if (countOccurrences(text, patch.fixed) === 1) continue;
    const matches = countOccurrences(text, patch.leaking);
    if (matches !== 1) {
      throw new Error(`Fluent bundle patch ${patch.id} expected one match, found ${matches}; re-derive it for this bundle version`);
    }
    text = text.replace(patch.leaking, patch.fixed);
    applied.push(patch.id);
  }
  return { text, applied };
}

module.exports = { PATCHES, patchFluentBundle };
