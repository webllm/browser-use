# Actor API

Low-level, deterministic control over the session's current page without an
LLM.

```typescript
import { Page } from 'browser-use/actor';

const page = new Page(session); // a started BrowserSession
await page.goto('https://example.com');
const title = await page.get_title();
```

## Page

| Method                                                      | Notes                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `goto(url)`, `reload()`, `go_back()`, `go_forward()`        | Navigation through the session's domain policy                               |
| `get_url()`, `get_title()`, `evaluate(fnOrSource, ...args)` | Page state                                                                   |
| `press(keys)`                                               | Keys or chords such as `Control+a`                                           |
| `hold_key(key, seconds)`                                    | Hold a key or modifier chord, always releasing it                            |
| `screenshot({ full_page, clip, format, quality })`          | Base64 image; `clip: { x, y, width, height, scale }` zooms a document region |
| `set_viewport_size(width, height)`                          | Resize the viewport                                                          |
| `get_element_by_index(index)`                               | Element from the latest DOM state                                            |
| `mouse`                                                     | The page's `Mouse`                                                           |

## Mouse

| Method                                            | Notes                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `click(x, y, { button, click_count, modifiers })` | `click_count: 2` double-clicks; modifiers are `Alt`, `Control`, `Meta`, `Shift` |
| `move(x, y, { steps })`                           | Held buttons stay pressed, so this drags                                        |
| `down({ button })`, `up({ button })`              | Manual press and release                                                        |
| `scroll(x, y, delta_x, delta_y)`                  | Wheel scroll; omitted coordinates use the viewport center                       |

## Element

| Method                                                            | Notes                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `click()`, `fill(text)`, `hover()`, `focus()`                     | Basic interaction                                                      |
| `check()`                                                         | Checks a checkbox or radio without toggling it off                     |
| `select_option(values)`                                           | Matches option labels or values, including optgroups and multi-selects |
| `set_input_files(paths)`                                          | An empty list clears the input                                         |
| `scroll_into_view()`                                              | Scroll if needed                                                       |
| `drag_to(targetOrPosition, { source_position, target_position })` | Mouse drag                                                             |
| `get_attribute(name)`, `get_bounding_box()`, `evaluate(source)`   | Inspection                                                             |
