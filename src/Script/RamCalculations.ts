/**
 * Implements RAM Calculation functionality.
 *
 * Uses the acorn.js library to parse a script's code into an AST and
 * recursively walk through that AST, calculating RAM usage along
 * the way
 */
import * as walk from "acorn-walk";
import {RecursiveVisitors} from "acorn-walk";
import acorn, {parse} from "acorn";
import {RamCalculationErrorCode} from "./RamCalculationErrorCodes";
import {RamCostConstants, RamCosts} from "../Netscript/RamCostGenerator";
import {Script} from "./Script";
import {areImportsEquals} from "../Terminal/DirectoryHelpers";
import {IPlayer} from "../PersonObjects/IPlayer";
import _ from "lodash";

export interface RamUsageEntry {
  type: 'ns' | 'dom' | 'fn' | 'misc';
  name: string;
  cost: number;
}

export interface RamCalculation {
  cost: number;
  entries?: RamUsageEntry[];
}

/**
 * Parse the AST, checking for loops that don't contain an "await" and are hence
 * at risk of running infinitely. Used by the script editor, but not for RAM calculation.
 */
export function checkInfiniteLoop(code: string): number {
  const ast = parse(code, { sourceType: "module", ecmaVersion: "latest" });

  function nodeHasTrueTest(node: acorn.Node): boolean {
    return node.type === "Literal" && (node as any).raw === "true";
  }

  function hasAwait(ast: acorn.Node): boolean {
    let hasAwait = false;
    walk.recursive(
      ast,
      {},
      {
        AwaitExpression: () => {
          hasAwait = true;
        },
      },
    );
    return hasAwait;
  }

  let missingAwaitLine = -1;
  walk.recursive(
    ast,
    {},
    {
      WhileStatement: (node: acorn.Node, st: any, walkDeeper: walk.WalkerCallback<any>) => {
        if (nodeHasTrueTest((node as any).test) && !hasAwait(node)) {
          missingAwaitLine = (code.slice(0, node.start).match(/\n/g) || []).length + 1;
        } else {
          (node as any).body && walkDeeper((node as any).body, st);
        }
      },
    },
  );

  return missingAwaitLine;
}

type ImportedModule = { filePath: string; alias: string; imports: string[] }
type DefinedFunction = { name: string; namespace: string; filePath: string }
type FunctionTreeNode = { fn: DefinedFunction; calledFunctions: DefinedFunction[] }
type ParsedModule = { filePath:string; importedModules: ImportedModule[]; functionTree: FunctionTreeNode[] }
// This is part of the Acorn types
type TState = any;

/**
 * Stores state for the AST parser while parsing the top-level structure - i.e. function
 * definitions and imports, but not the bodies of functions or classes.
 */
class TopLevelParseState {
  #functionTree: FunctionTreeNode[] = [];
  #importedModules: ImportedModule[] = [];
  constructor(readonly filePath: string) {}

