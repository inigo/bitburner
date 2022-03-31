// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {describe, expect, jest} from "@jest/globals";

// Player is needed for calculating costs like Singularity functions, that depend on acquired source files
import {Player} from "../../../src/Player";

import {RamCostConstants} from "../../../src/Netscript/RamCostGenerator";
import {calculateRamUsage, findAllCalledFunctions, InvocationTreeBuilder, NetscriptFileParser} from "../../../src/Script/RamCalculations";
import {Script} from "../../../src/Script/Script";

jest.mock(`!!raw-loader!../NetscriptDefinitions.d.ts`, () => "", {
  virtual: true,
});

const ScriptBaseCost = RamCostConstants.ScriptBaseRamCost;
const HackCost = RamCostConstants.ScriptHackRamCost;
const GrowCost = RamCostConstants.ScriptGrowRamCost;
const SleeveGetTaskCost = RamCostConstants.ScriptSleeveBaseRamCost;
const HacknetCost = RamCostConstants.ScriptHacknetNodesRamCost;
const CorpCost = RamCostConstants.ScriptCorporationRamCost;
const StanekGetCost = RamCostConstants.ScriptStanekFragmentAt;
const StanekWidthCost = RamCostConstants.ScriptStanekWidth;
const DomCost = RamCostConstants.ScriptDomRamCost;

