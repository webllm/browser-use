/**
 * Functions serialized into the page for the Anthropic browser toolset.
 *
 * Playwright sends each function's source text to the page, so they must be
 * self-contained. Inner helpers use array destructuring so esbuild's keepNames
 * transform (tsx, vitest) cannot introduce a free `__name` helper.
 *
 * Element references live in a per-document registry: a WeakMap gives each
 * element a stable `ref_N` name, and WeakRefs resolve names back to elements
 * without keeping removed nodes alive or mutating the page.
 */

export type ReadPageFilter = 'default' | 'interactive' | 'all';

export interface RefRegistry {
  refs: WeakMap<Element, string>;
  elements: Map<string, WeakRef<Element>>;
}

export interface AccessibleEntry {
  depth: number;
  ref: string | null;
  description: string;
}

/** A cross-origin iframe whose content must be walked from its own frame. */
export interface FrameSlot {
  ref: string;
  depth: number;
  index: number;
}

export interface CollectAccessibleArgs {
  rootRef: string | null;
  filter: ReadPageFilter;
  depthLimit: number;
  maxEntries: number;
  nextRef: number;
  includeText: boolean;
}

export interface CollectAccessibleResult {
  entries: AccessibleEntry[];
  frames: FrameSlot[];
  newRefs: string[];
  nextRef: number;
  truncated: boolean;
  missingRoot: boolean;
}

export function createRefRegistry(): RefRegistry {
  return { refs: new WeakMap(), elements: new Map() };
}

export function resolveRegistryRef(
  registry: RefRegistry,
  ref: string
): Element | null {
  const element = registry.elements.get(ref)?.deref() ?? null;
  return element && element.isConnected ? element : null;
}

/**
 * Walk the document (open shadow roots and same-origin iframes included) and
 * describe accessible elements as `role "name" key=value`, registering a ref
 * for every described element.
 */
