// Nodes an integration manages, from its ManagedNodes rules.
export type ManagedRule = { integration: string; sourceType?: string | null; tag?: string | null };

export let managedRules: ManagedRule[] = [];
export function setManagedRules(rules: ManagedRule[]) { managedRules = rules; }

const sameText = (a: any, b: any) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/// The integration that manages this node, or null.
export function managedBy(n: any): string | null {
  const r = managedRules.find(r =>
    (r.sourceType && (n?.Sources || []).some((s: any) => sameText(s.Type, r.sourceType))) ||
    (r.tag && (n?.Tags || []).some((t: any) => sameText(t, r.tag))));
  return r ? r.integration : null;
}
