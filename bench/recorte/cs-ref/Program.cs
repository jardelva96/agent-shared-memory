// Reference slices for C#, from Roslyn (the C# compiler itself).
// Prints one JSON line per declaration: {file, name, nameLine, endLine}, 1-based.
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

foreach (var file in args)
{
    var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file));
    var text = tree.GetText();
    foreach (var node in tree.GetRoot().DescendantNodes())
    {
        SyntaxToken? name = node switch
        {
            BaseTypeDeclarationSyntax t => t.Identifier,   // class, record, struct, interface, enum
            MethodDeclarationSyntax m => m.Identifier,
            ConstructorDeclarationSyntax c => c.Identifier,
            PropertyDeclarationSyntax p => p.Identifier,
            DelegateDeclarationSyntax d => d.Identifier,
            FieldDeclarationSyntax f when f.Declaration.Variables.Count == 1 => f.Declaration.Variables[0].Identifier,
            _ => null
        };
        if (name is not { } id) continue;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            file, kind = node.Kind().ToString(),
            container = node.Ancestors().OfType<BaseTypeDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText,
            name = id.ValueText,
            nameLine = text.Lines.GetLineFromPosition(id.SpanStart).LineNumber + 1,
            endLine = text.Lines.GetLineFromPosition(node.Span.End - 1).LineNumber + 1
        }));
    }
}
