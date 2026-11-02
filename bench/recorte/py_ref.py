"""Reference slices for Python, from the standard library's own parser (ast).

Prints one JSON line per def/class: {file, name, nameLine, endLine}, 1-based.
"""
import ast
import json
import sys

for file in sys.argv[1:]:
    try:
        with open(file, encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
    except (SyntaxError, UnicodeDecodeError, ValueError):
        continue
    def visit(node, nested, container=None):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                # lineno is the `def`/`class` line itself; decorators sit above it.
                print(json.dumps({"file": file, "kind": type(child).__name__, "nested": nested, "container": container, "name": child.name, "nameLine": child.lineno, "endLine": child.end_lineno}))
                visit(child, nested or not isinstance(child, ast.ClassDef), child.name if isinstance(child, ast.ClassDef) else None)
            else:
                visit(child, nested, container)

    visit(tree, False)
