import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = process.cwd();

function getPublicSpecifiers(repoRoot) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const packageName = packageJson.name;
  const exportsMap = packageJson.exports;

  if (typeof packageName !== 'string' || !packageName) {
    throw new Error('package.json must define a package name.');
  }
  if (!exportsMap || typeof exportsMap !== 'object') {
    throw new Error('package.json must define an exports map.');
  }

  return Object.keys(exportsMap)
    .filter((subpath) => subpath !== './package.json' && !subpath.includes('*'))
    .map((subpath) =>
      subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`
    )
    .sort();
}

const publicSpecifiers = getPublicSpecifiers(repoRoot);

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stdout = error.stdout?.toString() ?? '';
    const stderr = error.stderr?.toString() ?? '';
    throw new Error(
      `Command failed: ${cmd} ${args.join(' ')}\n${stdout}\n${stderr}`.trim()
    );
  }
}

function assertPackagedFileMatches(
  repoRoot,
  installedPackageDir,
  sourcePath,
  packagedPath
) {
  const absoluteSourcePath = path.join(repoRoot, sourcePath);
  const absolutePackagedPath = path.join(installedPackageDir, packagedPath);

  if (!fs.existsSync(absolutePackagedPath)) {
    throw new Error(
      `Packaged asset is missing: ${packagedPath} (expected from ${sourcePath})`
    );
  }

  const sourceContents = fs.readFileSync(absoluteSourcePath, 'utf8');
  const packagedContents = fs.readFileSync(absolutePackagedPath, 'utf8');
  if (sourceContents !== packagedContents) {
    throw new Error(
      `Packaged asset does not match source: ${packagedPath} (expected from ${sourcePath})`
    );
  }
}

function assertPackagedAssets(repoRoot, installedPackageDir) {
  assertPackagedFileMatches(
    repoRoot,
    installedPackageDir,
    'src/dom/dom_tree/index.js',
    'dist/dom/dom_tree/index.js'
  );

  const agentSourceDir = path.join(repoRoot, 'src/agent');
  const agentPromptTemplates = fs
    .readdirSync(agentSourceDir)
    .filter((file) => file.endsWith('.md'))
    .sort();

  if (agentPromptTemplates.length === 0) {
    throw new Error(`No agent prompt templates found in ${agentSourceDir}`);
  }

  for (const templateName of agentPromptTemplates) {
    assertPackagedFileMatches(
      repoRoot,
      installedPackageDir,
      path.join('src/agent', templateName),
      path.join('dist/agent', templateName)
    );
  }
}

function runPackagedBin(tempDir, binName, args) {
  const binPath = path.join(
    tempDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${binName}.cmd` : binName
  );

  if (process.platform === 'win32') {
    return run(
      'cmd',
      ['/d', '/s', '/c', `"${binPath}" ${args.join(' ')}`],
      tempDir
    );
  }

  return run(binPath, args, tempDir);
}

function assertPackagedBins(tempDir) {
  const help = runPackagedBin(tempDir, 'browser-use', ['--help']);
  if (!help.includes('Usage:') || !help.includes('browser-use --mcp')) {
    throw new Error(
      'Packaged browser-use binary did not print its help output.'
    );
  }

  const directHelp = runPackagedBin(tempDir, 'browser-use-direct', ['--help']);
  if (!directHelp.includes('Usage: browser-use-direct <command> [args]')) {
    throw new Error(
      'Packaged browser-use-direct binary did not print its help output.'
    );
  }
}

let tempDir = null;
let tarballPath = null;

try {
  const tarballName = run('npm', ['pack', '--silent'], repoRoot)
    .split('\n')
    .filter(Boolean)
    .at(-1);

  if (!tarballName) {
    throw new Error('npm pack did not return a tarball name.');
  }

  tarballPath = path.join(repoRoot, tarballName);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-pack-smoke-'));

  fs.writeFileSync(
    path.join(tempDir, 'package.json'),
    JSON.stringify({ name: 'browser-use-pack-smoke', private: true }, null, 2)
  );

  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    tempDir
  );

  const installedPackageDir = path.join(tempDir, 'node_modules', 'browser-use');
  const tempRequire = createRequire(path.join(tempDir, 'package.json'));
  const failures = [];

  for (const specifier of publicSpecifiers) {
    try {
      const resolved = tempRequire.resolve(specifier);
      console.log(`ok ${specifier} -> ${resolved}`);
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : '';
      const message =
        error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : String(error);
      failures.push(`${specifier}: ${code} ${message}`.trim());
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Public exports smoke test failed for ${failures.length} specifier(s):\n${failures.join('\n')}`
    );
  }

  assertPackagedAssets(repoRoot, installedPackageDir);
  assertPackagedBins(tempDir);

  console.log(
    `Pack smoke test passed for ${publicSpecifiers.length} public specifiers.`
  );
} finally {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (tarballPath) {
    fs.rmSync(tarballPath, { force: true });
  }
}