  recordImport(path: string, alias: string, imports: string[]): void {
    this.#importedModules.push({ filePath: path, alias, imports});
  }
  recordFunction(fn: FunctionTreeNode): void {
    this.#functionTree.push(fn);
  }
  toParseResults(): ParsedModule {
    return { filePath: this.filePath, importedModules: this.#importedModules, functionTree: this.#functionTree };
  }
}


/**
 * Stores state while within a function (or class), accumulates onward function calls, and at the end
 * of the function create a FunctionTreeNode from the function and what it invokes, that can be added
 * to the parent TopLevelParseState.
 */
class WithinFunctionParseState {
  #currentFunction: DefinedFunction;
  #currentCalledFunctions: DefinedFunction[] = [];
  constructor(readonly name: string, readonly namespace: string, readonly filePath: string) {
    this.#currentFunction = { name, namespace, filePath: this.filePath };
  }
  recordFunctionCall(name: string, namespace: string): void {
    const fn: DefinedFunction = { name, namespace, filePath: this.filePath };
    this.#currentCalledFunctions.push(fn);
  }
  endFunction(): FunctionTreeNode {
    return { fn: this.#currentFunction as DefinedFunction, calledFunctions: this.#currentCalledFunctions }
  }
}


/**
 * A more complete definition of the Acorn Node - which represents a node in the JavaScript AST -
 * with various field that Acorn omits. Note that they aren't all present on all node types, but
 * without either building a full type structure for Acorn, or giving up and using "any" for
 * everything, we can't do much better.
 */
interface FullNode extends acorn.Node {
  name: string;
  // Present on function invocations
  callee: FullNode;
  // Present on function callees
  object: FullNode;
  property: FullNode;
  // Present on anything with a body, like functions, classes, blocks
  body: FullNode;
  // Present on import specifiers
  imported: FullNode;
  local: FullNode;
  // Present on function declarations
  id: FullNode;
  params: FullNode[];
  // Present on import nodes
  source: FullNode;
  specifiers: FullNode[];
  value: string;
}

/**
 * Record all the functions defined in a single Netscript file, and all the functions that is invoked
 * in turn by those functions, and the other libraries imported by the script.
 *
 * This allows us to follow the trail of functions to find all that are potentially executed from one
 * starting point, so the cost of each executed NS function can be calculated.
 */
export class NetscriptFileParser {
  constructor(readonly filePath: string) { }

  parseScript(code: string): ParsedModule {
    const ast = parse(code, { sourceType: "module", ecmaVersion: "latest" });
    const state = new TopLevelParseState(this.filePath);
    walk.recursive(ast, state, this.topLevelParsing());
    return state.toParseResults();
  }

  /**
   * Within a function declaration or class declaration, record calls made to other functions.
   */
  withinBlockParsing(): RecursiveVisitors<TState> {
    let visitor: (RecursiveVisitors<TState> | null) = null;
    const recordFunctionCalls = (node: FullNode, state: WithinFunctionParseState): void => {
      // This deals with function names like "doHack", then "ns.hacknet.doHack", then "ns.doHack", and "SomeClass.doHack"
      const [fnName, fnNamespace] = (node.callee.name) ? [node.callee.name, ""] :
        (node.callee?.object?.object?.name) ? [node.callee.property.name, node.callee.object.object.name +"."+node.callee.object.property.name] :
        [node.callee.property.name, node.callee?.object?.name ?? node.callee?.object?.callee?.name ?? ""];
      state.recordFunctionCall(fnName, fnNamespace);
      // The function call may have content within it - e.g. "new Hacker(ns).doHacking()" is a CallExpression containing a NewExpression
      walk.recursive(node.callee, state, visitor as RecursiveVisitors<TState>);
    }

    const recordFunctionReference = (node: FullNode, state: WithinFunctionParseState): void => {
      const [fnName, fnNamespace] = [node.property.name, node?.object?.name ?? ""];
      state.recordFunctionCall(fnName, fnNamespace);
    }
    visitor = Object.assign({
      CallExpression: recordFunctionCalls,
      NewExpression: recordFunctionCalls,
      // @todo Probably not the correct fix - revisit this
      MemberExpression: recordFunctionReference
    })
    return visitor as RecursiveVisitors<TState>;
  }

