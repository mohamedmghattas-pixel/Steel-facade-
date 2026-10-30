/**
 * Minimal JSON-schema check for tool inputs (the subset the tool schemas use).
 * Tool inputs stream eagerly, so the client validates before running a tool.
 */
type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
};

export function validate(schema: Schema, value: unknown, path = 'input'): string | null {
  if (value === undefined || value === null) return `${path} is missing`;
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const k of schema.required ?? []) if (obj[k] === undefined) return `${path}.${k} is required`;
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        if (obj[k] === undefined) continue;
        const err = validate(sub, obj[k], `${path}.${k}`);
        if (err) return err;
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} allows at most ${schema.maxItems} items`;
      for (let i = 0; i < value.length; i++) {
        const err = schema.items ? validate(schema.items, value[i], `${path}[${i}]`) : null;
        if (err) return err;
      }
      break;
    }
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return `${path} must be an integer`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `${path} must be true or false`;
      break;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
  return null;
}
