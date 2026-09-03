/**
 * Convex refuses to push a schema whose object validators carry field names it does not allow.
 * The rule bit on 2026-09-03: a `v.object({ "mel-diaper": ..., "reggie-banks": ... })` in
 * convex/validators.ts typechecked, passed every test and CI, and then failed the schema push on
 * the beta and production builds (`npx convex deploy` inside the Vercel build). CI never pushes a
 * schema, so this test is the only place the rule is checked before a deploy.
 *
 * Convex field names must be non-empty, ASCII letters/digits/underscores, and must not start
 * with `$` or `_`. Persona slugs (hyphenated) belong in VALUES, never in keys.
 */
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import * as validators from "../convex/validators";
import { v } from "convex/values";

const FIELD_NAME = /^[A-Za-z0-9][A-Za-z0-9_]*$/;

type Node = { kind?: string; fields?: Record<string, Node>; element?: Node; members?: Node[]; value?: Node; key?: Node };

function walk(node: unknown, path: string, offenders: string[]): void {
  if (!node || typeof node !== "object") return;
  const v = node as Node;
  if (v.fields && typeof v.fields === "object") {
    for (const [name, child] of Object.entries(v.fields)) {
      if (!FIELD_NAME.test(name)) offenders.push(`${path}.${name}`);
      walk(child, `${path}.${name}`, offenders);
    }
  }
  if (v.element) walk(v.element, `${path}[]`, offenders);
  if (v.value) walk(v.value, `${path}{}`, offenders);
  if (Array.isArray(v.members)) v.members.forEach((m, i) => walk(m, `${path}|${i}`, offenders));
}

describe("Convex field names", () => {
  it("the walker itself catches a hyphenated key (sanity)", () => {
    const offenders: string[] = [];
    walk(v.object({ ok: v.string(), nested: v.array(v.object({ "mel-diaper": v.string() })) }), "x", offenders);
    expect(offenders).toEqual(["x.nested[].mel-diaper"]);
  });

  it("every table validator uses field names Convex accepts", () => {
    const offenders: string[] = [];
    for (const [table, definition] of Object.entries(schema.tables)) {
      walk((definition as { validator: unknown }).validator, table, offenders);
    }
    expect(offenders).toEqual([]);
  });

  it("every exported validator in convex/validators.ts uses field names Convex accepts", () => {
    const offenders: string[] = [];
    for (const [name, validator] of Object.entries(validators)) {
      if (validator && typeof validator === "object" && "kind" in (validator as object)) {
        walk(validator, name, offenders);
      }
    }
    expect(offenders).toEqual([]);
  });
});
