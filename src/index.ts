// src/TS-ES-Node.ts
import { promises as fs } from 'fs';
import globby from 'globby';
import { ResolvedModule } from 'module';
import path from 'path';
import ts from 'typescript';
import { pathToFileURL, URL, fileURLToPath } from 'url';
import { SourceTextModule, SyntheticModule, createContext } from 'vm';
import { setRootPath, getTSConfig } from './Utils';
import { createTSError } from './TypeScriptError';

const baseURL = pathToFileURL(process.cwd()).href;

/**
 * Array of TypeScript file extensions. This is also used to find imported TypeScript files since for some reason
 * the extension can't be inferred by Node.JS' Resolver.
 */
const TS_EXTENSIONS = ['.ts', '.tsx'];

const moduleMap: Map<string, SourceTextModule> = new Map();

const moduleContext = createContext(global);

/**
 * Transpiles TypeScript source and loads the result ESNext code into the Node.JS VM
 * @param sourcePathURLString Node.JS URL field for the source TypeScript file
 * @returns Node.JS Experimental SourceTextModule with the resulting ESNext code
 */
async function transpileTypeScriptToModule(
  sourcePathURLString: string,
): Promise<SourceTextModule> {
  const sourceFileURL = new URL(sourcePathURLString);
  const sourceFilePath = fileURLToPath(sourceFileURL);

  const sourceFile = await fs.readFile(sourceFileURL);

  setRootPath(path.dirname(sourceFilePath));

  const tsConfig = await getTSConfig(path.dirname(sourceFilePath));

  const compilerOptions: ts.CompilerOptions = {
    ...tsConfig,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  };

  const program = ts.createProgram([sourceFilePath], {
    ...compilerOptions,
    typeRoots: [],
  });
  const diagnostics = await ts.getPreEmitDiagnostics(program);

  // TypeScript code transpiled into ESNext.
  let transpiledModule = ts.transpileModule(sourceFile.toString(), {
    compilerOptions,
    reportDiagnostics: true,
  });

  if (diagnostics.length) throw createTSError(diagnostics);

  /**
   * Using the NodeJS Experimental Modules we can convert the ESNext source into an ESModule
   * and load it into the VM Context
   * @see https://nodejs.org/api/vm.html#vm_class_vm_sourcetextmodule
   */

  const sourceTextModule = new SourceTextModule(transpiledModule.outputText, {
    async importModuleDynamically(specifier, parentModule) {
      const dynamicModule = await linker(specifier, parentModule);
      if ('link' in dynamicModule) await dynamicModule.link(linker);

      return dynamicModule;
    },
    initializeImportMeta(meta) {
      meta.url = sourcePathURLString;
    },
    context: moduleContext,
  });

  /**
   * We need to ensure the source path of the sourceTextModule is the path of the
   * TypeScript source import for static and dynamic imports from the VM Module
   */
  sourceTextModule.url = sourcePathURLString;

  return sourceTextModule;
}

async function linker(
  specifier: string,
  parentModule: { url: string },
): Promise<SourceTextModule | SyntheticModule> {
  const { format, url } = await resolve(specifier, parentModule.url);

  /**
   * If the import is not TypeScript ("Dynamic sortof")
   */
  if (format === 'commonjs' || format === 'module') {
    let link = await import(url);
    if (link.default) link = { ...link.default, ...link };

    const linkKeys = Object.keys(link);

    return new SyntheticModule(
      linkKeys,
      async function() {
        for (const linkKey of linkKeys) this.setExport(linkKey, link[linkKey]);
      },
      { context: moduleContext },
    );
  } else if (format === 'dynamic') {
    if (moduleMap.has(url)) {
      const cachedModule = moduleMap.get(url);
      return cachedModule!;
    }

    const newModule = await transpileTypeScriptToModule(url);
    moduleMap.set(url, newModule);

    return newModule;
  } else throw new Error('INVALID Import type');
}

export async function dynamicInstantiate(url: string) {
  try {
    const sourceTextModule = await transpileTypeScriptToModule(url);

    // Ensure all imports are loaded into the context
    await sourceTextModule.link(linker);

    return {
      exports: [],
      execute: () => sourceTextModule.evaluate(),
    };
  } catch (err) {
    console.error(err);
    process.exit(0);
  }
}

/**
 * This is a Node.JS ESM Experimental loading gook
 * @param specifier Pa
 * @param parentModuleURL
 * @param defaultResolverFn
 */
export async function resolve(
  specifier: string,
  parentModuleURL: string = baseURL,
  defaultResolverFn?: Function,
): Promise<ResolvedModule> {
  const modTester = new RegExp('^.{0,2}[/]');

  if (!modTester.test(specifier) && !specifier.startsWith('file:')) {
    if (defaultResolverFn) return defaultResolverFn(specifier, parentModuleURL);

    return {
      format: 'module',
      url: specifier,
    };
  }

  const resolved = new URL(specifier, parentModuleURL);
  let ext = path.extname(resolved.pathname);

  if (ext === '' && resolved.protocol === 'file:') {
    const possibleFiles = await globby(
      `${specifier}{${TS_EXTENSIONS.join(',')}}`,
      {
        cwd: path.dirname(fileURLToPath(parentModuleURL)),
        absolute: true,
      },
    );

    if (possibleFiles.length === 1) {
      return {
        url: `file://${possibleFiles[0]}`,
        format: 'dynamic',
      };
    }
  }

  if (TS_EXTENSIONS.includes(ext)) {
    return {
      format: 'dynamic',
      url: resolved.href,
    };
  }

  return {
    url: resolved.href,
    format: 'module',
  };
}
