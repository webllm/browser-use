import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve('src');

const isWithinSourceRoot = (filePath: string) => {
  const relativePath = path.relative(SOURCE_ROOT, filePath);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
};

const pathExists = async (filePath: string) => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const resolveSourceImport = async (
  importerPath: string,
  specifier: string
): Promise<string | null> => {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const resolvedPath = path.resolve(path.dirname(importerPath), specifier);
  const extension = path.extname(resolvedPath);
  const withoutRuntimeExtension = ['.js', '.mjs', '.cjs'].includes(extension)
    ? resolvedPath.slice(0, -extension.length)
    : resolvedPath;
  const candidates = [
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    path.join(resolvedPath, 'index.ts'),
  ];

  for (const candidate of candidates) {
    if (isWithinSourceRoot(candidate) && (await pathExists(candidate))) {
      return candidate;
    }
  }
  return null;
};

const readStaticSourceImports = async (filePath: string) => {
  const sourceText = await fs.readFile(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  const resolvedImports = await Promise.all(
    specifiers.map((specifier) => resolveSourceImport(filePath, specifier))
  );
  return resolvedImports.filter((value): value is string => value !== null);
};

const getStaticImportClosure = async (entryPath: string) => {
  const pending = [path.resolve(entryPath)];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);
    pending.push(...(await readStaticSourceImports(currentPath)));
  }

  return [...visited]
    .map((filePath) => path.relative(SOURCE_ROOT, filePath))
    .sort();
};

describe('lightweight command architecture boundaries', () => {
  it('keeps help and version bootstrap isolated from the full CLI graph', async () => {
    await expect(getStaticImportClosure('src/cli-entry.ts')).resolves.toEqual([
      'cli-entry.ts',
      'cli-usage.ts',
      'entrypoint.ts',
    ]);
  });

  it('keeps skill installation independent from browser and agent modules', async () => {
    await expect(
      getStaticImportClosure('src/skills/install.ts')
    ).resolves.toEqual(['skills/install.ts']);
  });

  it('keeps the direct CLI MCP server outside the autonomous agent stack', async () => {
    const closure = await getStaticImportClosure('src/mcp/cli-server.ts');
    const forbiddenPrefixes = ['agent/', 'controller/', 'llm/', 'tools/'];
    const forbiddenFiles = new Set([
      'mcp/client.ts',
      'mcp/controller.ts',
      'mcp/server.ts',
    ]);
    const violations = closure.filter(
      (filePath) =>
        forbiddenFiles.has(filePath) ||
        forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix))
    );

    expect(violations).toEqual([]);
    expect(closure).toContain('skill-cli/direct.ts');
    expect(closure).toContain('browser/session.ts');
  });
});
