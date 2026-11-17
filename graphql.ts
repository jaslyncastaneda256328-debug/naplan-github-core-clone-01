// GraphQL over POST /api/graphql: a small parser and executor for the operations
// the suite sends (viewer, repository, issues, pull requests, node, __type,
// and the five mutations). Errors are HTTP 200 with an `errors` array; a batch
// (a JSON array of operations) returns an array of results in order. Global ids
// are the store's opaque base64url ids, stable across reads.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  commentGlobalId,
  decodeGlobalId,
  diffTrees,
  flattenTree,
  lineDiff,
  parseCommit,
  repoGlobalId,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Value = string | number | boolean | null | { variable: string } | { enum: string } | Value[] | { [key: string]: Value };

interface Directive {
  name: string;
  args: Record<string, Value>;
}

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  directives: Directive[];
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  name: string | null;
  typeCondition: string | null;
  directives: Directive[];
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface VariableDef {
  type: string;
  defaultValue: Value | undefined;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, VariableDef>;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

type Token =
  | { type: 'name'; value: string }
  | { type: 'int'; value: string }
  | { type: 'float'; value: string }
  | { type: 'string'; value: string }
  | { type: 'punct'; value: string }
  | { type: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@&|'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.value === value;
  }

  private atName(value: string): boolean {
    const token = this.peek();
    return token.type === 'name' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().type !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ kind: 'query', name: null, variables: new Map(), selections: this.parseSelectionSet() });
      } else if (this.atName('query') || this.atName('mutation')) {
        const kind = this.expectName() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().type === 'name') name = this.expectName();
        const variables = this.atPunct('(') ? this.parseVariableDefinitions() : new Map<string, VariableDef>();
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
      } else if (this.atName('fragment')) {
        this.expectName('fragment');
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(this.peek())} in document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Map<string, VariableDef> {
    const variables = new Map<string, VariableDef>();
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseTypeName();
      let defaultValue: Value | undefined;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      variables.set(name, { type, defaultValue });
    }
    this.expectPunct(')');
    return variables;
  }

  private parseTypeName(): string {
    if (this.atPunct('[')) {
      this.next();
      const inner = this.parseTypeName();
      this.expectPunct(']');
      let type = `[${inner}]`;
      if (this.atPunct('!')) {
        this.next();
        type += '!';
      }
      return type;
    }
    const name = this.expectName();
    let type = name;
    if (this.atPunct('!')) {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.atPunct('...')) {
      this.next();
      if (this.peek().type === 'name' && !this.atName('on')) {
        const name = this.expectName();
        return { kind: 'fragment', name, typeCondition: null, directives: this.parseDirectives(), selections: [] };
      }
      let typeCondition: string | null = null;
      if (this.atName('on')) {
        this.expectName('on');
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      return { kind: 'fragment', name: null, typeCondition, directives, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : {};
    const directives = this.parseDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, directives, selections };
  }

  private parseArguments(): Record<string, Value> {
    const args: Record<string, Value> = {};
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseDirectives(): Directive[] {
    const directives: Directive[] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = this.atPunct('(') ? this.parseArguments() : {};
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') return { variable: this.expectName() };
    if (token.type === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return values;
    }
    if (token.type === 'punct' && token.value === '{') {
      const object: { [key: string]: Value } = {};
      while (!this.atPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    if (token.type === 'string') return token.value;
    if (token.type === 'int') return Number(token.value);
    if (token.type === 'float') return Number(token.value);
    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { enum: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------------------
// Schema table (for validation and introspection)
// ---------------------------------------------------------------------------

interface TypeFieldDef {
  type: string;
  args?: Record<string, string>;
}
interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: Record<string, TypeFieldDef>;
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!' },
      repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
      node: { type: 'Node', args: { id: 'ID!' } },
      __type: { type: '__Type', args: { name: 'String!' } },
      __schema: { type: '__Schema!' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int!' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'User!' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission!' },
      hasIssuesEnabled: { type: 'Boolean!' },
      issue: { type: 'Issue', args: { number: 'Int!' } },
      issues: { type: 'IssueConnection!', args: { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' } },
      pullRequests: { type: 'PullRequestConnection!', args: { first: 'Int', after: 'String', states: '[PullRequestState!]' } },
      pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      state: { type: 'IssueState!' },
      body: { type: 'String!' },
      repository: { type: 'Repository!' },
      url: { type: 'String!' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue!]!' },
      edges: { type: '[IssueEdge!]!' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'Issue' },
      cursor: { type: 'String!' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String!' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      headRefName: { type: 'String!' },
      baseRefName: { type: 'String!' },
      mergeable: { type: 'MergeableState!' },
      files: { type: 'PullRequestFileConnection!', args: { first: 'Int' } },
      repository: { type: 'Repository!' },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest!]!' },
      edges: { type: '[PullRequestEdge!]!' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'PullRequest' },
      cursor: { type: 'String!' },
    },
  },
  PullRequestFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestFile!]!' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String!' },
      additions: { type: 'Int!' },
      deletions: { type: 'Int!' },
      changeType: { type: 'String!' },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      login: { type: 'String!' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
    },
  },
  Node: {
    kind: 'INTERFACE',
    fields: {
      id: { type: 'ID!' },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      body: { type: 'String!' },
      author: { type: 'User' },
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'IssueComment' },
      cursor: { type: 'String!' },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      clientMutationId: { type: 'String' },
      issue: { type: 'Issue' },
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      clientMutationId: { type: 'String' },
      issue: { type: 'Issue' },
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      clientMutationId: { type: 'String' },
      pullRequest: { type: 'PullRequest' },
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      clientMutationId: { type: 'String' },
      pullRequest: { type: 'PullRequest' },
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      clientMutationId: { type: 'String' },
      commentEdge: { type: 'IssueCommentEdge' },
    },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'WRITE', 'READ', 'NONE'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    fields: {
      field: { type: 'IssueOrderField!' },
      direction: { type: 'OrderDirection!' },
    },
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      repositoryId: { type: 'ID!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      clientMutationId: { type: 'String' },
    },
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      issueId: { type: 'ID!' },
      clientMutationId: { type: 'String' },
    },
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      repositoryId: { type: 'ID!' },
      baseRefName: { type: 'String!' },
      headRefName: { type: 'String!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      clientMutationId: { type: 'String' },
    },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      pullRequestId: { type: 'ID!' },
      mergeMethod: { type: 'PullRequestMergeMethod' },
      clientMutationId: { type: 'String' },
    },
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    fields: {
      subjectId: { type: 'ID!' },
      body: { type: 'String!' },
      clientMutationId: { type: 'String' },
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: { type: '__Type!' },
      mutationType: { type: '__Type' },
      types: { type: '[__Type!]!' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      kind: { type: '__TypeKind!' },
      fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' } },
      enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' } },
      description: { type: 'String' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      type: { type: '__Type!' },
      args: { type: '[__InputValue!]!' },
      description: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      type: { type: '__Type!' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
    },
  },
  __TypeKind: { kind: 'ENUM', enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

/** The unwrapped (named) type of a type reference like `[Issue!]!`. */
function namedType(typeRef: string): string {
  return typeRef.replace(/[\[\]!]/g, '');
}

/** A type reference string as a nested __Type object. */
function typeRefObject(typeRef: string): Record<string, unknown> {
  if (typeRef.endsWith('!')) {
    return { __typename: '__Type', kind: 'NON_NULL', name: null, ofType: typeRefObject(typeRef.slice(0, -1)) };
  }
  if (typeRef.startsWith('[') && typeRef.endsWith(']')) {
    return { __typename: '__Type', kind: 'LIST', name: null, ofType: typeRefObject(typeRef.slice(1, -1)) };
  }
  const def = SCHEMA[typeRef];
  return { __typename: '__Type', kind: def?.kind ?? 'OBJECT', name: typeRef, ofType: null };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface Context {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, context: Context): unknown {
  if (value === null || typeof value !== 'object') return value;
  if ('variable' in value) {
    const name = value.variable;
    if (name in context.variables) return context.variables[name];
    return undefined;
  }
  if ('enum' in value) return value.enum;
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, context);
  return out;
}

function directiveSkips(directives: readonly Directive[], context: Context): boolean {
  for (const directive of directives) {
    if (directive.name === 'skip') {
      const condition = resolveValue(directive.args.if as Value, context);
      if (condition === true) return true;
    }
    if (directive.name === 'include') {
      const condition = resolveValue(directive.args.if as Value, context);
      if (condition === false) return true;
    }
  }
  return false;
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function seqFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** A page of items in createdSeq order, with GraphQL cursor pagination. */
function paginate<T extends { createdSeq: number }>(
  items: readonly T[],
  args: Record<string, unknown>,
  descending: boolean,
): { nodes: T[]; pageInfo: GqlObject; totalCount: number } {
  const sorted = [...items].sort((a, b) => (descending ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  const afterSeq = seqFromCursor(args.after);
  let rest = sorted;
  if (afterSeq !== null) {
    const index = sorted.findIndex((item) => item.createdSeq === afterSeq);
    rest = index >= 0 ? sorted.slice(index + 1) : sorted;
  }
  const first = typeof args.first === 'number' ? args.first : rest.length;
  const nodes = rest.slice(0, first);
  const last = nodes[nodes.length - 1];
  const firstNode = nodes[0];
  return {
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: rest.length > nodes.length,
      hasPreviousPage: afterSeq !== null,
      startCursor: firstNode === undefined ? null : cursorFor(firstNode.createdSeq),
      endCursor: last === undefined ? null : cursorFor(last.createdSeq),
    },
    totalCount: sorted.length,
  };
}

function wrapRepo(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}
function wrapIssue(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}
function wrapPull(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}
function wrapUser(login: string): GqlObject {
  return { __typename: 'User', login };
}

function repoFromGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  return store.getRepo(decoded.owner, decoded.name) ?? null;
}

function issueFromGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (repo === undefined) return null;
  const issue = repo.issues.find((candidate) => candidate.number === decoded.number);
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (repo === undefined) return null;
  const pull = repo.pulls.find((candidate) => candidate.number === decoded.number);
  return pull === undefined ? null : { repo, pull };
}

function commentFromGlobalId(store: Store, id: unknown): { repo: Repo; comment: Comment; issueNumber: number } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'IssueComment') return null;
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (repo === undefined) return null;
  const issue = repo.issues.find((candidate) => candidate.number === decoded.number);
  if (issue === undefined) return null;
  const comment = issue.comments.find((candidate) => candidate.id === decoded.extra);
  if (comment === undefined) {
    const pullComments = store.pullComments.get(`${decoded.owner}/${decoded.name}#${decoded.number}`) ?? [];
    const found = pullComments.find((candidate) => candidate.id === decoded.extra);
    return found === undefined ? null : { repo, comment: found, issueNumber: decoded.number };
  }
  return { repo, comment, issueNumber: decoded.number };
}

function inputObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const RESOLVERS: Record<string, Record<string, (parent: GqlObject, args: Record<string, unknown>, context: Context) => unknown>> = {
  Query: {
    viewer: () => wrapUser(VIEWER_LOGIN),
    repository: (_parent, args, context) => {
      const repo = context.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : wrapRepo(repo);
    },
    node: (_parent, args, context) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = context.store.getRepo(decoded.owner, decoded.name);
        return repo === undefined ? null : wrapRepo(repo);
      }
      if (decoded.kind === 'Issue') {
        const found = issueFromGlobalId(context.store, id);
        return found === null ? null : wrapIssue(found.repo, found.issue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullFromGlobalId(context.store, id);
        return found === null ? null : wrapPull(found.repo, found.pull);
      }
      if (decoded.kind === 'IssueComment') {
        const found = commentFromGlobalId(context.store, id);
        return found === null ? null : { __typename: 'IssueComment', repo: found.repo, comment: found.comment, issueNumber: found.issueNumber };
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      const def = SCHEMA[name];
      if (def === undefined) return null;
      return { __typename: '__Type', kind: def.kind, name, ofType: null };
    },
    __schema: () => ({ __typename: '__Schema' }),
  },
  Repository: {
    id: (parent) => repoGlobalId((parent.repo as Repo).owner, (parent.repo as Repo).name),
    databaseId: (parent) => (parent.repo as Repo).id,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => (parent.repo as Repo).fullName,
    owner: (parent) => wrapUser((parent.repo as Repo).owner),
    defaultBranchRef: (parent) => {
      const repo = parent.repo as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = parent.repo as Repo;
      const issue = repo.issues.find((candidate) => candidate.number === args.number);
      return issue === undefined ? null : wrapIssue(repo, issue);
    },
    issues: (parent, args) => {
      const repo = parent.repo as Repo;
      let issues = [...repo.issues];
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((state) => String(state).toUpperCase()));
        issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
      }
      const orderBy = inputObject(args.orderBy);
      const descending = String(orderBy.direction ?? 'DESC').toUpperCase() !== 'ASC';
      const page = paginate(issues, args, descending);
      return {
        __typename: 'IssueConnection',
        nodes: page.nodes.map((issue) => wrapIssue(repo, issue)),
        edges: page.nodes.map((issue) => ({ __typename: 'IssueEdge', node: wrapIssue(repo, issue), cursor: cursorFor(issue.createdSeq) })),
        pageInfo: page.pageInfo,
        totalCount: page.totalCount,
      };
    },
    pullRequests: (parent, args) => {
      const repo = parent.repo as Repo;
      let pulls = [...repo.pulls];
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((state) => String(state).toUpperCase()));
        pulls = pulls.filter((pull) => {
          const state = pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
          return wanted.has(state);
        });
      }
      const page = paginate(pulls, args, true);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.nodes.map((pull) => wrapPull(repo, pull)),
        edges: page.nodes.map((pull) => ({ __typename: 'PullRequestEdge', node: wrapPull(repo, pull), cursor: cursorFor(pull.createdSeq) })),
        pageInfo: page.pageInfo,
        totalCount: page.totalCount,
      };
    },
    pullRequest: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = repo.pulls.find((candidate) => candidate.number === args.number);
      return pull === undefined ? null : wrapPull(repo, pull);
    },
  },
  Issue: {
    id: (parent) => (parent.issue as Issue).globalId,
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    state: (parent) => (parent.issue as Issue).state.toUpperCase(),
    body: (parent) => (parent.issue as Issue).body,
    repository: (parent) => wrapRepo(parent.repo as Repo),
    url: (parent) => `https://example.invalid/${(parent.repo as Repo).fullName}/issues/${(parent.issue as Issue).number}`,
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes as unknown[],
    edges: (parent) => parent.edges as unknown[],
    pageInfo: (parent) => parent.pageInfo as GqlObject,
    totalCount: (parent) => parent.totalCount as number,
  },
  IssueEdge: {
    node: (parent) => parent.node as GqlObject,
    cursor: (parent) => parent.cursor as string,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage as boolean,
    hasPreviousPage: (parent) => parent.hasPreviousPage as boolean,
    startCursor: (parent) => (parent.startCursor ?? null) as string | null,
    endCursor: (parent) => (parent.endCursor ?? null) as string | null,
  },
  PullRequest: {
    id: (parent) => (parent.pull as Pull).globalId,
    number: (parent) => (parent.pull as Pull).number,
    title: (parent) => (parent.pull as Pull).title,
    body: (parent) => (parent.pull as Pull).body,
    state: (parent) => {
      const pull = parent.pull as Pull;
      return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
    },
    merged: (parent) => (parent.pull as Pull).merged,
    headRefName: (parent) => (parent.pull as Pull).head,
    baseRefName: (parent) => (parent.pull as Pull).base,
    mergeable: (parent, _args, context) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      if (pull.headSha === '' || pull.baseSha === '') return 'UNKNOWN';
      return context.store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      const lookup = (oid: string) => repo.objects.get(oid);
      const baseTree = pull.baseSha === '' ? null : contextlessCommitTree(repo, pull.baseSha);
      const headTree = pull.headSha === '' ? null : contextlessCommitTree(repo, pull.headSha);
      const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      const changes = diffTrees(baseTree ?? emptyTree, headTree ?? emptyTree, lookup);
      let nodes = changes.map((change) => {
        let additions = 0;
        let deletions = 0;
        if (change.status === 'added') additions = countBlobLines(repo, change.newOid as string);
        else if (change.status === 'removed') deletions = countBlobLines(repo, change.oldOid as string);
        else {
          const counted = lineDiff(blobTextOf(repo, change.oldOid as string), blobTextOf(repo, change.newOid as string));
          additions = counted.additions;
          deletions = counted.deletions;
          if (additions === 0 && deletions === 0) additions = 1;
        }
        return { __typename: 'PullRequestFile', path: change.path, additions, deletions, changeType: change.status.toUpperCase() };
      });
      if (typeof args.first === 'number') nodes = nodes.slice(0, args.first);
      return {
        __typename: 'PullRequestFileConnection',
        nodes,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: nodes.length,
      };
    },
    repository: (parent) => wrapRepo(parent.repo as Repo),
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes as unknown[],
    edges: (parent) => parent.edges as unknown[],
    pageInfo: (parent) => parent.pageInfo as GqlObject,
    totalCount: (parent) => parent.totalCount as number,
  },
  PullRequestEdge: {
    node: (parent) => parent.node as GqlObject,
    cursor: (parent) => parent.cursor as string,
  },
  PullRequestFileConnection: {
    nodes: (parent) => parent.nodes as unknown[],
    pageInfo: (parent) => parent.pageInfo as GqlObject,
    totalCount: (parent) => parent.totalCount as number,
  },
  PullRequestFile: {
    path: (parent) => parent.path as string,
    additions: (parent) => parent.additions as number,
    deletions: (parent) => parent.deletions as number,
    changeType: (parent) => parent.changeType as string,
  },
  User: {
    id: () => VIEWER_ID,
    login: (parent) => parent.login as string,
  },
  Ref: {
    name: (parent) => parent.name as string,
  },
  IssueComment: {
    id: (parent) => (parent.comment as Comment).globalId,
    body: (parent) => (parent.comment as Comment).body,
    author: () => wrapUser(VIEWER_LOGIN),
  },
  IssueCommentEdge: {
    node: (parent) => parent.node as GqlObject,
    cursor: (parent) => parent.cursor as string,
  },
  Node: {
    id: (parent) => {
      if ('issue' in parent && parent.issue !== undefined) return (parent.issue as Issue).globalId;
      if ('pull' in parent && parent.pull !== undefined) return (parent.pull as Pull).globalId;
      if ('comment' in parent && parent.comment !== undefined) return (parent.comment as Comment).globalId;
      const repo = parent.repo as Repo;
      return repoGlobalId(repo.owner, repo.name);
    },
  },
  CreateIssuePayload: {
    clientMutationId: (parent) => (parent.clientMutationId ?? null) as string | null,
    issue: (parent) => parent.issue as GqlObject,
  },
  CloseIssuePayload: {
    clientMutationId: (parent) => (parent.clientMutationId ?? null) as string | null,
    issue: (parent) => parent.issue as GqlObject,
  },
  CreatePullRequestPayload: {
    clientMutationId: (parent) => (parent.clientMutationId ?? null) as string | null,
    pullRequest: (parent) => parent.pullRequest as GqlObject,
  },
  MergePullRequestPayload: {
    clientMutationId: (parent) => (parent.clientMutationId ?? null) as string | null,
    pullRequest: (parent) => parent.pullRequest as GqlObject,
  },
  AddCommentPayload: {
    clientMutationId: (parent) => (parent.clientMutationId ?? null) as string | null,
    commentEdge: (parent) => parent.commentEdge as GqlObject,
  },
  __Schema: {
    queryType: () => ({ __typename: '__Type', kind: 'OBJECT', name: 'Query', ofType: null }),
    mutationType: () => ({ __typename: '__Type', kind: 'OBJECT', name: 'Mutation', ofType: null }),
    types: () => Object.keys(SCHEMA).map((name) => ({ __typename: '__Type', kind: SCHEMA[name]?.kind ?? 'OBJECT', name, ofType: null })),
  },
  __Type: {
    name: (parent) => (parent.name ?? null) as string | null,
    kind: (parent) => parent.kind as string,
    fields: (parent) => {
      const name = parent.name as string | undefined;
      if (name === undefined || name === null) return null;
      const def = SCHEMA[name];
      if (def === undefined || def.fields === undefined) return null;
      return Object.entries(def.fields).map(([fieldName, fieldDef]) => ({
        __typename: '__Field',
        name: fieldName,
        type: typeRefObject(fieldDef.type),
        args: Object.entries(fieldDef.args ?? {}).map(([argName, argType]) => ({
          __typename: '__InputValue',
          name: argName,
          type: typeRefObject(argType),
        })),
        description: null,
      }));
    },
    enumValues: (parent) => {
      const name = parent.name as string | undefined;
      if (name === undefined || name === null) return null;
      const def = SCHEMA[name];
      if (def === undefined || def.enumValues === undefined) return null;
      return def.enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null }));
    },
    description: () => null,
  },
  __Field: {
    name: (parent) => parent.name as string,
    type: (parent) => parent.type as GqlObject,
    args: (parent) => parent.args as unknown[],
    description: () => null,
  },
  __InputValue: {
    name: (parent) => parent.name as string,
    type: (parent) => parent.type as GqlObject,
  },
  __EnumValue: {
    name: (parent) => parent.name as string,
    description: () => null,
  },
  Mutation: {
    createIssue: (_parent, args, context) => {
      const input = inputObject(args.input);
      const repo = repoFromGlobalId(context.store, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('title is required');
      const issue = context.store.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
      return {
        __typename: 'CreateIssuePayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        issue: wrapIssue(repo, issue),
      };
    },
    closeIssue: (_parent, args, context) => {
      const input = inputObject(args.input);
      const found = issueFromGlobalId(context.store, input.issueId);
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      return {
        __typename: 'CloseIssuePayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        issue: wrapIssue(found.repo, found.issue),
      };
    },
    createPullRequest: (_parent, args, context) => {
      const input = inputObject(args.input);
      const repo = repoFromGlobalId(context.store, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = context.store.branchTip(repo, head);
      const baseSha = context.store.branchTip(repo, base);
      if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head);
      if (duplicate !== undefined) throw new Error('a pull request for this head already exists');
      const pull = context.store.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head,
        base,
        headSha,
        baseSha,
      });
      return {
        __typename: 'CreatePullRequestPayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        pullRequest: wrapPull(repo, pull),
      };
    },
    mergePullRequest: (_parent, args, context) => {
      const input = inputObject(args.input);
      const found = pullFromGlobalId(context.store, input.pullRequestId);
      if (found === null) throw new Error('pull request not found');
      const merged = context.store.mergePull(found.repo, found.pull);
      if (merged === null) throw new Error('This pull request cannot be merged');
      return {
        __typename: 'MergePullRequestPayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        pullRequest: wrapPull(found.repo, found.pull),
      };
    },
    addComment: (_parent, args, context) => {
      const input = inputObject(args.input);
      if (typeof input.body !== 'string') throw new Error('body is required');
      const issueFound = issueFromGlobalId(context.store, input.subjectId);
      const comment: Comment = {
        id: context.store.nextCommentId,
        globalId: '',
        body: input.body,
        createdSeq: context.store.nextGlobalSeq,
      };
      context.store.nextCommentId += 1;
      context.store.nextGlobalSeq += 1;
      if (issueFound !== null) {
        comment.globalId = commentGlobalId(issueFound.repo.owner, issueFound.repo.name, issueFound.issue.number, comment.id);
        issueFound.issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', repo: issueFound.repo, comment, issueNumber: issueFound.issue.number },
            cursor: cursorFor(comment.createdSeq),
          },
        };
      }
      const pullFound = pullFromGlobalId(context.store, input.subjectId);
      if (pullFound === null) throw new Error('subject not found');
      comment.globalId = commentGlobalId(pullFound.repo.owner, pullFound.repo.name, pullFound.pull.number, comment.id);
      const key = `${pullFound.repo.owner}/${pullFound.repo.name}#${pullFound.pull.number}`;
      const list = context.store.pullComments.get(key) ?? [];
      list.push(comment);
      context.store.pullComments.set(key, list);
      return {
        __typename: 'AddCommentPayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo: pullFound.repo, comment, issueNumber: pullFound.pull.number },
          cursor: cursorFor(comment.createdSeq),
        },
      };
    },
  },
};

function contextlessCommitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

function blobTextOf(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

function countBlobLines(repo: Repo, oid: string): number {
  const text = blobTextOf(repo, oid);
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** The object type a value belongs to, for fragment matching. */
function objectTypeName(value: GqlObject): string {
  return value.__typename;
}

function executeSelectionSet(
  selections: readonly Selection[],
  parentType: string,
  parentValue: GqlObject,
  context: Context,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (directiveSkips(selection.directives, context)) continue;
      if (selection.name !== null) {
        const fragment = context.fragments.get(selection.name);
        if (fragment === undefined) {
          context.errors.push({ message: `Unknown fragment "${selection.name}".` });
          return null;
        }
        if (fragment.typeCondition !== objectTypeName(parentValue) && fragment.typeCondition !== parentType && fragment.typeCondition !== 'Node') {
          continue;
        }
        const nested = executeSelectionSet(fragment.selections, fragment.typeCondition, parentValue, context);
        if (nested === null) return null;
        Object.assign(out, nested);
        continue;
      }
      if (selection.typeCondition !== null && selection.typeCondition !== objectTypeName(parentValue) && selection.typeCondition !== parentType && selection.typeCondition !== 'Node') {
        continue;
      }
      const nested = executeSelectionSet(selection.selections, selection.typeCondition ?? parentType, parentValue, context);
      if (nested === null) return null;
      Object.assign(out, nested);
      continue;
    }
    if (directiveSkips(selection.directives, context)) continue;
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = objectTypeName(parentValue);
      continue;
    }
    const typeDef = SCHEMA[parentType];
    const fieldDef = typeDef?.fields?.[selection.name];
    if (fieldDef === undefined) {
      context.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      return null;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(selection.args)) args[argName] = resolveValue(argValue, context);
    const resolver = RESOLVERS[parentType]?.[selection.name];
    if (resolver === undefined) {
      context.errors.push({ message: `No resolver for field "${selection.name}" on type "${parentType}".` });
      return null;
    }
    let value: unknown;
    try {
      value = resolver(parentValue, args, context);
    } catch (error) {
      context.errors.push({ message: error instanceof Error ? error.message : 'resolver failed' });
      return null;
    }
    if (selection.selections.length === 0) {
      out[responseKey] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    const childType = namedType(fieldDef.type);
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        if (item === null || item === undefined) {
          items.push(null);
          continue;
        }
        if (typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          const resolved = executeSelectionSet(selection.selections, childType, item as GqlObject, context);
          if (resolved === null) return null;
          items.push(resolved);
        } else {
          items.push(item);
        }
      }
      out[responseKey] = items;
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const resolved = executeSelectionSet(selection.selections, childType, value as GqlObject, context);
      if (resolved === null) return null;
      out[responseKey] = resolved;
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

function executeOperation(operation: Operation, document: Document, store: Store, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const context: Context = { store, variables: { ...variables }, fragments: document.fragments, errors: [] };
  for (const [name, def] of operation.variables) {
    if (!(name in context.variables) && def.defaultValue !== undefined) {
      context.variables[name] = resolveValue(def.defaultValue, context);
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelectionSet(operation.selections, rootType, root, context);
  if (context.errors.length > 0) {
    return { data: data === null ? null : data, errors: context.errors };
  }
  return { data };
}

/** Run one GraphQL request body (a single operation, or a batch array). */
export function handleGraphql(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => runOne(store, item));
  }
  return runOne(store, body);
}

function runOne(store: Store, request: unknown): { data: unknown; errors?: Array<{ message: string }> } {
  const data = request as { query?: unknown; variables?: unknown; operationName?: unknown } | null;
  if (data === null || typeof data.query !== 'string' || data.query.trim() === '') {
    return { data: null, errors: [{ message: 'A query is required.' }] };
  }
  let document: Document;
  try {
    document = new Parser(data.query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Syntax Error' }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operations in the document.' }] };
  }
  let operation = document.operations[0] as Operation;
  if (document.operations.length > 1) {
    const name = typeof data.operationName === 'string' ? data.operationName : null;
    const found = document.operations.find((candidate) => candidate.name === name);
    if (found === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${name ?? ''}".` }] };
    }
    operation = found;
  }
  const variables = data.variables !== null && typeof data.variables === 'object' && !Array.isArray(data.variables) ? (data.variables as Record<string, unknown>) : {};
  return executeOperation(operation, document, store, variables);
}
