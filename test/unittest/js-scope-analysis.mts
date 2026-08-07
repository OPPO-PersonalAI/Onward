/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Real scope analysis for the PDF viewer's plain-script modules, built on
 * acorn (MIT, devDependency). Replaces the indentation/regex heuristics the
 * module-boundary guard started with: a heuristic that misreads one binding
 * either misses a genuine cross-module leak or cries wolf on a local.
 *
 * Not a test file itself — imported by
 * test/unittest/pdf-viewer-module-boundaries.test.mts, which also carries a
 * built-in negative control proving this analyzer still catches the original
 * defect class.
 */

import * as acorn from 'acorn'

type AnyNode = acorn.Node & Record<string, unknown>

interface Scope {
  kind: 'function' | 'block'
  declared: Set<string>
  parent: Scope | null
}

function makeScope(kind: Scope['kind'], parent: Scope | null): Scope {
  return { kind, declared: new Set(), parent }
}

function nearestFunctionScope(scope: Scope): Scope {
  let cursor: Scope | null = scope
  while (cursor && cursor.kind !== 'function') cursor = cursor.parent
  return cursor ?? scope
}

function isResolvable(name: string, scope: Scope | null): boolean {
  for (let cursor = scope; cursor; cursor = cursor.parent) {
    if (cursor.declared.has(name)) return true
  }
  return false
}

/** Collect every name bound by a binding pattern (params, declarators, catch). */
function bindPattern(node: AnyNode | null | undefined, into: Set<string>): void {
  if (!node) return
  switch (node.type) {
    case 'Identifier':
      into.add(node.name as string)
      return
    case 'ObjectPattern':
      for (const property of node.properties as AnyNode[]) {
        if (property.type === 'RestElement') bindPattern(property.argument as AnyNode, into)
        else bindPattern(property.value as AnyNode, into)
      }
      return
    case 'ArrayPattern':
      for (const element of node.elements as (AnyNode | null)[]) bindPattern(element, into)
      return
    case 'AssignmentPattern':
      bindPattern(node.left as AnyNode, into)
      return
    case 'RestElement':
      bindPattern(node.argument as AnyNode, into)
      return
    default:
      return
  }
}

function isFunctionLike(node: AnyNode): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  )
}

/**
 * Hoisting pass: declare `var` and function declarations into the nearest
 * function scope, recursing into blocks but never into nested functions
 * (their vars belong to them).
 */
function hoistInto(node: AnyNode | null | undefined, functionScope: Scope): void {
  if (!node || typeof node.type !== 'string') return
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const declarator of node.declarations as AnyNode[]) {
      bindPattern(declarator.id as AnyNode, functionScope.declared)
    }
  }
  if (node.type === 'FunctionDeclaration' && node.id) {
    functionScope.declared.add((node.id as AnyNode).name as string)
  }
  if (isFunctionLike(node)) return
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && typeof (child as AnyNode).type === 'string') {
          hoistInto(child as AnyNode, functionScope)
        }
      }
    } else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') {
      hoistInto(value as AnyNode, functionScope)
    }
  }
}

/** Declare a scope's lexical (`let`/`const`/`class`) names from its direct body. */
function declareLexical(body: AnyNode[], scope: Scope): void {
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declarator of statement.declarations as AnyNode[]) {
        bindPattern(declarator.id as AnyNode, scope.declared)
      }
    }
    if (statement.type === 'ClassDeclaration' && statement.id) {
      scope.declared.add((statement.id as AnyNode).name as string)
    }
  }
}

export interface ScopeAnalysis {
  /** Identifiers referenced but never bound in any enclosing scope. */
  freeIdentifiers: Set<string>
  /** `let`/`var` names declared directly in the module's factory scope(s):
   *  the top level, every function body directly invoked at load time (IIFE
   *  wrappers, UMD factories), and — the shape that actually carries the
   *  state in these modules — the body of any function named `create`
   *  reachable through those scopes (each DOM module exports a
   *  `create(deps)` factory whose locals are the module's session state;
   *  the historical `textSelectionDragState` leak lived exactly there). */
  factoryState: Set<string>
}

