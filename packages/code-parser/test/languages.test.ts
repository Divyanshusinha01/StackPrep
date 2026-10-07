import { afterAll, describe, expect, it } from "vitest";
import { createCodeParser } from "../src/index.ts";
import { callRows, exportRows, importRows, symbolRows } from "./helpers.ts";

const parser = createCodeParser();
afterAll(() => parser.dispose());

describe("typescript", () => {
  const content = `import { z } from "zod";
import type { Row } from "./types";
import Default, * as ns from "./mod";
export * from "./all";
export { a as b } from "./ab";

export interface Workspace { id: string; load(): void }
export type Id = string;
export enum Stage { A, B }
export namespace Util { export function inner() {} }
declare module "virtual" { const x: number }
export abstract class Base { abstract run(): void }
export function overloaded(a: string): void;
export function overloaded(a: unknown) { return z.string().parse(a); }

const LIMIT = 4;
let counter = 0;
export const handler = async (req: Request) => fetch(req.url);

export default class Service extends Base {
  constructor(private db: Db) { super(); }
  run() { return this.db.from("t").select(); }
}

function helper() { return new Service(db); }
export { helper, LIMIT as MAX };
`;

  it("extracts symbols with kinds, parents and export flags", async () => {
    const facts = await parser.parseFile({ path: "src/service.ts", content });
    expect(facts.status).toBe("ok");
    expect(facts.language).toBe("typescript");
    expect(symbolRows(facts)).toEqual([
      { name: "Workspace", kind: "interface", parent: null, exported: true },
      { name: "load", kind: "method", parent: "Workspace", exported: false },
      { name: "Id", kind: "type", parent: null, exported: true },
      { name: "Stage", kind: "enum", parent: null, exported: true },
      { name: "Util", kind: "module", parent: null, exported: true },
      { name: "inner", kind: "function", parent: "Util", exported: false },
      { name: "virtual", kind: "module", parent: null, exported: false },
      { name: "Base", kind: "class", parent: null, exported: true },
      { name: "run", kind: "method", parent: "Base", exported: false },
      { name: "overloaded", kind: "function", parent: null, exported: true },
      { name: "overloaded", kind: "function", parent: null, exported: true },
      { name: "LIMIT", kind: "constant", parent: null, exported: true },
      { name: "counter", kind: "variable", parent: null, exported: false },
      { name: "handler", kind: "function", parent: null, exported: true },
      { name: "Service", kind: "class", parent: null, exported: true },
      { name: "constructor", kind: "method", parent: "Service", exported: false },
      { name: "run", kind: "method", parent: "Service", exported: false },
      { name: "helper", kind: "function", parent: null, exported: true },
    ]);
  });

  it("extracts imports including type-only and re-exports", async () => {
    const facts = await parser.parseFile({ path: "src/service.ts", content });
    expect(importRows(facts)).toEqual([
      { source: "zod", names: ["z"], kind: "static" },
      { source: "./types", names: ["Row"], kind: "type" },
      { source: "./mod", names: ["default", "*"], kind: "static" },
      { source: "./all", names: ["*"], kind: "reexport" },
      { source: "./ab", names: ["a"], kind: "reexport" },
    ]);
  });

  it("extracts exports linked to local symbols", async () => {
    const facts = await parser.parseFile({ path: "src/service.ts", content });
    expect(exportRows(facts)).toEqual([
      { name: "*", kind: "all", source: "./all", symbol: null },
      { name: "b", kind: "reexport", source: "./ab", symbol: null },
      { name: "Workspace", kind: "named", source: null, symbol: "Workspace" },
      { name: "Id", kind: "named", source: null, symbol: "Id" },
      { name: "Stage", kind: "named", source: null, symbol: "Stage" },
      { name: "Util", kind: "named", source: null, symbol: "Util" },
      { name: "Base", kind: "named", source: null, symbol: "Base" },
      { name: "overloaded", kind: "named", source: null, symbol: "overloaded" },
      { name: "overloaded", kind: "named", source: null, symbol: "overloaded" },
      { name: "handler", kind: "named", source: null, symbol: "handler" },
      { name: "default", kind: "default", source: null, symbol: "Service" },
      { name: "helper", kind: "named", source: null, symbol: "helper" },
      { name: "MAX", kind: "named", source: null, symbol: "LIMIT" },
    ]);
  });

  it("extracts calls with their enclosing symbol", async () => {
    const facts = await parser.parseFile({ path: "src/service.ts", content });
    expect(callRows(facts)).toEqual([
      { callee: "z.string", in: "overloaded" },
      { callee: "z.string().parse", in: "overloaded" },
      { callee: "fetch", in: "handler" },
      { callee: "super", in: "constructor" },
      { callee: "this.db.from", in: "run" },
      { callee: "this.db.from(\"t\").select", in: "run" },
      { callee: "Service", in: "helper" },
    ]);
  });

  it("produces signatures without bodies", async () => {
    const facts = await parser.parseFile({ path: "src/service.ts", content });
    const sig = (name: string) => facts.symbols.find((s) => s.name === name)?.signature;
    expect(sig("handler")).toBe("handler = async (req: Request)");
    expect(sig("helper")).toBe("function helper()");
    expect(sig("Service")).toBe("class Service extends Base");
    expect(sig("Id")).toBe("type Id = string;");
    expect(sig("LIMIT")).toBe("LIMIT = 4");
  });
});