export function collectAccessibleEntries(
  registry: RefRegistry,
  args: CollectAccessibleArgs
): CollectAccessibleResult {
  const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'slider',
    'spinbutton',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'option',
    'listbox',
    'switch',
    'treeitem',
  ]);
  // Roles whose accessible name comes from their content, so their text
  // children would only repeat the name.
  const NAME_FROM_CONTENT = new Set([
    'button',
    'link',
    'heading',
    'option',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'switch',
    'checkbox',
    'radio',
    'cell',
    'columnheader',
    'rowheader',
  ]);
  const TAG_ROLES: Record<string, string> = {
    NAV: 'navigation',
    MAIN: 'main',
    HEADER: 'banner',
    FOOTER: 'contentinfo',
    ASIDE: 'complementary',
    FORM: 'form',
    DIALOG: 'dialog',
    TABLE: 'table',
    TR: 'row',
    TH: 'columnheader',
    TD: 'cell',
    UL: 'list',
    OL: 'list',
    LI: 'listitem',
    ARTICLE: 'article',
    DETAILS: 'group',
    FIELDSET: 'group',
    IFRAME: 'iframe',
    FRAME: 'iframe',
  };
  const SKIPPED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'HEAD',
    'META',
    'LINK',
  ]);
  const MAX_NAME = 150;
  const MAX_OPTIONS = 25;
  const entries: AccessibleEntry[] = [];
  const frames: FrameSlot[] = [];
  const newRefs: string[] = [];
  let nextRef = args.nextRef;
  let truncated = false;

  const [collapse] = [(text: string) => text.replace(/\s+/g, ' ').trim()];
  const [clip] = [
    (text: string, limit = MAX_NAME) =>
      text.length > limit ? `${text.slice(0, limit)}...` : text,
  ];
  const [quote] = [
    (text: string, limit = MAX_NAME) => JSON.stringify(clip(text, limit)),
  ];

  const [inputType] = [
    (element: Element) =>
      ((element as HTMLInputElement).type || 'text').toLowerCase(),
  ];

  const [roleOf] = [
    (element: Element): string => {
      const explicit = (element.getAttribute('role') || '')
        .trim()
        .split(/\s+/)[0];
      if (explicit) return explicit.toLowerCase();
      const tag = element.tagName;
      if ((tag === 'A' || tag === 'AREA') && element.hasAttribute('href')) {
        return 'link';
      }
      if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
      if (tag === 'SELECT') {
        const select = element as HTMLSelectElement;
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
      }
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'OPTION') return 'option';
      if (tag === 'IMG') {
        const alt = element.getAttribute('alt');
        if (alt === '') return '';
        return alt ||
          element.getAttribute('aria-label') ||
          element.getAttribute('title')
          ? 'img'
          : '';
      }
      if (/^H[1-6]$/.test(tag)) return 'heading';
      if (tag === 'INPUT') {
        const type = inputType(element);
        if (type === 'hidden') return '';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (
          ['button', 'submit', 'reset', 'image', 'file', 'color'].includes(type)
        ) {
          return 'button';
        }
        return 'textbox';
      }
      if ((element as HTMLElement).isContentEditable) {
        const parent = element.parentElement;
        // Only the editing host is a textbox; its descendants are content.
        return parent && (parent as HTMLElement).isContentEditable
          ? ''
          : 'textbox';
      }
      if (tag === 'SECTION') {
        return element.hasAttribute('aria-label') ||
          element.hasAttribute('aria-labelledby')
          ? 'region'
          : '';
      }
      return TAG_ROLES[tag] || '';
    },
  ];

  const [labelText] = [
    (element: Element): string => {
      const doc = element.ownerDocument;
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = collapse(
          labelledBy
            .split(/\s+/)
            .map((id) => doc.getElementById(id)?.textContent || '')
            .join(' ')
        );
        if (text) return text;
      }
      const ariaLabel = collapse(element.getAttribute('aria-label') || '');
      if (ariaLabel) return ariaLabel;
      const labels = (element as HTMLInputElement).labels;
      if (labels && labels.length) {
        const text = collapse(
          Array.from(labels)
            .map(
              (label) =>
                (label as HTMLElement).innerText || label.textContent || ''
            )
            .join(' ')
        );
        if (text) return text;
      }
      return '';
    },
  ];

  const [nameOf] = [
    (element: Element, role: string): string => {
      const label = labelText(element);
      if (label) return label;
      const tag = element.tagName;
      if (tag === 'IMG') return collapse(element.getAttribute('alt') || '');
      if (tag === 'INPUT') {
        const input = element as HTMLInputElement;
        const type = inputType(element);
        if (['button', 'submit', 'reset'].includes(type)) {
          return collapse(
            input.value ||
              (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '')
          );
        }
        if (type === 'image') return collapse(input.alt || input.value || '');
        const placeholder = collapse(input.placeholder || '');
        if (placeholder) return placeholder;
      }
      if (tag === 'TEXTAREA') {
        const placeholder = collapse(
          (element as HTMLTextAreaElement).placeholder || ''
        );
        if (placeholder) return placeholder;
      }
      if (tag === 'IFRAME' || tag === 'FRAME') {
        return collapse(
          element.getAttribute('title') || element.getAttribute('name') || ''
        );
      }
      if (NAME_FROM_CONTENT.has(role) || tag === 'SUMMARY') {
        const text = collapse(
          (element as HTMLElement).innerText || element.textContent || ''
        );
        if (text) return text;
        const image = element.querySelector('img[alt]');
        const alt = collapse(image?.getAttribute('alt') || '');
        if (alt) return alt;
      }
      return collapse(element.getAttribute('title') || '');
    },
  ];

  const [describe] = [
    (element: Element, role: string): string => {
      const parts = [role];
      const name = nameOf(element, role);
      if (name) parts.push(quote(name));
      const tag = element.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const input = element as HTMLInputElement;
        const type = tag === 'TEXTAREA' ? 'textarea' : inputType(element);
        if (
          ![
            'text',
            'textarea',
            'search',
            'checkbox',
            'radio',
            'range',
            'number',
          ].includes(type)
        ) {
          parts.push(`type=${type}`);
        }
        if (
          ![
            'password',
            'file',
            'checkbox',
            'radio',
            'button',
            'submit',
            'reset',
            'image',
          ].includes(type) &&
          input.value
        ) {
          parts.push(`value=${quote(input.value)}`);
        }
        if (type === 'checkbox' || type === 'radio') {
          parts.push(`checked=${input.checked}`);
        }
        if (input.readOnly) parts.push('readonly=true');
        if (input.required) parts.push('required=true');
      } else if (tag === 'SELECT') {
        const select = element as HTMLSelectElement;
        const selected = Array.from(select.selectedOptions).map((option) =>
          collapse(option.label || option.textContent || '')
        );
        if (selected.length) parts.push(`value=${quote(selected.join(', '))}`);
        const options = Array.from(select.options)
          .slice(0, MAX_OPTIONS)
          .map((option) =>
            clip(collapse(option.label || option.textContent || ''), 60)
          );
        if (options.length) {
          const more = select.options.length > MAX_OPTIONS ? ', ...' : '';
          parts.push(
            `options=[${options.map((option) => JSON.stringify(option)).join(', ')}${more}]`
          );
        }
      } else if (
        role === 'textbox' &&
        (element as HTMLElement).isContentEditable
      ) {
        const text = collapse((element as HTMLElement).innerText || '');
        if (text) parts.push(`value=${quote(text)}`);
      } else if (role === 'link') {
        const href = (element as HTMLAnchorElement).href;
        if (href && !href.startsWith('javascript:'))
          parts.push(`href=${quote(href, 300)}`);
      }
      if (
        (element as HTMLInputElement).disabled ||
        element.getAttribute('aria-disabled') === 'true'
      ) {
        parts.push('disabled=true');
      }
      for (const attribute of ['checked', 'expanded', 'selected', 'pressed']) {
        const value = element.getAttribute(`aria-${attribute}`);
        if (value !== null && !(attribute === 'checked' && tag === 'INPUT')) {
          parts.push(`${attribute}=${value}`);
        }
      }
      if (role === 'heading') {
        const level =
          /^H([1-6])$/.exec(tag)?.[1] || element.getAttribute('aria-level');
        if (level) parts.push(`level=${level}`);
      }
      return parts.join(' ');
    },
  ];

  const [isRendered] = [
    (element: Element): boolean => {
      const view = element.ownerDocument.defaultView;
      if (!view) return false;
      const style = view.getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
  ];

  const [inViewport] = [
    (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      let left = rect.left;
      let top = rect.top;
      let view: Window | null = element.ownerDocument.defaultView;
      while (view) {
        let frame: Element | null = null;
        try {
          frame = view.frameElement;
        } catch {
          frame = null;
        }
        if (!frame) break;
        const frameRect = frame.getBoundingClientRect();
        left += frameRect.left + frame.clientLeft;
        top += frameRect.top + frame.clientTop;
        view = frame.ownerDocument.defaultView;
      }
      if (!view) return false;
      return (
        left + rect.width > 0 &&
        top + rect.height > 0 &&
        left < view.innerWidth &&
        top < view.innerHeight
      );
    },
  ];

  const [refFor] = [
    (element: Element): string => {
      let ref = registry.refs.get(element);
      if (!ref) {
        ref = `ref_${nextRef}`;
        nextRef += 1;
        registry.refs.set(element, ref);
        registry.elements.set(ref, new WeakRef(element));
        newRefs.push(ref);
      }
      return ref;
    },
  ];

  const [push] = [
    (entry: AccessibleEntry): boolean => {
      if (entries.length >= args.maxEntries) {
        truncated = true;
        return false;
      }
      entries.push(entry);
      return true;
    },
  ];

  const [visible] = [
    (element: Element) =>
      isRendered(element) && (args.filter === 'all' || inViewport(element)),
  ];

  const [walkChildren] = [
    (node: Node, depth: number, nameFromContent: boolean) => {
      // nodeType checks instead of instanceof: same-origin iframe nodes come
      // from another realm and fail instanceof against this window's classes.
      const shadowRoot =
        node.nodeType === 1 ? (node as Element).shadowRoot : null;
      if (shadowRoot) {
        for (const child of Array.from(shadowRoot.childNodes)) {
          if (truncated) return;
          walkNode(child, depth, nameFromContent);
        }
      }
      const children =
        node.nodeType === 1 &&
        (node as Element).tagName === 'SLOT' &&
        (node as HTMLSlotElement).assignedNodes().length
          ? (node as HTMLSlotElement).assignedNodes()
          : Array.from(node.childNodes);
      for (const child of children) {
        if (truncated) return;
        walkNode(child, depth, nameFromContent);
      }
    },
  ];

  const [walkNode] = [
    (node: Node, depth: number, nameFromContent: boolean): void => {
      if (truncated || depth > args.depthLimit) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (!args.includeText || nameFromContent) return;
        const text = collapse(node.textContent || '');
        const parent = node.parentElement;
        if (text && parent && visible(parent)) {
          push({ depth, ref: null, description: `text ${quote(text, 300)}` });
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (SKIPPED_TAGS.has(element.tagName)) return;
      if (element.getAttribute('aria-hidden') === 'true') return;
      const view = element.ownerDocument.defaultView;
      if (view) {
        const style = view.getComputedStyle(element);
        // display:none hides the whole subtree; visibility can be overridden
        // by descendants, so it only hides this element.
        if (style.display === 'none') return;
      }

      const role = roleOf(element);
      let show =
        Boolean(role) &&
        role !== 'presentation' &&
        role !== 'none' &&
        role !== 'generic';
      if (
        show &&
        args.filter === 'interactive' &&
        !INTERACTIVE_ROLES.has(role)
      ) {
        show = false;
      }
      const isFrame =
        element.tagName === 'IFRAME' || element.tagName === 'FRAME';
      const isVisible = (show || isFrame) && visible(element);
      if (show && !isVisible) show = false;

      let childDepth = depth;
      if (show) {
        if (
          !push({
            depth,
            ref: refFor(element),
            description: describe(element, role),
          })
        )
          return;
        childDepth = depth + 1;
      }

      if (isFrame) {
        // Frame content is walked from its own frame so every ref resolves in
        // the execution context of the document that owns the element.
        if (isVisible) {
          frames.push({
            ref: refFor(element),
            depth: childDepth,
            index: entries.length,
          });
        }
        return;
      }

      walkChildren(
        element,
        childDepth,
        nameFromContent || (show && NAME_FROM_CONTENT.has(role))
      );
    },
  ];

  let missingRoot = false;
  if (args.rootRef) {
    const root = registry.elements.get(args.rootRef)?.deref() ?? null;
    if (root && root.isConnected) {
      walkNode(root, 0, false);
    } else {
      missingRoot = true;
    }
  } else {
    const root = document.body ?? document.documentElement;
    if (root) walkChildren(root, 0, false);
  }

  return { entries, frames, newRefs, nextRef, truncated, missingRoot };
}

/**
 * Scroll an element into view and return its center relative to the viewport
 * of the frame that owns it.
 */
export function elementClickPoint(element: Element): { x: number; y: number } {
  const target =
    element.nodeType === Node.ELEMENT_NODE
      ? element
      : (element as Node).parentElement;
  if (!target || !target.isConnected) throw new Error('Detached element');
  target.scrollIntoView({
    block: 'center',
    inline: 'center',
    behavior: 'instant' as ScrollBehavior,
  });
  const rect = target.getBoundingClientRect();
  const view = target.ownerDocument.defaultView;
  if (
    !rect.width ||
    !rect.height ||
    (view && view.getComputedStyle(target).visibility === 'hidden')
  ) {
    throw new Error('Element has no visible click target');
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Offset of an iframe's content box inside its own document's viewport. */
export function frameContentOffset(frame: Element): { x: number; y: number } {
  const rect = frame.getBoundingClientRect();
  const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
  return {
    x: rect.left + frame.clientLeft + parseFloat(style?.paddingLeft || '0'),
    y: rect.top + frame.clientTop + parseFloat(style?.paddingTop || '0'),
  };
}
