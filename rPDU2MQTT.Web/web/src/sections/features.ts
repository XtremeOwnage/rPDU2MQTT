// Which setting turns each capability on, and how to reach a section's page.
//
// The switches themselves are not edited in the GUI: a feature is turned on in the configuration file, or
// in the deployment's values, where the service, volume or port it needs is declared beside it. The server
// marks the one setting that turns each capability on ([FeatureToggle]) so a page can say where its switch
// is, and so the nav can hide a page for something that is off.
export function featureToggle(node: any): any | null {
  if (node?.type !== 'object') return null;
  return (node.properties || []).find((p: any) => p.isFeatureToggle) || null;
}

/// Jump to a feature's own settings page. Nav links carry the schema key they edit, so this finds the page
/// without a second table of where things live.
export function jumpToSection(key: string) {
  const links: any[] = Array.from(document.querySelectorAll('nav a'));
  const link = links.find(a => a.dataset && a.dataset.section === key);
  if (link) link.click();
}