export function analyzeModule(source: string): ScopeAnalysis {
  const ast = acorn.parse(source, { ecmaVersion: 2023, sourceType: 'script' }) as unknown as AnyNode
  const freeIdentifiers = new Set<string>()
  const factoryState = new Set<string>()

  // Factory bodies: function expressions invoked immediately at module load,
  // including UMD factories passed as call arguments and invoked inside.
  // Approximation that matches these files exactly: every FunctionExpression
  // that is (a) the callee of a CallExpression, or (b) an argument of a
  // top-level CallExpression.
  const factoryBodies = new Set<AnyNode>()
  const markFactories = (node: AnyNode | null | undefined): void => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'CallExpression') {
      const callee = node.callee as AnyNode
      if (callee && (callee.type === 'FunctionExpression' || callee.type === 'ArrowFunctionExpression')) {
        factoryBodies.add(callee)
      }
      for (const argument of node.arguments as AnyNode[]) {
        if (argument && (argument.type === 'FunctionExpression' || argument.type === 'ArrowFunctionExpression')) {
          factoryBodies.add(argument)
        }
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object') markFactories(child as AnyNode)
        }
      } else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') {
        markFactories(value as AnyNode)
      }
    }
  }
  markFactories(ast)

  // Function declarations named `create` that sit directly inside a factory
  // scope are factories themselves — their locals are the module's session
  // state. Membership is computed transitively as factory scopes register.
  const factoryOwners = new Set<AnyNode>([ast])
  for (const body of factoryBodies) factoryOwners.add(body)

  const collectFactoryState = (scopeOwner: AnyNode, body: AnyNode[]): void => {
    if (!factoryOwners.has(scopeOwner)) return
    for (const statement of body) {
      if (statement.type === 'VariableDeclaration' && (statement.kind === 'let' || statement.kind === 'var')) {
        for (const declarator of statement.declarations as AnyNode[]) {
          bindPattern(declarator.id as AnyNode, factoryState)
        }
      }
      if (
        statement.type === 'FunctionDeclaration' &&
        statement.id &&
        ((statement.id as AnyNode).name as string) === 'create'
      ) {
        factoryOwners.add(statement)
      }
    }
  }

  const visit = (node: AnyNode | null | undefined, scope: Scope): void => {
    if (!node || typeof node.type !== 'string') return

    switch (node.type) {
      case 'Identifier':
        if (!isResolvable(node.name as string, scope)) freeIdentifiers.add(node.name as string)
        return
      case 'MemberExpression': {
        visit(node.object as AnyNode, scope)
        if (node.computed) visit(node.property as AnyNode, scope)
        return
      }
      case 'Property': {
        if (node.computed) visit(node.key as AnyNode, scope)
        visit(node.value as AnyNode, scope)
        return
      }
      case 'LabeledStatement':
        visit(node.body as AnyNode, scope)
        return
      case 'BreakStatement':
      case 'ContinueStatement':
        return
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const functionScope = makeScope('function', scope)
        // A named function expression can refer to itself.
        if (node.type === 'FunctionExpression' && node.id) {
          functionScope.declared.add((node.id as AnyNode).name as string)
        }
        for (const parameter of (node.params as AnyNode[]) ?? []) {
          bindPattern(parameter, functionScope.declared)
        }
        const body = node.body as AnyNode
        if (body.type === 'BlockStatement') {
          hoistInto(body, functionScope)
          declareLexical(body.body as AnyNode[], functionScope)
          collectFactoryState(node, body.body as AnyNode[])
          for (const statement of body.body as AnyNode[]) visit(statement, functionScope)
        } else {
          visit(body, functionScope)
        }
        return
      }
      case 'BlockStatement': {
        const blockScope = makeScope('block', scope)
        declareLexical(node.body as AnyNode[], blockScope)
        for (const statement of node.body as AnyNode[]) visit(statement, blockScope)
        return
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const loopScope = makeScope('block', scope)
        const init = (node.init ?? node.left) as AnyNode | undefined
        if (init && init.type === 'VariableDeclaration') {
          for (const declarator of init.declarations as AnyNode[]) {
            bindPattern(declarator.id as AnyNode, loopScope.declared)
          }
          for (const declarator of init.declarations as AnyNode[]) {
            if (declarator.init) visit(declarator.init as AnyNode, loopScope)
          }
        } else if (init) {
          visit(init, loopScope)
        }
        for (const key of ['test', 'update', 'right'] as const) {
          if (node[key]) visit(node[key] as AnyNode, loopScope)
        }
        visit(node.body as AnyNode, loopScope)
        return
      }
      case 'CatchClause': {
        const catchScope = makeScope('block', scope)
        if (node.param) bindPattern(node.param as AnyNode, catchScope.declared)
        visit(node.body as AnyNode, catchScope)
        return
      }
      case 'VariableDeclaration': {
        for (const declarator of node.declarations as AnyNode[]) {
          if (declarator.init) visit(declarator.init as AnyNode, scope)
        }
        return
      }
      default: {
        for (const key of Object.keys(node)) {
          const value = node[key]
          if (Array.isArray(value)) {
            for (const child of value) {
              if (child && typeof child === 'object' && typeof (child as AnyNode).type === 'string') {
                visit(child as AnyNode, scope)
              }
            }
          } else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') {
            visit(value as AnyNode, scope)
          }
        }
      }
    }
  }

  const moduleScope = makeScope('function', null)
  hoistInto(ast, moduleScope)
  declareLexical(ast.body as AnyNode[], moduleScope)
  collectFactoryState(ast, ast.body as AnyNode[])
  for (const statement of ast.body as AnyNode[]) visit(statement, moduleScope)

  return { freeIdentifiers, factoryState }
}
