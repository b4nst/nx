import { exec } from 'child_process';
import * as minimatch from 'minimatch';
import {
  FileData,
  ProjectFileMap,
  ProjectGraph,
  ProjectGraphDependency,
  ProjectGraphProjectNode,
} from '../config/project-graph';
import { NxJsonConfiguration } from '../config/nx-json';
import { Task } from '../config/task-graph';
import { InputDefinition } from '../config/workspace-json-project-json';
import { hashTsConfig } from '../plugins/js/hasher/hasher';
import { DaemonClient } from '../daemon/client/client';
import { FileHasher } from './impl/file-hasher-base';
import { hashArray } from './impl';
import { createProjectRootMappings } from '../project-graph/utils/find-project-for-path';

type ExpandedSelfInput =
  | { fileset: string }
  | { runtime: string }
  | { env: string }
  | { externalDependencies: string[] };

/**
 * A data structure returned by the default hasher.
 */
export interface PartialHash {
  value: string;
  details: {
    [name: string]: string;
  };
}

/**
 * A data structure returned by the default hasher.
 */
export interface Hash {
  value: string;
  details: {
    command: string;
    nodes: { [name: string]: string };
    implicitDeps?: { [fileName: string]: string };
    runtime?: { [input: string]: string };
  };
}

export interface TaskHasher {
  hashTask(task: Task): Promise<Hash>;
  hashTasks(tasks: Task[]): Promise<Hash[]>;
}

export type Hasher = TaskHasher;

export class DaemonBasedTaskHasher implements TaskHasher {
  constructor(
    private readonly daemonClient: DaemonClient,
    private readonly runnerOptions: any
  ) {}

  async hashTasks(tasks: Task[]): Promise<Hash[]> {
    return this.daemonClient.hashTasks(this.runnerOptions, tasks);
  }

  async hashTask(task: Task): Promise<Hash> {
    return (await this.daemonClient.hashTasks(this.runnerOptions, [task]))[0];
  }
}

export class InProcessTaskHasher implements TaskHasher {
  static version = '3.0';
  private taskHasher: TaskHasherImpl;

  constructor(
    private readonly projectFileMap: ProjectFileMap,
    private readonly allWorkspaceFiles: FileData[],
    private readonly projectGraph: ProjectGraph,
    private readonly nxJson: NxJsonConfiguration,
    private readonly options: any,
    private readonly fileHasher: FileHasher
  ) {
    const legacyRuntimeInputs = (
      this.options && this.options.runtimeCacheInputs
        ? this.options.runtimeCacheInputs
        : []
    ).map((r) => ({ runtime: r }));

    if (process.env.NX_CLOUD_ENCRYPTION_KEY) {
      legacyRuntimeInputs.push({ env: 'NX_CLOUD_ENCRYPTION_KEY' });
    }

    const legacyFilesetInputs = [
      'nx.json',

      // ignore files will change the set of inputs to the hasher
      '.gitignore',
      '.nxignore',
    ].map((d) => ({ fileset: `{workspaceRoot}/${d}` }));

    this.taskHasher = new TaskHasherImpl(
      nxJson,
      legacyRuntimeInputs,
      legacyFilesetInputs,
      this.projectFileMap,
      this.allWorkspaceFiles,
      this.projectGraph,
      this.fileHasher,
      { selectivelyHashTsConfig: this.options.selectivelyHashTsConfig ?? false }
    );
  }

  async hashTasks(tasks: Task[]): Promise<Hash[]> {
    return await Promise.all(tasks.map((t) => this.hashTask(t)));
  }

  async hashTask(task: Task): Promise<Hash> {
    const res = await this.taskHasher.hashTask(task, [task.target.project]);
    const command = this.hashCommand(task);
    return {
      value: hashArray([res.value, command]),
      details: {
        command,
        nodes: res.details,
        implicitDeps: {},
        runtime: {},
      },
    };
  }

