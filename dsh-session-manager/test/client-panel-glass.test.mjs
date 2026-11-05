/**
 * Remote-desktop flicker: with the frosted-glass setting on, the full-window
 * session manager page seemed to vanish and reappear as the pointer moved over
 * the session list. This was seen through UU remote desktop and confirmed by
 * turning frosted glass off. Chromium can drop a backdrop-filter surface from
 * a frame while that surface's own content repaints. The drop is invisible on
 * the local monitor, but screen capture records it.
 *
 * The page therefore carries its blur on an empty `.sm-ocGlass` layer behind
 * the content. Hover, scrolling and list updates repaint sibling layers above
 * it, so the blurred surface itself never repaints. These tests pin that shape
 * and that the look (fill, opacity, blur) is unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mountClient, nodes } from "./helpers/client-harness.mjs";

const hasClass = (node, name) => String(node?.props?.className ?? "").split(/\s+/).includes(name);
const css = app => app.styleTags.map(tag => tag.textContent ?? "").join("\n");
const childrenOf = node => [node?.props?.children].flat(Infinity).filter(child => child !== null && child !== undefined && child !== false);

function pageSurface(app) {
  const modal = app.tree[0].props.children[0];
  return modal.props.children[0].props.children[0];
}

test("the page's frosted glass is an empty first layer, not the content surface", () => {
  const app = mountClient({ sessions: [{ id: "s1", displayTitle: "Alpha", updatedAt: 1 }], current: "s1", language: "zh" });
  const surface = pageSurface(app);
  assert.ok(hasClass(surface, "sm-ocPanel"), "expected the page surface");
  const [first] = childrenOf(surface);
  assert.ok(hasClass(first, "sm-ocGlass"), "the first child must be the glass layer");
  assert.equal(first.props["aria-hidden"], "true", "the glass layer is decorative");
  assert.equal(childrenOf(first).length, 0, "the glass layer must stay content-free, or hover repaints reach the blurred surface again");
  assert.equal(nodes(app.tree, node => hasClass(node, "sm-ocGlass")).length, 1, "exactly one glass layer");
});

test("blur and fill move to the glass layer; dialogs keep theirs", () => {
  const app = mountClient({ sessions: [], language: "zh" });
  const sheet = css(app);
  const translucent = /(html\[data-sm-translucent\] [^{}]+)\{[^}]*backdrop-filter:blur\(var\(--sm-glass-blur,12px\)\)/.exec(sheet);
  assert.ok(translucent, "the frosted-glass rule must exist");
  const selectors = translucent[1].split(",").map(s => s.trim());
  assert.ok(selectors.includes("html[data-sm-translucent] .sm-ocGlass"), "the glass layer gets the blur");
  assert.ok(selectors.includes("html[data-sm-translucent] .sm-nativeDialog:not(.sm-ocPanel)"), "the page surface (also .sm-nativeDialog) is excluded");
  assert.ok(selectors.includes("html[data-sm-translucent] .sm-panelDialog:not(.sm-ocPanel)"), "the page surface (also .sm-panelDialog) is excluded");
  for (const dialog of [".sm-presetMenu", ".sm-migrateDialog"]) {
    assert.ok(selectors.includes("html[data-sm-translucent] " + dialog), dialog + " keeps its blur");
  }
  // The settings card keeps its blur on DSH's settings page, but inside the
  // session manager page it sits on the glass layer and must not add a blur
  // surface of its own (not even blur(0px), which still creates one).
  assert.ok(selectors.includes("html[data-sm-translucent] .sm-settingsCard:not(.sm-ocPanel *)"), "the settings card is excluded inside the page");
  assert.ok(!/backdrop-filter:blur\(0px\)/.test(sheet), "no zero-blur surfaces inside the page");

  assert.match(sheet, /\.sm-panelDialog\.sm-ocPanel\{background:transparent!important\}/, "the page surface paints no fill of its own");
  // Anchor at a rule boundary: the frosted-glass selector list also ends in ".sm-ocGlass{".
  const glass = /(?:^|\})\.sm-ocGlass\{([^}]*)\}/m.exec(sheet);
  assert.ok(glass, "the glass rule must exist");
  for (const declaration of ["position:absolute", "inset:0", "z-index:-1", "pointer-events:none", "background:var(--sm-dialog-fill)", "border-radius:inherit"]) {
    assert.ok(glass[1].includes(declaration), "glass layer must declare " + declaration);
  }
  // The glass layer inherits the page's --sm-dialog-fill rather than defining
  // its own, so the opacity slider keeps a single source of truth.
  assert.ok(!/--sm-dialog-(surface|fill|opacity)\s*:/.test(glass[1]), "the glass layer must not redefine the fill");
});
