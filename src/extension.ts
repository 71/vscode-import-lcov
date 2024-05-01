import * as vscode from "vscode";
import parseLcov, { SectionSummary } from "@friedemannsommer/lcov-parser";
import { loadDemangle } from "./demangle";

interface Configuration {
  lcovFiles: string[];
}

export function activate(context: vscode.ExtensionContext) {
  // Test controller.
  // -----
  const controller = vscode.tests.createTestController(
    "import-lcov",
    "Import LCOV",
  );
  context.subscriptions.push(controller);

  let currentRefreshCts = new vscode.CancellationTokenSource();
  let configuration: Configuration = { lcovFiles: [] };

  const refreshTests = async () => {
    currentRefreshCts.cancel();
    currentRefreshCts = new vscode.CancellationTokenSource();

    const token = currentRefreshCts.token;

    const lcovFiles = await Promise.all(
      configuration.lcovFiles.map((glob) =>
        vscode.workspace.findFiles(
          glob,
          undefined,
          undefined,
          token,
        )
      ),
    ).then((files) => files.flat().sort());

    const items = lcovFiles.map((lcovFile) => {
      return controller.createTestItem(
        /*id=*/ lcovFile.toString(),
        /*label=*/ vscode.workspace.asRelativePath(lcovFile),
        lcovFile,
      );
    });

    controller.items.replace(items);
  };

  controller.refreshHandler = refreshTests;

  // Configuration.
  // -----
  const fileSystemWatchers = new Map<string, vscode.FileSystemWatcher>();

  const refreshConfiguration = () => {
    let lcovFiles = vscode.workspace.getConfiguration("import-lcov").get<
      string | string[]
    >("lcovFiles") ?? [];

    if (typeof lcovFiles === "string") {
      lcovFiles = [lcovFiles];
    }

    const activeConfig: Configuration = { lcovFiles };

    if (JSON.stringify(activeConfig) === JSON.stringify(configuration)) {
      return;
    }

    configuration = activeConfig;

    // Recreate file system watchers.
    const watchersToRemove = new Set(fileSystemWatchers.keys());

    for (const lcovFile of lcovFiles) {
      if (watchersToRemove.delete(lcovFile)) {
        // Already watching this glob.
        continue;
      }

      const watcher = vscode.workspace.createFileSystemWatcher(
        lcovFile,
        /*ignoreCreateEvents*/ false,
        /*ignoreChangeEvents*/ true,
        /*ignoreDeleteEvents*/ false,
      );

      watcher.onDidCreate(refreshTests);
      watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

      fileSystemWatchers.set(lcovFile, watcher);
    }

    for (const lcovFile of watchersToRemove) {
      fileSystemWatchers.get(lcovFile)!.dispose();
      fileSystemWatchers.delete(lcovFile);
    }

    refreshTests();
  };

  refreshConfiguration();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("import-lcov")) {
        refreshConfiguration();
      }
    }),
    {
      dispose() {
        for (const watcher of fileSystemWatchers.values()) {
          watcher.dispose();
        }

        fileSystemWatchers.clear();
      },
    },
  );

  // Test runs.
  // -----

  const testRunData = new WeakMap<vscode.FileCoverage, SectionSummary>();
  const coverageProfile = controller.createRunProfile(
    "Coverage",
    vscode.TestRunProfileKind.Coverage,
    async (request, token) => {
      const run = controller.createTestRun(
        request,
        /*name=*/ undefined,
        /*persist=*/ false,
      );

      // Compute items whose coverage should be processed.
      const items = new Set(request.include);

      if (items.size === 0) {
        for (const [, item] of controller.items) {
          items.add(item);
        }
      }

      for (const item of request.exclude ?? []) {
        items.delete(item);
      }

      // Read and update coverage.
      await Promise.all([...items].map(async (item) => {
        const uri = item.uri!;
        const contents = await vscode.workspace.fs.readFile(uri);

        if (token.isCancellationRequested) {
          return;
        }

        const sections = await parseLcov({ from: contents });

        if (token.isCancellationRequested) {
          return;
        }

        for (const section of sections) {
          let path: vscode.Uri | undefined;

          for (
            const workspaceFolder of vscode.workspace.workspaceFolders ?? []
          ) {
            const workspacePath = workspaceFolder.uri.fsPath;

            if (section.path.startsWith(workspacePath)) {
              path = vscode.Uri.joinPath(
                workspaceFolder.uri,
                section.path.substring(workspacePath.length + 1 /* / */),
              );
              break;
            }
          }

          const fileCoverage = new vscode.FileCoverage(
            path ?? vscode.Uri.file(section.path),
            /*statementCoverage=*/ new vscode.TestCoverageCount(
              section.lines.hit,
              section.lines.instrumented,
            ),
            /*branchCoverage=*/ new vscode.TestCoverageCount(
              section.branches.hit,
              section.branches.instrumented,
            ),
            /*declarationCoverage=*/ new vscode.TestCoverageCount(
              section.functions.hit,
              section.functions.instrumented,
            ),
          );

          testRunData.set(fileCoverage, section);
          run.addCoverage(fileCoverage);
        }
      }));

      run.end();
    },
  );

  let demangle:
    | undefined
    | Promise<{ (mangled: string): string }>
    | { (mangled: string): string };

  coverageProfile.loadDetailedCoverage = async (_, fileCoverage) => {
    const section = testRunData.get(fileCoverage);

    if (section === undefined) {
      return [];
    }

    const details: vscode.FileCoverageDetail[] = [];
    const branchesByLine = new Map<
      number,
      Record<string, vscode.BranchCoverage>
    >();

    for (const branch of section.branches.details) {
      const branches = branchesByLine.get(branch.line) ?? {};

      branches[branch.branch] ??= new vscode.BranchCoverage(
        0,
        new vscode.Position(branch.line - 1, 0),
        branch.branch,
      );
      (branches[branch.branch].executed as number) += branch.hit;

      branchesByLine.set(branch.line, branches);
    }

    for (const line of section.lines.details) {
      details.push(
        new vscode.StatementCoverage(
          line.hit,
          new vscode.Position(line.line - 1, 0),
          Object.values(branchesByLine.get(line.line) ?? {}),
        ),
      );
    }

    for (const fn of section.functions.details) {
      if (fn.name.length === 0) {
        continue;
      }

      let name = fn.name;

      if (/^_{1,3}Z/.test(name)) {
        if (demangle === undefined) {
          demangle = loadDemangle(context);
          demangle = await demangle;
        } else if (demangle instanceof Promise) {
          demangle = await demangle;
        }

        name = demangle(name);
      }

      details.push(
        new vscode.DeclarationCoverage(
          name,
          fn.hit,
          new vscode.Position(fn.line - 1, 0),
        ),
      );
    }

    return details;
  };
}

export function deactivate() {
  // Nop.
}
