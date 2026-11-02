/**
 * Reference slices for TypeScript/JavaScript, from the TypeScript compiler itself.
 *
 * Prints one JSON line per declaration: { file, name, nameLine, endLine }, 1-based. The
 * compiler is the ground truth extractSymbol is measured against, so nothing here may
 * share its heuristics.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8');
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx?$|\.mjs$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const line = pos => source.getLineAndCharacterOfPosition(pos).line + 1;

  let nested = false;
  // A member counts as part of the outline only when it belongs to a named class or interface;
  // the fields of an anonymous `{ a: string }` type or the methods of an object literal are
  // implementation detail, like anything inside a function.
  const memberOfNamedType = node => ts.isClassDeclaration(node.parent) || ts.isInterfaceDeclaration(node.parent);
  const isMember = node =>
    ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) ||
    ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isConstructorDeclaration(node);
  const emit = (nameNode, endNode, kind) => {
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    const inner = nested || (isMember(endNode) && !memberOfNamedType(endNode));
    const container = isMember(endNode) && memberOfNamedType(endNode) ? endNode.parent.name?.text : undefined;
    console.log(JSON.stringify({ file, kind, nested: inner, container, name: nameNode.text, nameLine: line(nameNode.getStart(source)), endLine: line(endNode.getEnd()) }));
  };

  const visit = node => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node)
    ) {
      emit(node.name, node, ts.SyntaxKind[node.kind]);
    } else if (ts.isConstructorDeclaration(node)) {
      console.log(JSON.stringify({ file, kind: 'Constructor', nested: nested || !memberOfNamedType(node), container: memberOfNamedType(node) ? node.parent.name?.text : undefined, name: 'constructor', nameLine: line(node.getStart(source) + node.getText(source).indexOf('constructor')), endLine: line(node.getEnd()) }));
    } else if (ts.isVariableStatement(node) && ts.isSourceFile(node.parent) && node.declarationList.declarations.length === 1) {
      // `const x = ...;` -- the statement, so the trailing semicolon counts as its end.
      emit(node.declarationList.declarations[0].name, node, "VariableStatement");
    }
    // Anything declared inside a function body is an implementation detail, not part of the
    // file's outline; it is marked so an outline is not charged for leaving it out.
    // A bare `{ }` block (generated type checks) scopes its declarations the same way.
    const fnLike = (ts.isFunctionLike(node) && !ts.isConstructorTypeNode(node)) || (ts.isBlock(node) && ts.isSourceFile(node.parent));
    const was = nested;
    if (fnLike) nested = true;
    ts.forEachChild(node, visit);
    nested = was;
  };
  visit(source);
}