  /**
   * At the top level of a script file, record imports (so we know where else to go)
   * and class/function declarations (so we know what gets defined and invoked).
   */
  topLevelParsing(): RecursiveVisitors<TState> {
    const parseImport = (node: FullNode, state: TopLevelParseState): void => {
      const sourcePath = node.source.value;
      // Support either "import * as X from 'lib'" or "import { x, y } from 'lib'"
      const isImportAll = !node.specifiers.at(0)?.imported;
      if (isImportAll) {
        const alias = node.specifiers.at(0)?.local.name ?? "";
        state.recordImport(sourcePath, alias, ["*"]);
      } else {
        const imports = node.specifiers.map(n => n.imported.name);
        state.recordImport(sourcePath, "", imports);
      }
    };

    const parseFunctionOrClass = (node: FullNode, state: TopLevelParseState): void => {
      const fnName = node.id.name;
      const fnState = new WithinFunctionParseState(fnName, "", this.filePath);
      walk.recursive(node.body, fnState, this.withinBlockParsing())
      state.recordFunction(fnState.endFunction());
    }

    return Object.assign({
      ImportDeclaration: parseImport,
      FunctionDeclaration: parseFunctionOrClass,
      ClassDeclaration: parseFunctionOrClass,
    });
  }
}


/**
 * Parse an initial script, and all the scripts that are connected to it via imports, to form a list of ParseResults
 * that describe all the functions and classes that are defined or called from those scripts.
 */
export class InvocationTreeBuilder {
  #parsedModules: ParsedModule[] = [];

  async parseAll(initialCode: string, otherScripts: Script[]): Promise<ParsedModule[]> {
    const result = InvocationTreeBuilder.parse(initialCode, "");
    this.#parsedModules.push(result);

    const modulesToParse: string[] = _.uniq(result.importedModules.map(m => m.filePath));
    const alreadyParsedModulesFn = (): string[] => this.#parsedModules.map(m => m.filePath);
    while (modulesToParse.length > 0) {
      const pathToParse = modulesToParse.shift() as string;
      const normalizedPath = pathToParse.startsWith("./") ? pathToParse.slice(2) : pathToParse;

      if (alreadyParsedModulesFn().includes(normalizedPath)) { continue; }

      let code = null;
      if (pathToParse.startsWith("https://") || pathToParse.startsWith("http://")) {
        // eslint-disable-next-line no-await-in-loop
        code = await InvocationTreeBuilder.resolveExternalModule(pathToParse);
      } else {
        code = otherScripts.find(s => areImportsEquals(s.filename, normalizedPath))?.code;
      }
      if (code==null) throw new RamCalculationException(RamCalculationErrorCode.ImportError, `Imported module ${normalizedPath} can't be found`);

      const result = InvocationTreeBuilder.parse(code, normalizedPath);
      this.#parsedModules.push(result);
      modulesToParse.push(...result.importedModules.map(m => m.filePath));
    }

    return this.#parsedModules;
  }

  private static parse(code: string, filePath: string): ParsedModule {
    const p = new NetscriptFileParser(filePath);
    return p.parseScript(code);
  }

