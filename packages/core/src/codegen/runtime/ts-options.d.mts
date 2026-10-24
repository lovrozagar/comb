import type { ts } from "ts-morph"

/** The compiler options of the tsconfig nearest `from`, over the bundler resolution comb reads TypeScript files with */
export declare function compilerOptionsFor(from: string): ts.CompilerOptions

/** The ES module `fileName` transpiles to under its tsconfig, as bun and the node hook run it */
export declare function transpiled(fileName: string): string
