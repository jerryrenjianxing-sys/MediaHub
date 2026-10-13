# MediaHub identity

The mark follows the Media family: a rounded square, a clear white M and a
function represented inside the letter. MediaHub's central connection node
expresses one workbench joining independently installed tools.

- Primary purple: `#6355CF`
- White: `#FFFFFF`
- Node accent: `#DDD7FF`
- Canonical vector: `mediahub-mark.svg`

The platform keeps its graphite and teal interface palette. The purple mark
identifies the application in both themes and on Windows.

`scripts/create-icon.cjs` exports the favicon and 16–256px Windows ICO from this
vector using Sharp. Set `MEDIAHUB_SHARP_MODULE` to an installed Sharp module
when needed. Exported Windows icons are committed; application builds do not
need Sharp and never ship it. Branding assets are covered by the repository MIT
license.