describe("tsx", () => {
  it("parses JSX components", async () => {
    const facts = await parser.parseFile({
      path: "src/Card.tsx",
      content: `import { useState } from "react";
export function Card({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return <button onClick={() => setOpen(!open)}>{title}</button>;
}
`,
    });
    expect(facts.status).toBe("ok");
    expect(facts.language).toBe("tsx");
    expect(symbolRows(facts)).toEqual([{ name: "Card", kind: "function", parent: null, exported: true }]);
    expect(callRows(facts)).toEqual([
      { callee: "useState", in: "Card" },
      { callee: "setOpen", in: "Card" },
    ]);
  });
});

describe("javascript", () => {
  const content = `const express = require("express");
import def, * as ns from "./mod.js";
import "./side-effect.js";

class Cache {
  get(key) { return this.map.get(key); }
}

async function load() {
  const m = await import("./lazy.js");
  return new Cache();
}

export default load;
export { Cache };
`;

  it("extracts symbols, CommonJS and dynamic imports, and export lists", async () => {
    const facts = await parser.parseFile({ path: "lib/cache.mjs", content });
    expect(facts.status).toBe("ok");
    expect(facts.language).toBe("javascript");
    expect(symbolRows(facts)).toEqual([
      { name: "express", kind: "constant", parent: null, exported: false },
      { name: "Cache", kind: "class", parent: null, exported: true },
      { name: "get", kind: "method", parent: "Cache", exported: false },
      { name: "load", kind: "function", parent: null, exported: true },
    ]);
    expect(importRows(facts)).toEqual([
      { source: "express", names: [], kind: "require" },
      { source: "./mod.js", names: ["default", "*"], kind: "static" },
      { source: "./side-effect.js", names: [], kind: "static" },
      { source: "./lazy.js", names: [], kind: "dynamic" },
    ]);
    expect(exportRows(facts)).toEqual([
      { name: "default", kind: "default", source: null, symbol: "load" },
      { name: "Cache", kind: "named", source: null, symbol: "Cache" },
    ]);
    expect(callRows(facts)).toEqual([
      { callee: "require", in: "express" },
      { callee: "this.map.get", in: "get" },
      { callee: "import", in: "load" },
      { callee: "Cache", in: "load" },
    ]);
  });
});

describe("python", () => {
  const content = `import os, sys
import numpy as np
from .models import User, Account as Acct
from typing import *

MAX_RETRIES = 3
_cache = {}

class Repo:
    def load(self, id):
        return self.db.get(id)

    def _private(self):
        pass

def _helper():
    print("x")

@decorator
def handler(event):
    return Repo().load(event)
`;

  it("extracts symbols, imports and calls", async () => {
    const facts = await parser.parseFile({ path: "app/repo.py", content });
    expect(facts.status).toBe("ok");
    expect(symbolRows(facts)).toEqual([
      { name: "MAX_RETRIES", kind: "constant", parent: null, exported: true },
      { name: "_cache", kind: "variable", parent: null, exported: false },
      { name: "Repo", kind: "class", parent: null, exported: true },
      { name: "load", kind: "method", parent: "Repo", exported: true },
      { name: "_private", kind: "method", parent: "Repo", exported: false },
      { name: "_helper", kind: "function", parent: null, exported: false },
      { name: "handler", kind: "function", parent: null, exported: true },
    ]);
    expect(importRows(facts)).toEqual([
      { source: "os", names: [], kind: "static" },
      { source: "sys", names: [], kind: "static" },
      { source: "numpy", names: [], kind: "static" },
      { source: ".models", names: ["User", "Account"], kind: "static" },
      { source: "typing", names: ["*"], kind: "static" },
    ]);
    expect(exportRows(facts).map((e) => e.name)).toEqual(["MAX_RETRIES", "Repo", "handler"]);
    expect(callRows(facts)).toEqual([
      { callee: "self.db.get", in: "load" },
      { callee: "print", in: "_helper" },
      { callee: "Repo", in: "handler" },
      { callee: "Repo().load", in: "handler" },
    ]);
    expect(facts.symbols.find((s) => s.name === "load")?.signature).toBe("def load(self, id)");
  });
});