  private hashCommand(task: Task): string {
    const overrides = { ...task.overrides };
    delete overrides['__overrides_unparsed__'];
    const sortedOverrides = {};
    for (let k of Object.keys(overrides).sort()) {
      sortedOverrides[k] = overrides[k];
    }

    return hashArray([
      task.target.project ?? '',
      task.target.target ?? '',
      task.target.configuration ?? '',
      JSON.stringify(sortedOverrides),
    ]);
  }
}

const DEFAULT_INPUTS: ReadonlyArray<InputDefinition> = [
  {
    fileset: '{projectRoot}/**/*',
  },
  {
    dependencies: true,
    input: 'default',
  },
];

class TaskHasherImpl {
  private filesetHashes: {
    [taskId: string]: Promise<PartialHash>;
  } = {};
  private runtimeHashes: {
    [runtime: string]: Promise<PartialHash>;
  } = {};
  private externalDepsHashCache: { [packageName: string]: PartialHash } = {};
  private projectRootMappings = createProjectRootMappings(
    this.projectGraph.nodes
  );

  constructor(
    private readonly nxJson: NxJsonConfiguration,
    private readonly legacyRuntimeInputs: { runtime: string }[],
    private readonly legacyFilesetInputs: { fileset: string }[],
    private readonly projectFileMap: ProjectFileMap,
    private readonly allWorkspaceFiles: FileData[],
    private readonly projectGraph: ProjectGraph,
    private readonly fileHasher: FileHasher,
    private readonly options: { selectivelyHashTsConfig: boolean }
  ) {}

  async hashTask(task: Task, visited: string[]): Promise<PartialHash> {
    return Promise.resolve().then(async () => {
      const projectNode = this.projectGraph.nodes[task.target.project];
      if (!projectNode) {
        return this.hashExternalDependency(task.target.project);
      }
      const namedInputs = getNamedInputs(this.nxJson, projectNode);
      const targetData = projectNode.data.targets[task.target.target];
      const targetDefaults = (this.nxJson.targetDefaults || {})[
        task.target.target
      ];
      const { selfInputs, depsInputs, projectInputs } =
        splitInputsIntoSelfAndDependencies(
          targetData.inputs ||
            targetDefaults?.inputs ||
            (DEFAULT_INPUTS as any),
          namedInputs
        );

      const selfAndInputs = await this.hashSelfAndDepsInputs(
        task.target.project,
        selfInputs,
        depsInputs,
        projectInputs,
        visited
      );

      const target = this.hashTarget(
        task.target.project,
        task.target.target,
        selfInputs
      );
      if (target) {
        return {
          value: hashArray([selfAndInputs.value, target.value]),
          details: { ...selfAndInputs.details, ...target.details },
        };
      }
      return selfAndInputs;
    });
  }

  private async hashNamedInputForDependencies(
    projectName: string,
    namedInput: string,
    visited: string[]
  ): Promise<PartialHash> {
    const projectNode = this.projectGraph.nodes[projectName];
    if (!projectNode) {
      return this.hashExternalDependency(projectName);
    }
    const namedInputs = {
      default: [{ fileset: '{projectRoot}/**/*' }],
      ...this.nxJson.namedInputs,
      ...projectNode.data.namedInputs,
    };

    const selfInputs = expandNamedInput(namedInput, namedInputs);
    const depsInputs = [{ input: namedInput, dependencies: true as true }]; // true is boolean by default
    return this.hashSelfAndDepsInputs(
      projectName,
      selfInputs,
      depsInputs,
      [],
      visited
    );
  }

  private async hashSelfAndDepsInputs(
    projectName: string,
    selfInputs: ExpandedSelfInput[],
    depsInputs: { input: string; dependencies: true }[],
    projectInputs: { input: string; projects: string[] }[],
    visited: string[]
  ) {
    const projectGraphDeps = this.projectGraph.dependencies[projectName] ?? [];
    // we don't want random order of dependencies to change the hash
    projectGraphDeps.sort((a, b) => a.target.localeCompare(b.target));

    const self = await this.hashSingleProjectInputs(projectName, selfInputs);
    const deps = await this.hashDepsInputs(
      depsInputs,
      projectGraphDeps,
      visited
    );
    const projects = await this.hashProjectInputs(projectInputs, visited);

    let details = {};
    for (const s of self) {
      details = { ...details, ...s.details };
    }
    for (const s of deps) {
      details = { ...details, ...s.details };
    }
    for (const s of projects) {
      details = { ...details, ...s.details };
    }

    const value = hashArray([
      ...self.map((d) => d.value),
      ...deps.map((d) => d.value),
      ...projects.map((d) => d.value),
    ]);

    return { value, details };
  }

