/*
 * The Settings kit, one import path for every screen: `import { Section, Card, Row, ... } from "@/components/settings/ui"`.
 *
 *   Section      title + optional action, then cards or rows              kit-rows.tsx
 *   Card         rounded card with hairlines between its children          kit-rows.tsx
 *   Row          title, description, status, control, full-width children  kit-rows.tsx
 *   ListRow      an item in a list: icon, title, subtitle, status, actions kit-rows.tsx
 *   EmptyRow     an empty list, one sentence                              kit-rows.tsx
 *   LoadingRow   loading, inside a card                                   kit-rows.tsx
 *   ErrorRow     a failed load, inside a card, with retry                 kit-rows.tsx
 *   Advanced     folded disclosure for the rare settings                  kit-rows.tsx
 *   TextField    text, saved on blur or Enter                             kit-controls.tsx
 *   SecretField  masked key, shows the last 4                             kit-controls.tsx
 *   SettingsSelect  the Radix select at size sm                           kit-controls.tsx
 *   Status / StatusDot  quiet status: amber = act, red = broken           kit-controls.tsx
 *   InUse        the one in use or connected: green dot + green word      kit-controls.tsx
 *   RowMenu      the `…` menu, destructive last, confirmed                kit-controls.tsx
 *   saveFailed   the toast for a failed save                              kit-controls.tsx
 *   FormDialog   small form dialog shell (title, fields, one button)      kit-dialog.tsx
 *   PageAction   a button in the page header (page-action.tsx)
 *   legacy       Group, Footnote, Dot, Notice, Loading, ModelSelect, EffortSelect (legacy.tsx, deprecated)
 *
 * A row with an `id` is searchable and landable: add the id to search.ts first (see that file).
 */
export * from "./kit-rows";
export * from "./kit-controls";
export * from "./kit-dialog";
export * from "./legacy";
export { PageAction } from "./page-action";
