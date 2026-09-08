# UI conventions

- Every dropdown must use a custom HTML/CSS menu. Native `<select>` and `<datalist>` dropdowns, including browser and operating-system option menus, are not allowed. Styling a native select with `appearance: none` does not satisfy this rule; the opened menu must also be custom.
- Reuse the wiki's custom dropdown and menu patterns in `src/client/ui2.js` and `src/client/main.js`. Preserve keyboard navigation, selected-state indicators, Escape/outside-click dismissal, and focus return to the trigger.
- Keep interface copy direct. Do not add subtitles or helper text that restate a heading, placeholder, or nearby control. Explanations should provide information needed to use a feature or understand a result or error.
