import type { ts } from "ts-morph"

/** The compiler options of the tsconfig nearest `from`, over the bundler resolution comb reads TypeScript files with */
export declare function compilerOptionsFor(from: string): ts.CompilerOptions

/** Whether `file` may run as CommonJS: a .cjs or .cts file, or one whose nearest package.json names no "type": "module" */
export declare function isCommonJs(file: string): boolean

/** Whether node runs `file`, holding `source`, as CommonJS, as it decides under type stripping (F54) */
export declare function runsAsCommonJs(file: string, source: string): boolean

/** The module `fileName` transpiles to under its tsconfig, an ES module unless `module` says otherwise */
export declare function transpiled(fileName: string, module?: ts.ModuleKind): string