describe("java", () => {
  const content = `package com.acme;

import java.util.List;
import java.util.*;
import static java.lang.Math.max;

public class Service {
    public static final int LIMIT = 10;
    private int count;

    public Service(Store store) { this.store = store; }

    public List<String> ids() {
        return store.all();
    }

    private void log() { System.out.println("x"); }

    public interface Store { List<String> all(); }

    public enum Mode { A, B }
}

class Internal { void run() { new Service(null).ids(); } }
`;

  it("extracts symbols with visibility, imports and calls", async () => {
    const facts = await parser.parseFile({ path: "src/Service.java", content });
    expect(facts.status).toBe("ok");
    expect(symbolRows(facts)).toEqual([
      { name: "Service", kind: "class", parent: null, exported: true },
      { name: "LIMIT", kind: "constant", parent: "Service", exported: true },
      { name: "count", kind: "variable", parent: "Service", exported: false },
      { name: "Service", kind: "method", parent: "Service", exported: true },
      { name: "ids", kind: "method", parent: "Service", exported: true },
      { name: "log", kind: "method", parent: "Service", exported: false },
      { name: "Store", kind: "interface", parent: "Service", exported: true },
      { name: "all", kind: "method", parent: "Store", exported: true },
      { name: "Mode", kind: "enum", parent: "Service", exported: true },
      { name: "Internal", kind: "class", parent: null, exported: false },
      { name: "run", kind: "method", parent: "Internal", exported: false },
    ]);
    expect(importRows(facts)).toEqual([
      { source: "java.util.List", names: ["List"], kind: "static" },
      { source: "java.util", names: ["*"], kind: "static" },
      { source: "java.lang.Math.max", names: ["max"], kind: "static" },
    ]);
    expect(exportRows(facts).map((e) => e.name)).toEqual(["Service"]);
    expect(callRows(facts)).toEqual([
      { callee: "store.all", in: "ids" },
      { callee: "System.out.println", in: "log" },
      { callee: "Service", in: "run" },
      { callee: "new Service(null).ids", in: "run" },
    ]);
  });
});

describe("go", () => {
  const content = `package svc

import (
	"context"
	f "fmt"
	_ "embed"
)

const Limit = 10
const internal = 1

var (
	Default = New()
	cache   = map[string]int{}
)

type Store interface {
	Find(ctx context.Context, id string) error
}

type Service struct {
	store Store
}

type ID = string

func New() *Service { return &Service{} }

func (s *Service) Load(ctx context.Context, id string) error {
	return s.store.Find(ctx, id)
}

func helper() { f.Println("x") }
`;

  it("extracts symbols with Go export rules, imports and calls", async () => {
    const facts = await parser.parseFile({ path: "svc/service.go", content });
    expect(facts.status).toBe("ok");
    expect(symbolRows(facts)).toEqual([
      { name: "Limit", kind: "constant", parent: null, exported: true },
      { name: "internal", kind: "constant", parent: null, exported: false },
      { name: "Default", kind: "variable", parent: null, exported: true },
      { name: "cache", kind: "variable", parent: null, exported: false },
      { name: "Store", kind: "interface", parent: null, exported: true },
      { name: "Service", kind: "class", parent: null, exported: true },
      { name: "ID", kind: "type", parent: null, exported: true },
      { name: "New", kind: "function", parent: null, exported: true },
      { name: "Load", kind: "method", parent: null, exported: true },
      { name: "helper", kind: "function", parent: null, exported: false },
    ]);
    expect(importRows(facts)).toEqual([
      { source: "context", names: [], kind: "static" },
      { source: "fmt", names: ["f"], kind: "static" },
      { source: "embed", names: ["_"], kind: "static" },
    ]);
    expect(callRows(facts)).toEqual([
      { callee: "New", in: "Default" },
      { callee: "s.store.Find", in: "Load" },
      { callee: "f.Println", in: "helper" },
    ]);
  });
});