  private async hashDepsInputs(
    inputs: { input: string }[],
    projectGraphDeps: ProjectGraphDependency[],
    visited: string[]
  ): Promise<PartialHash[]> {
    return (
      await Promise.all(
        inputs.map(async (input) => {
          return await Promise.all(
            projectGraphDeps.map(async (d) => {
              if (visited.indexOf(d.target) > -1) {
                return null;
              } else {
                visited.push(d.target);
                return await this.hashNamedInputForDependencies(
                  d.target,
                  input.input || 'default',
                  visited
                );
              }
            })
          );
        })
      )
    )
      .flat()
      .filter((r) => !!r);
  }

  private hashExternalDependency(
    projectName: string,
    visited = new Set<string>()
  ): PartialHash {
    // try to retrieve the hash from cache
    if (this.externalDepsHashCache[projectName]) {
      return this.externalDepsHashCache[projectName];
    }
    visited.add(projectName);
    const node = this.projectGraph.externalNodes[projectName];
    let partialHash;
    if (node) {
      let hash;
      if (node.data.hash) {
        // we already know the hash of this dependency
        hash = node.data.hash;
      } else {
        // we take version as a hash
        hash = node.data.version;
      }
      // we want to calculate the hash of the entire dependency tree
      const partialHashes: PartialHash[] = [];
      if (this.projectGraph.dependencies[projectName]) {
        this.projectGraph.dependencies[projectName].forEach((d) => {
          if (!visited.has(d.target)) {
            partialHashes.push(this.hashExternalDependency(d.target, visited));
          }
        });
      }
      partialHash = {
        value: hashArray([hash, ...partialHashes.map((p) => p.value)]),
        details: {
          [projectName]: hash,
          ...partialHashes.reduce((m, c) => ({ ...m, ...c.details }), {}),
        },
      };
    } else {
      // unknown dependency
      // this may occur if dependency is not an npm package
      // but rather symlinked in node_modules or it's pointing to a remote git repo
      // in this case we have no information about the versioning of the given package
      partialHash = {
        value: `__${projectName}__`,
        details: {
          [projectName]: `__${projectName}__`,
        },
      };
    }
    this.externalDepsHashCache[projectName] = partialHash;
    return partialHash;
  }

  private hashTarget(
    projectName: string,
    targetName: string,
    selfInputs: ExpandedSelfInput[]
  ): PartialHash {
    const projectNode = this.projectGraph.nodes[projectName];
    const target = projectNode.data.targets[targetName];

    if (!target) {
      return;
    }

    // we can only vouch for @nx packages's executor dependencies
    // if it's "run commands" or third-party we skip traversing since we have no info what this command depends on
    if (
      target.executor.startsWith(`@nrwl/`) ||
      target.executor.startsWith(`@nx/`)
    ) {
      const executorPackage = target.executor.split(':')[0];
      const executorNodeName =
        this.findExternalDependencyNodeName(executorPackage);
      return this.hashExternalDependency(executorNodeName);
    }

    // use command external dependencies if available to construct the hash
    const partialHashes: PartialHash[] = [];
    let hasCommandExternalDependencies = false;
    for (const input of selfInputs) {
      if (input['externalDependencies']) {
        // if we have externalDependencies with empty array we still want to override the default hash
        hasCommandExternalDependencies = true;
        const externalDependencies = input['externalDependencies'];
        for (let dep of externalDependencies) {
          dep = this.findExternalDependencyNodeName(dep);
          partialHashes.push(this.hashExternalDependency(dep));
        }
      }
    }
    if (hasCommandExternalDependencies) {
      return {
        value: hashArray(partialHashes.map((h) => h.value)),
        details: partialHashes.reduce(
          (acc, c) => ({ ...acc, ...c.details }),
          {}
        ),
      };
    }

    const hash = hashArray([JSON.stringify(this.projectGraph.externalNodes)]);
    return {
      value: hash,
      details: {
        [projectNode.name]: target.executor,
      },
    };
  }

