// Shared, mutable app state: the config schema and the editable config document, both set on load().
// (Authored as ES modules; the build bundles them into one shared scope, as the GUI has always run.)
export const state: { schema: any[]; data: any } = { schema: [], data: {} };