describe("Parsing NetScript code to work out static RAM costs", function () {
  // Tests numeric equality, allowing for floating point imprecision - and includes script base cost
  function expectCost(val, expected) {
    expect(val).toBeCloseTo(expected + ScriptBaseCost);
  }

  describe("Single files with basic NS functions", function () {
    it("Empty main function", async function () {
      const code = `
        export async function main(ns) { }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, 0);
    });

    it("Free NS function directly in main", async function () {
      const code = `
        export async function main(ns) {
          ns.print("Slum snakes r00l!");
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, 0);
    });

    it("Single simple base NS function directly in main", async function () {
      const code = `
        export async function main(ns) {
          await ns.hack("joesguns");
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, HackCost);
    });

    it("Single simple base NS function directly in main with differing arg name", async function () {
      const code = `
        export async function main(X) {
          await X.hack("joesguns");
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, HackCost);
    });

    it("Repeated simple base NS function directly in main", async function () {
      const code = `
        export async function main(ns) {
          await ns.hack("joesguns");
          await ns.hack("joesguns");
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, HackCost);
    });

    it("Multiple simple base NS functions directly in main", async function () {
      const code = `
        export async function main(ns) {
          await ns.hack("joesguns");
          await ns.grow("joesguns");
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, HackCost + GrowCost);
    });

    it("Simple base NS functions in a referenced function", async function () {
      const code = `
        export async function main(ns) {
          doHacking(ns);
        }
        async function doHacking(ns) {
          await ns.hack("joesguns");
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, HackCost);
    });

    it("Simple base NS functions in a referenced class", async function () {
      const code = `
        export async function main(ns) {
          await new Hacker(ns).doHacking();
        }
        class Hacker {
          ns;
          constructor(ns) { this.ns = ns; }
          async doHacking() { await this.ns.hack("joesguns"); }
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, HackCost);
    });

  });



  describe("Functions that can be confused with NS functions", function () {
    it("Function 'get' that can be confused with Stanek.get", async function () {
      const code = `
        export async function main(ns) {
          get();
        }
        function get() { return 0; }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, 0);
    });

    it("Function 'get' on a class that can be confused with Stanek.get", async function () {
      const code = `
        export async function main(ns) {
          const fake = new FakeStanek();
          fake.get();
        }
        class FakeStanek {
          get() { return 0; }
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, 0);
    });

    it("Function 'purchaseNode' that can be confused with Hacknet.purchaseNode", async function () {
      const code = `
        export async function main(ns) {
          purchaseNode();
        }
        function purchaseNode() { return 0; }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      // Works at present, because the parser checks the namespace only, not the function name
      expectCost(calculated, 0);
    });

    it("Function 'getTask' that can be confused with Sleeve.getTask", async function () {
      const code = `
        export async function main(ns) {
          getTask();
        }
        function getTask() { return 0; }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, 0);
    });

    it("Random false positive namespaces", async function () {
      const code = `
      export async function main(ns) {
        billybob.get()
      }
    `;
      const calculated = (await calculateRamUsage(Player, code)).cost;
      expectCost(calculated, 0);
    });
  });



  describe("Single files with non-core NS functions", function () {
    it("Hacknet NS function with a cost from namespace", async function () {
      const code = `
        export async function main(ns) {
          ns.hacknet.purchaseNode(0);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, HacknetCost);
    });

    it("Corporation NS function with a cost from namespace", async function () {
      const code = `
        export async function main(ns) {
          ns.corporation.getCorporation();
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, CorpCost);
    });

    it("Both Corporation and Hacknet functions", async function () {
      const code = `
        export async function main(ns) {
          ns.corporation.getCorporation();
          ns.hacknet.purchaseNode(0);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, CorpCost+HacknetCost);
    });

    it("Sleeve functions with an individual cost", async function () {
      const code = `
        export async function main(ns) {
          ns.sleeve.getTask(3);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, SleeveGetTaskCost);
    });

    it("Actual Stanek get call", async function () {
      const code = `
        export async function main(ns) {
          ns.stanek.get(0, 0);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, RamCostConstants.ScriptStanekFragmentAt);
    });

    it("Reference to namespace based on a variable", async function () {
      const code = `
        export async function main(ns) {
          const stn = ns.stanek;
          stn.get(0, 0);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, RamCostConstants.ScriptStanekFragmentAt);
    });

    it("Reference to namespace based on a variable destructuring pattern", async function () {
      const code = `
        export async function main(ns) {
          const [stn,stn2] = [ns.stanek, ns.stanek];
          stn2.get(0, 0);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, RamCostConstants.ScriptStanekFragmentAt);
    });

    it("Calling a variable reference", async function () {
      const code = `
        export async function main(ns) {
          const stnGet = ns.stanek.get;
          stnGet(0, 0);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, RamCostConstants.ScriptStanekFragmentAt);
    });

    it("Calling a variable reference from another function", async function () {
      const code = `
        export async function main(ns) {
          returnNamespace(ns).get(0, 0);
        }

        function returnNamespace(ns) {
          return ns.stanek;
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, RamCostConstants.ScriptStanekFragmentAt);
    });

    it("Singularity functions with variable costs depending on the player", async function () {
      const code = `
        export async function main(ns) {
          ns.universityCourse("Summit University", "Networks");
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, RamCostConstants.ScriptSingularityFn1RamCost * 16);
    });
    it("DOM references", async function () {
      const code = `
        export async function main(ns) {
          document.getElementById("something");
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [])).cost;
      expectCost(calculated, RamCostConstants.ScriptDomRamCost);
    });
  });

  describe("Imported files", function () {
    it("Simple imported function with no cost", async function () {
      const libCode = `
        export function dummy() { return 0; }
      `;
      const lib = new Script(null, "libTest.js", libCode, []);

      const code = `
        import { dummy } from "libTest";
        export async function main(ns) {
          dummy();
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, 0);
    });

    it("Imported ns function", async function () {
      const libCode = `
        export async function doHack(ns) { return await ns.hack("joesguns"); }
      `;
      const lib = new Script(null, "libTest.js", libCode, []);

      const code = `
        import { doHack } from "libTest";
        export async function main(ns) {
          await doHack(ns);
        }
      `;

      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, HackCost);
    });

    it("Importing a single function from a library that exports multiple", async function () {
      const libCode = `
        export async function doHack(ns) { return await ns.hack("joesguns"); }
        export async function doGrow(ns) { return await ns.grow("joesguns"); }
      `;
      const lib = new Script(null, "libTest.js", libCode, []);

      const code = `
        import { doHack } from "libTest";
        export async function main(ns) {
          await doHack(ns);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, HackCost);
    });

    it("Importing all functions from a library that exports multiple", async function () {
      const libCode = `
        export async function doHack(ns) { return await ns.hack("joesguns"); }
        export async function doGrow(ns) { return await ns.grow("joesguns"); }
      `;
      const lib = new Script(null, "libTest.js", libCode, []);

      const code = `
        import * as test from "libTest";
        export async function main(ns) {
          await test.doHack(ns);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, HackCost);
    });

    it("Importing a function from a library that contains a class", async function () {
      const libCode = `
        export async function doHack(ns) { return await ns.hack("joesguns"); }
        class Grower {
          ns;
          constructor(ns) { this.ns = ns; }
          async doGrow() { return await this.ns.grow("joesguns"); }
        }
      `;
      const lib = new Script(null, "libTest.js", libCode, []);

      const code = `
        import * as test from "libTest";
        export async function main(ns) {
          await test.doHack(ns);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, HackCost);
    });

    it("Importing a function from a library that creates a class in a function", async function () {
        const libCode = `
          export function createClass() {
            class Grower {
              ns;
              constructor(ns) { this.ns = ns; }
              async doGrow() { return await this.ns.grow("joesguns"); }
            }
            return Grower;
          }
        `;
        const lib = new Script(null, "libTest.js", libCode, []);

        const code = `
          import { createClass } from "libTest";

          export async function main(ns) {
            const grower = createClass();
            const growerInstance = new grower(ns);
            await growerInstance.doGrow();
          }
        `;
        const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
        expectCost(calculated, GrowCost);
    });


    it("Imported function with NS defined in an attempt to confuse", async function () {
      const libTestCode = `
        export async function doHack(ns) { return await ns.hack("joesguns"); }
      `;
      const libTest = new Script(null, "libTest.js", libTestCode, []);

      const code = `
        import { doHack } from "libTest";
        export async function main2(ns) {
          await doHack(ns);
        }
      `;
      const libCode = new Script(null, "libCode.js", code, []);

      const initial = `
          import { main2 } from "libCode";
          export async function main(notNS) {
            const ns = {
              hack: () => 0,
              grow: () => 0
            };
            await main2(ns);
          }
      `;

      const calculated = (await calculateRamUsage(Player, initial, [libCode, libTest])).cost;
      expectCost(calculated, HackCost); // This is actually wrong, since the NS API hack is never called, but it's a reasonable mistake
    });

  });


  describe("Identifying imported modules", function () {
    it("Import specific functions from a library", async function () {
      const code = `
        import { dummy, dummy2 } from "libTest";
        export async function main(ns) {
          dummy();
        }
      `;
      const p = new NetscriptFileParser();
      const result = p.parseScript(code);
      expect(result.importedModules).toHaveLength(1);
      expect(result.importedModules[0].filePath).toEqual("libTest");
      expect(result.importedModules[0].alias).toEqual("");
      expect(result.importedModules[0].imports).toEqual(["dummy", "dummy2"]);
    });

    it("Import all functions from a library", async function () {
      const code = `
        import * as dummy from "libTest";
        export async function main(ns) {
          dummy.things();
        }
      `;
      const p = new NetscriptFileParser();
      const result = p.parseScript(code);
      expect(result.importedModules).toHaveLength(1);
      expect(result.importedModules[0].filePath).toEqual("libTest");
      expect(result.importedModules[0].alias).toEqual("dummy");
      expect(result.importedModules[0].imports).toEqual(["*"]);
    });

  });


  describe("Building a tree of called functions", function () {
    it("Find functions inside a single file and their called functions", async function () {
      const code = `
        export async function main(ns) {
          doHacking(ns);
        }
        async function doHacking(ns) {
          await ns.hack("joesguns");
        }
      `;
      const result = new NetscriptFileParser("").parseScript(code);
      expect(result.functionTree).toHaveLength(2);
      expect(result.functionTree.map(f => f.fn.name)).toEqual(["main", "doHacking"]);
      expect(result.functionTree[0].calledFunctions).toEqual([{ name: "doHacking", namespace: "", filePath: ""}]);
      expect(result.functionTree[1].calledFunctions).toEqual([{ name: "hack", namespace: "ns", filePath: ""}]);
    });

    it("Find functions and classes inside a single file and their called functions", async function () {
      const code = `
        export async function main(ns) {
          const c = new MyClass();
          c.doHacking(ns);
        }

        class MyClass {
          async doHacking(ns) {
            await ns.hack("joesguns");
          }
        }
      `;
      const result = new NetscriptFileParser("").parseScript(code);
      expect(result.functionTree).toHaveLength(2);
      expect(result.functionTree.map(f => f.fn.name)).toEqual(["main", "MyClass"]);
      expect(result.functionTree[0].calledFunctions).toEqual([{ name: "MyClass", namespace: "", filePath: ""}, { name: "doHacking", namespace: "c", filePath: ""}]);
      expect(result.functionTree[1].calledFunctions).toEqual([{ name: "hack", namespace: "ns", filePath: ""}]);
    });

    it("Find functions and classes inside a single file and their called functions", async function () {
      const libCode = `
        export async function doHack(ns) { return await ns.hack("joesguns"); }
        export async function doGrow(ns) { return await ns.grow("joesguns"); }
      `;
      const lib = new Script(null, "libTest.js", libCode, []);

      const code = `
        import { doHack } from "libTest";
        import { doGrow } from "libTest";
        export async function main(ns) {
          await doHack(ns);
        }
      `;
      const allParseResults = (await new InvocationTreeBuilder().parseAll(code, [lib]));
      expect(allParseResults).toHaveLength(2);
      expect(allParseResults.map(r => r.filePath)).toEqual(["", "libTest"]);
      expect(allParseResults[1].functionTree.map(f => f.fn.name)).toEqual(["doHack", "doGrow"]);
      expect(allParseResults[1].functionTree.flatMap(f => f.calledFunctions.map(cf => cf.name))).toEqual(["hack", "grow"]);
    });

    it("Find all called functions from the entry point", async function () {
      const libCode = `
        export async function doHack(ns) { return await ns.hack("joesguns"); }
        export async function doGrow(ns) { return await ns.grow("joesguns"); }
      `;
      const lib = new Script(null, "libTest.js", libCode, []);

      const code = `
        import { doHack } from "libTest";
        import { doGrow } from "libTest";
        export async function main(ns) {
          await doHack(ns);
        }
      `;
      const allParseResults = (await new InvocationTreeBuilder().parseAll(code, [lib]));
      const allCalledFunctions = findAllCalledFunctions(allParseResults);
      expect(allCalledFunctions.resolvedFunctions).toHaveLength(2);
      expect(allCalledFunctions.unresolvedFunctions).toHaveLength(1);
      expect(allCalledFunctions.resolvedFunctions.map(r => r.name)).toEqual(["main", "doHack"]);
      expect(allCalledFunctions.unresolvedFunctions.map(r => r.name)).toEqual(["hack"]);
    });

  });


  describe("Single files with import exported NS api namespaces", function () {
    it("Exporting an api to be used in another file", async function () {
      const libCode = `
        export async function anExport(ns) { return ns.stanek }
      `;
      const lib = new Script(Player, "libTest.js", libCode, []);

      const code = `
        import {anExport} from "libTest.js";
        export async function main(ns) {
          await anExport(ns).get;
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, StanekGetCost);
    });

    it("Exporting api methods to be used in another file", async function () {
      const libCode = `
        export async function anExport(ns) { return ns.stanek.get }
        export async function anotherExport(ns) { return ns.stanek.width }
      `;
      const lib = new Script(Player, "libTest.js", libCode, []);

      const code = `
        import {anExport, anotherExport} from "libTest.js";
        export async function main(ns) {
          await anExport(ns);
          await anotherExport(ns);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, StanekGetCost + StanekWidthCost);
    });

    it("Exporting api methods selectively import in another file", async function () {
      const libCode = `
        export async function anExport(ns) { return ns.stanek.get }
        export async function anotherExport(ns) { return ns.stanek.width }
      `;
      const lib = new Script(Player, "libTest.js", libCode, []);

      const code = `
        import {anExport} from "libTest.js";
        export async function main(ns) {
          await anExport(ns);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, StanekGetCost);
    });

    it("Exporting all methods as a variable to be used in another file", async function () {
      const libCode = `
        export async function anExport(ns) { return ns.stanek.get }
        export async function anotherExport(ns) { return ns.stanek.width }
      `;
      const lib = new Script(Player, "libTest.js", libCode, []);

      const code = `
        import libTest from "libTest.js";
        export async function main(ns) {
          await libTest.anExport(ns);
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, StanekGetCost + StanekWidthCost);
    });

    it("Exporting api import as variable another file", async function () {
      const libCode = `
        export async function anExport(ns) { return ns.stanek }
      `;
      const lib = new Script(Player, "libTest.js", libCode, []);

      const code = `
        import libTest from "libTest.js";
        export async function main(ns) {
          await libTest.anExport(ns).get;
        }
      `;
      const calculated = (await calculateRamUsage(Player, code, [lib])).cost;
      expectCost(calculated, StanekGetCost);
    });
  });

});