  private static async resolveExternalModule(moduleUrl: string): Promise<string> {
    try {
      const module = await eval("import(moduleUrl)");
      let code = "";
      for (const prop in module) {
        if (typeof module[prop] === "function") {
          code += module[prop].toString() + ";\n";
        }
      }
      return code;
    } catch (e) {
      const errorMsg = `Error dynamically importing module from ${moduleUrl} for RAM calculations: ${e}`;
      console.error(errorMsg);
      throw new RamCalculationException(RamCalculationErrorCode.URLImportError, errorMsg);
    }
  }
}

type FunctionCalls = { resolvedFunctions: DefinedFunction[]; unresolvedFunctions: DefinedFunction[] };


/**
 * Given an initial function, find all the functions that are called transitively starting from that function, returning them
 * as either "resolvedFunctions" that we have the definition for, or "unresolvedFunctions" for which we have no definition.
 */
export function findAllCalledFunctions(modules: ParsedModule[], entryPoint: DefinedFunction = {name: "main", namespace: "", filePath: ""}): FunctionCalls {
  const resolvedFunctions: DefinedFunction[] = [];
  const unresolvedFunctions: DefinedFunction[] = [];
  const isAlreadyProcessed = (newFn: DefinedFunction): boolean => !!resolvedFunctions.find(cf => _.isEqual(newFn, cf)) || !!unresolvedFunctions.find(cf => _.isEqual(newFn, cf));

  const toProcess: DefinedFunction[] = [entryPoint];
  while (toProcess.length > 0) {
    // Get the definition of the function
    const current = toProcess.shift() as DefinedFunction;
    const currentModule = modules.find(m => m.filePath==current.filePath) as ParsedModule;
    if (!currentModule) continue;

    // The function being called may be in the current file, or it may be imported from another module, or it may not be defined (e.g. it is an NS API function)
    const fnFromCurrentFile = currentModule?.functionTree.find(ft => _.isEqual(ft.fn, current) );
    let currentFn = null;
    if (fnFromCurrentFile!=null) {
      currentFn = fnFromCurrentFile;
    } else {
      // Check the imports for the current module to find where the function comes from
      const importReference = currentModule.importedModules.find(m => m.alias==current.namespace && (m.imports.includes(current.name) || m.imports.includes("*")) );
      const importModule = modules.find(m => m.filePath == importReference?.filePath);
      currentFn = importModule?.functionTree.find(ft => ft.fn.name==current.name && ft.fn.namespace=="" );
    }

    if (currentFn) {
      // The function could be resolved to a definition elsewhere in the scripts - so record it and find its onward dependencies
      const dependencies = currentFn?.calledFunctions ?? [];
      const newDependencies = dependencies.filter(d => !isAlreadyProcessed(d));
      resolvedFunctions.push(current);
      newDependencies.forEach(d => toProcess.push(d));
    } else {
      // The function could not be resolved - which probably means it's an NS API function like ns.hack
      unresolvedFunctions.push(current);
    }
  }
  return {resolvedFunctions, unresolvedFunctions};
}


function calculateRamCost(player: IPlayer, functions: DefinedFunction[]): RamCalculation {
  const specialKeyChecks: RamUsageEntry[] = [
    {type: "ns", cost: RamCostConstants.ScriptHacknetNodesRamCost, name: "ns.hacknet"},
    {type: "dom", cost: RamCostConstants.ScriptDomRamCost, name: "document"},
    {type: "dom", cost: RamCostConstants.ScriptDomRamCost, name: "window"},
    {type: "ns", cost: RamCostConstants.ScriptCorporationRamCost, name: "ns.corporation"},
  ];

  const uniqueFunctions = _.uniqWith(functions, _.isEqual);
  const entries: RamUsageEntry[] = uniqueFunctions.map(fn => {
    const specialCost = specialKeyChecks.find(sk => fn.namespace==sk.name);
    if (specialCost) return specialCost;
    const splitNamespace = fn.namespace.split(".");

    // This may be a number... or it may be a function, because singularity functions change cost depending on the player's source files
    let cost: (number | {(p: IPlayer): number});
    if (splitNamespace.length>1) {
      const libPart = splitNamespace.at(-1) as string;
      cost = RamCosts[libPart][fn.name] ?? 0;
    } else {
      cost = RamCosts[fn.name];
    }
    const actualCost = (typeof cost === "function") ? cost(player) : cost;
    return { type: "ns", name: fn.name, cost: actualCost };
  });

  const baseCost: RamUsageEntry = { type: 'misc', name: 'baseCost', cost: RamCostConstants.ScriptBaseRamCost};
  const entriesWithBase = [baseCost, ...entries]
  const cost = _.sum( entriesWithBase.map(r => r.cost ));
  return { cost, entries };
}

class RamCalculationException {
  constructor(readonly code: RamCalculationErrorCode, readonly message?: string) {}
}


export async function calculateRamUsage(player: IPlayer, codeCopy: string, otherScripts: Script[]): Promise<RamCalculation> {
  try {
    const parseResults = await new InvocationTreeBuilder().parseAll(codeCopy, otherScripts);
    const allCalledFunctions = findAllCalledFunctions(parseResults)
    return calculateRamCost(player, allCalledFunctions.unresolvedFunctions);
  } catch (error: any) {
    const errorCode = error?.code ?? RamCalculationErrorCode.SyntaxError;
    return { cost: errorCode };
  }
}
