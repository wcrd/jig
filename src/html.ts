// HTML templates that escape what goes into them. Text interpolated into an
// `html` template is escaped; other templates, lists of them and `raw` markup
// go in as they are. Markup reaches the page through `setHtml`.

import { escapeHtml } from "./format";

/** Markup that's safe to put on the page as it is. */
export class Html {
  constructor(readonly markup: string) {}

  toString(): string {
    return this.markup;
  }
}

/** null, undefined and false render as nothing, so `${cond && html`…`}` works. */
type Value = Html | string | number | null | undefined | false | Value[];

function render(value: Value): string {
  if (value instanceof Html) return value.markup;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let markup = strings[0];
  values.forEach((value, i) => {
    markup += render(value) + strings[i + 1];
  });
  return new Html(markup);
}

/**
 * Markup from code that escapes its own text, such as the string-building
 * helpers in other modules. Never pass it text from a repository.
 */
export function raw(markup: string): Html {
  return new Html(markup);
}

/** Replaces an element's contents, like `replaceChildren` but with markup. */
export function setHtml(el: Element, ...content: Value[]) {
  el.innerHTML = render(content);
}
