// The English text of a model for its text vector, the same shape from every source (decision 2026-10-30): the shared
// category as the title, then name and description, material, colours. What a source writes its own way stays out of the
// title: its category path follows its wording, and its name is a brand word at one supplier and a description at
// another, so neighbours of a text were the source's own far above the category's share (87% against 67%, 2026-10-30).
// Brand, sizes and prices stay out. A query in another language is translated before the search (docs/integrations.md,
// «Claude API»).
import { createHash } from "node:crypto";
import type { TextInput } from "./provider.js";

// The English fields as the database gives them (src/embeddings/store.ts, readModelTexts)
export interface ModelTextFields {
  name: string | null;
  description: string | null;
  material: string | null;
  // "group > category" of the shared list; null when no mapping covers the model's path
  sharedCategory: string | null;
  colors: string[];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/\s+/g, " ").trim() : "";
}

// Undefined for a model without an English name: there is nothing to embed
export function modelText(fields: ModelTextFields): TextInput | undefined {
  const name = clean(fields.name);
  return name ? textUnderName(name, fields) : undefined;
}

// The text with this name in place of the model's own; an empty one leaves its line out (src/embeddings/brand-words.ts).
// Material and colours in lower case, as sources write them either way; a description that opens with the name does
// not say it twice.
export function textUnderName(name: string, fields: ModelTextFields): TextInput {
  const description = clean(fields.description);
  const colors = [...new Set(fields.colors.map((color) => clean(color).toLowerCase()).filter(Boolean))].sort().join(", ");
  const material = clean(fields.material).toLowerCase();
  const lines = [
    description.toLowerCase().startsWith(name.toLowerCase()) ? "" : name,
    description,
    material && `Material: ${material}`,
    colors && `Colours: ${colors}`,
  ].filter(Boolean);
  return { title: clean(fields.sharedCategory) || null, text: lines.join("\n") };
}

// What was sent, hashed: the next run embeds a model again only when this changes
export function textHash(input: TextInput): string {
  return createHash("sha256").update(JSON.stringify([input.title, input.text])).digest("hex");
}

export function textChars(input: TextInput): number {
  return (input.title?.length ?? 0) + input.text.length;
}
