import type { LanguageDefinition } from "./language.ts";

export interface LanguageRegistry {
  register(def: LanguageDefinition): void;
  byId(id: string): LanguageDefinition | undefined;
  byExtension(extension: string): LanguageDefinition | undefined;
  /** Detect a language from a file path: exact filename first, then the last extension. */
  detect(path: string): LanguageDefinition | undefined;
  list(): LanguageDefinition[];
}

function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

export function createRegistry(defs: readonly LanguageDefinition[] = []): LanguageRegistry {
  const ids = new Map<string, LanguageDefinition>();
  const extensions = new Map<string, LanguageDefinition>();
  const filenames = new Map<string, LanguageDefinition>();

  const registry: LanguageRegistry = {
    register(def) {
      if (!def.id) throw new Error("language id is required");
      if (ids.has(def.id)) throw new Error(`language "${def.id}" is already registered`);
      const exts = def.extensions.map(normalizeExtension);
      for (const ext of exts) {
        const owner = extensions.get(ext);
        if (owner) throw new Error(`extension "${ext}" is already registered by "${owner.id}"`);
      }
      for (const name of def.filenames ?? []) {
        const owner = filenames.get(name);
        if (owner) throw new Error(`filename "${name}" is already registered by "${owner.id}"`);
      }
      ids.set(def.id, def);
      for (const ext of exts) extensions.set(ext, def);
      for (const name of def.filenames ?? []) filenames.set(name, def);
    },
    byId: (id) => ids.get(id),
    byExtension: (ext) => extensions.get(normalizeExtension(ext)),
    detect(path) {
      const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
      const exact = filenames.get(base);
      if (exact) return exact;
      const dot = base.lastIndexOf(".");
      if (dot <= 0) return undefined;
      return extensions.get(base.slice(dot).toLowerCase());
    },
    list: () => [...ids.values()],
  };

  for (const def of defs) registry.register(def);
  return registry;
}