  private findExternalDependencyNodeName(packageName: string): string {
    if (this.projectGraph.externalNodes[packageName]) {
      return packageName;
    }
    if (this.projectGraph.externalNodes[`npm:${packageName}`]) {
      return `npm:${packageName}`;
    }
    for (const node of Object.values(this.projectGraph.externalNodes)) {
      if (node.data.packageName === packageName) {
        return node.name;
      }
    }
    // not found, just return the package name
    return packageName;
  }

  private async hashSingleProjectInputs(
    projectName: string,
    inputs: ExpandedSelfInput[]
  ): Promise<PartialHash[]> {
    const filesets = extractPatternsFromFileSets(inputs);

    const projectFilesets = [];
    const workspaceFilesets = [];
    let invalidFilesetNoPrefix = null;
    let invalidFilesetWorkspaceRootNegative = null;

    for (let f of filesets) {
      if (f.startsWith('{projectRoot}/') || f.startsWith('!{projectRoot}/')) {
        projectFilesets.push(f);
      } else if (
        f.startsWith('{workspaceRoot}/') ||
        f.startsWith('!{workspaceRoot}/')
      ) {
        workspaceFilesets.push(f);
      } else {
        invalidFilesetNoPrefix = f;
      }
    }

    if (invalidFilesetNoPrefix) {
      throw new Error(
        [
          `"${invalidFilesetNoPrefix}" is an invalid fileset.`,
          'All filesets have to start with either {workspaceRoot} or {projectRoot}.',
          'For instance: "!{projectRoot}/**/*.spec.ts" or "{workspaceRoot}/package.json".',
          `If "${invalidFilesetNoPrefix}" is a named input, make sure it is defined in, for instance, nx.json.`,
        ].join('\n')
      );
    }
    if (invalidFilesetWorkspaceRootNegative) {
      throw new Error(
        [
          `"${invalidFilesetWorkspaceRootNegative}" is an invalid fileset.`,
          'It is not possible to negative filesets starting with {workspaceRoot}.',
        ].join('\n')
      );
    }

    const notFilesets = inputs.filter((r) => !r['fileset']);
    return Promise.all([
      this.hashProjectFileset(projectName, projectFilesets),
      ...[
        ...workspaceFilesets,
        ...this.legacyFilesetInputs.map((r) => r.fileset),
      ].map((fileset) => this.hashRootFileset(fileset)),
      ...[...notFilesets, ...this.legacyRuntimeInputs].map((r) =>
        r['runtime'] ? this.hashRuntime(r['runtime']) : this.hashEnv(r['env'])
      ),
    ]);
  }

  private async hashProjectInputs(
    projectInputs: { input: string; projects: string[] }[],
    visited: string[]
  ): Promise<PartialHash[]> {
    const partialHashes: Promise<PartialHash[]>[] = [];
    for (const input of projectInputs) {
      for (const project of input.projects) {
        const namedInputs = getNamedInputs(
          this.nxJson,
          this.projectGraph.nodes[project]
        );
        const expandedInput = expandSingleProjectInputs(
          [{ input: input.input }],
          namedInputs
        );
        partialHashes.push(
          this.hashSingleProjectInputs(project, expandedInput)
        );
      }
    }
    return Promise.all(partialHashes).then((hashes) => hashes.flat());
  }

