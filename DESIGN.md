# Draft design system

This document records the approved redesign for web and desktop. It supersedes prior visual decisions: cool gray surfaces, blue action colors, textured paper, and card-like decoration are no longer the design direction.

## Principles

- Use smooth paper surfaces in light mode and warm charcoal surfaces in dark mode.
- Reserve orange for brand, selected navigation, links, focus, and active actions. Status colors remain independent.
- Keep typography native to each platform, with a 4px spacing scale and restrained borders.
- Shared UI components consume semantic CSS variables from `shared-ui/src/styles/tokens.css`.
- Preserve platform behavior and existing application data. Visual examples never replace live content.

## Color tokens

| Role | Light | Dark |
| --- | --- | --- |
| Main background | `#FAF8F5` | `#211F1D` |
| Sidebar | `#F2EFEA` | `#292623` |
| Elevated surface | `#FFFDFA` | `#322E2A` |
| Primary text | `#292521` | `#F3EFE9` |
| Secondary text | `#6E675F` | `#B5ACA2` |
| Divider | `#E4DED6` | `#433D36` |
| Selected background | `#F8E7D8` | `#37322D` |
| Selected text | `#A94312` | `#F3EFE9` |
| Primary action fill | `#A94312` | `#F3EFE9` |
| Primary action label | `#FFFDFA` | `#292521` |
| Link and focus | `#A94312` | `#FF914D` |
| Brand gradient | `#FFDE59` to `#FF914D` | Same |

Inputs and meaningful control boundaries use the stronger border token. Decorative dividers use the subtle border token. Success, warning, and error always pair color with text or an icon. Toggle thumbs use elevated surface colors rather than action label colors.

## Type and layout

Use the system UI font stack and system monospace stack. Interface text is 14px, supporting text 13px, document text 16px with 1.75 line height, page titles 30px, and document titles 34px. Reader text is at most 650px wide; standard pages are at most 900px. Navigation is approximately 208px wide and document lists approximately 210px. Controls use 7–8px radii and floating notices use 10px. Keep surfaces smooth, without texture.

## Themes

Support Light, Dark, and System. Store the local preference at `draft.theme`; explicit preferences apply before first paint, and System follows OS changes. Settings control all screens, including signed-out and invitation flows. Do not sync theme at account level or add a palette editor.

## Responsive behavior

Web supports 360px and wider, including zoom and larger text. At 720px and below, navigation scrolls horizontally and Context uses a grouped document selector above the reader. Below 1000px, connection status sits below the name and actions use their own column; on phones actions can wrap below the row. Settings descriptions and controls stack when needed. Keep horizontal overflow inside code and table regions. The viewport covers safe areas; coarse-pointer inputs use 16px text to prevent iOS focus zoom; touch hover is gated and tappable controls use manipulation touch action. No zoom restriction is used. Desktop retains its native shell and 800×560 minimum size.

## Motion and accessibility

Use `cubic-bezier(0.23, 1, 0.32, 1)`. Pointer press feedback is 120ms and scales to 0.98; toggle travel is 160ms. Inline panels and activity details use 200ms opacity and up to 3px movement; successful connection notices use 180ms opacity and up to 6px movement. Theme, navigation, context selection, and search remain immediate. Gate hover effects to hover-capable fine pointers and honor reduced motion. Keep visible keyboard focus, accessible labels, semantic current-view state, keyboard access to filtering and navigation, and at least 4.5:1 text contrast and 3:1 focus/control-boundary contrast. Real-device checks are required to confirm safe areas, browser chrome, keyboard resize, and touch feedback.

## Platform distinctions

Web retains its Slack and GitHub restrictions. Desktop retains channel management, repository selection, editing, session mode, history, profile switching, and native window controls. Both Connections pages support client-side trimmed case-insensitive search through provider names and agent aliases. Search does not affect connection state or leave the client. Onboarding lists remain unfiltered.

## Decision log

- Adopt warm paper and charcoal surfaces with restrained orange accents across shared components.
- Preserve Light / Dark / System and the `draft.theme` key.
- Add opt-in shared `ToolList` search for Connections only.
- Optimize web phone behavior without copying web navigation into the desktop shell.
- Keep privacy defaults and consent promises unchanged; do not add a session replay setting.
- Store provider artwork in `shared-ui/src/integrations/logos` and render it through shared `ProviderLogo`, with a fixed 28px slot and neutral icon fallback. The current preview assets have local provenance records, but upstream license terms remain unverified.