  private async hashRootFileset(fileset: string): Promise<PartialHash> {
    const mapKey = fileset;
    const withoutWorkspaceRoot = fileset.substring(16);
    if (!this.filesetHashes[mapKey]) {
      this.filesetHashes[mapKey] = new Promise(async (res) => {
        const parts = [];
        const matchingFile = this.allWorkspaceFiles.find(
          (t) => t.file === withoutWorkspaceRoot
        );
        if (matchingFile) {
          parts.push(matchingFile.hash);
        } else {
          this.allWorkspaceFiles
            .filter((f) => minimatch(f.file, withoutWorkspaceRoot))
            .forEach((f) => {
              parts.push(f.hash);
            });
        }
        const value = hashArray(parts);
        res({
          value,
          details: { [mapKey]: value },
        });
      });
    }
    return this.filesetHashes[mapKey];
  }

  private async hashProjectFileset(
    projectName: string,
    filesetPatterns: string[]
  ): Promise<PartialHash> {
    const mapKey = `${projectName}:${filesetPatterns.join(',')}`;
    if (!this.filesetHashes[mapKey]) {
      this.filesetHashes[mapKey] = new Promise(async (res) => {
        const p = this.projectGraph.nodes[projectName];
        const filteredFiles = filterUsingGlobPatterns(
          p.data.root,
          this.projectFileMap[projectName] || [],
          filesetPatterns
        );
        const fileNames = filteredFiles.map((f) => f.file);
        const values = filteredFiles.map((f) => f.hash);

        const value = hashArray([
          ...fileNames,
          ...values,
          JSON.stringify({ ...p.data, files: undefined }),
          hashTsConfig(p, this.projectRootMappings, this.options),
        ]);
        res({
          value,
          details: { [mapKey]: value },
        });
      });
    }
    return this.filesetHashes[mapKey];
  }

  private async hashRuntime(runtime: string): Promise<PartialHash> {
    const mapKey = `runtime:${runtime}`;
    if (!this.runtimeHashes[mapKey]) {
      this.runtimeHashes[mapKey] = new Promise((res, rej) => {
        exec(runtime, (err, stdout, stderr) => {
          if (err) {
            rej(
              new Error(`Nx failed to execute {runtime: '${runtime}'}. ${err}.`)
            );
          } else {
            const value = `${stdout}${stderr}`.trim();
            res({
              details: { [`runtime:${runtime}`]: value },
              value,
            });
          }
        });
      });
    }
    return this.runtimeHashes[mapKey];
  }

  private async hashEnv(envVarName: string): Promise<PartialHash> {
    const value = hashArray([process.env[envVarName] ?? '']);
    return {
      details: { [`env:${envVarName}`]: value },
      value,
    };
  }
}

export function getNamedInputs(
  nxJson: NxJsonConfiguration,
  project: ProjectGraphProjectNode
) {
  return {
    default: [{ fileset: '{projectRoot}/**/*' }],
    ...nxJson.namedInputs,
    ...project.data.namedInputs,
  };
}

export function getTargetInputs(
  nxJson: NxJsonConfiguration,
  projectNode: ProjectGraphProjectNode,
  target: string
) {
  const namedInputs = getNamedInputs(nxJson, projectNode);

  const targetData = projectNode.data.targets[target];
  const targetDefaults = (nxJson.targetDefaults || {})[target];

  const inputs = splitInputsIntoSelfAndDependencies(
    targetData.inputs || targetDefaults?.inputs || DEFAULT_INPUTS,
    namedInputs
  );

  const selfInputs = extractPatternsFromFileSets(inputs.selfInputs);

  const dependencyInputs = extractPatternsFromFileSets(
    inputs.depsInputs.map((s) => expandNamedInput(s.input, namedInputs)).flat()
  );

  return { selfInputs, dependencyInputs };
}

export function extractPatternsFromFileSets(
  inputs: readonly ExpandedSelfInput[]
): string[] {
  return inputs
    .filter((c): c is { fileset: string } => !!c['fileset'])
    .map((c) => c['fileset']);
}

export function splitInputsIntoSelfAndDependencies(
  inputs: ReadonlyArray<InputDefinition | string>,
  namedInputs: { [inputName: string]: ReadonlyArray<InputDefinition | string> }
): {
  depsInputs: { input: string; dependencies: true }[];
  projectInputs: { input: string; projects: string[] }[];
  selfInputs: ExpandedSelfInput[];
} {
  const depsInputs: { input: string; dependencies: true }[] = [];
  const projectInputs: { input: string; projects: string[] }[] = [];
  const selfInputs = [];
  for (const d of inputs) {
    if (typeof d === 'string') {
      if (d.startsWith('^')) {
        depsInputs.push({ input: d.substring(1), dependencies: true });
      } else {
        selfInputs.push(d);
      }
    } else {
      if (
        ('dependencies' in d && d.dependencies) ||
        // Todo(@AgentEnder): Remove check in v17
        ('projects' in d &&
          typeof d.projects === 'string' &&
          d.projects === 'dependencies')
      ) {
        depsInputs.push({
          input: d.input,
          dependencies: true,
        });
      } else if (
        'projects' in d &&
        d.projects &&
        // Todo(@AgentEnder): Remove check in v17
        !(d.projects === 'self')
      ) {
        projectInputs.push({
          input: d.input,
          projects: Array.isArray(d.projects) ? d.projects : [d.projects],
        });
      } else {
        selfInputs.push(d);
      }
    }
  }
  return {
    depsInputs,
    projectInputs,
    selfInputs: expandSingleProjectInputs(selfInputs, namedInputs),
  };
}

function expandSingleProjectInputs(
  inputs: ReadonlyArray<InputDefinition | string>,
  namedInputs: { [inputName: string]: ReadonlyArray<InputDefinition | string> }
): ExpandedSelfInput[] {
  const expanded = [];
  for (const d of inputs) {
    if (typeof d === 'string') {
      if (d.startsWith('^'))
        throw new Error(`namedInputs definitions cannot start with ^`);

      if (namedInputs[d]) {
        expanded.push(...expandNamedInput(d, namedInputs));
      } else {
        expanded.push({ fileset: d });
      }
    } else {
      if ((d as any).projects || (d as any).dependencies) {
        throw new Error(
          `namedInputs definitions can only refer to other namedInputs definitions within the same project.`
        );
      }
      if (
        (d as any).fileset ||
        (d as any).env ||
        (d as any).runtime ||
        (d as any).externalDependencies
      ) {
        expanded.push(d);
      } else {
        expanded.push(...expandNamedInput((d as any).input, namedInputs));
      }
    }
  }
  return expanded;
}

export function expandNamedInput(
  input: string,
  namedInputs: { [inputName: string]: ReadonlyArray<InputDefinition | string> }
): ExpandedSelfInput[] {
  namedInputs ||= {};
  if (!namedInputs[input]) throw new Error(`Input '${input}' is not defined`);
  return expandSingleProjectInputs(namedInputs[input], namedInputs);
}

export function filterUsingGlobPatterns(
  root: string,
  files: FileData[],
  patterns: string[]
): FileData[] {
  const filesetWithExpandedProjectRoot = patterns
    .map((f) => f.replace('{projectRoot}', root))
    .map((r) => {
      // handling root level projects that create './' pattern that doesn't work with minimatch
      if (r.startsWith('./')) return r.substring(2);
      if (r.startsWith('!./')) return '!' + r.substring(3);
      return r;
    });

  const positive = [];
  const negative = [];
  for (const p of filesetWithExpandedProjectRoot) {
    if (p.startsWith('!')) {
      negative.push(p);
    } else {
      positive.push(p);
    }
  }

  if (positive.length === 0 && negative.length === 0) {
    return files;
  }

  return files.filter((f) => {
    let matchedPositive = false;
    if (
      positive.length === 0 ||
      (positive.length === 1 && positive[0] === `${root}/**/*`)
    ) {
      matchedPositive = true;
    } else {
      matchedPositive = positive.some((pattern) => minimatch(f.file, pattern));
    }

    if (!matchedPositive) return false;

    return negative.every((pattern) => minimatch(f.file, pattern));
  });
}
