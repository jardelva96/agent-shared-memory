export function quebrarLinhas(texto, largura) {
  if (!Number.isInteger(largura) || largura < 1) throw new RangeError('largura invalida');
  const saida = [];
  const paragrafos = texto.split(/\n\s*\n/).map(p => p.split(/\s+/).filter(Boolean)).filter(p => p.length);
  paragrafos.forEach((palavras, indice) => {
    if (indice > 0) saida.push('');
    let linha = '';
    for (let palavra of palavras) {
      while (palavra.length > largura) {
        if (linha) {
          saida.push(linha);
          linha = '';
        }
        saida.push(palavra.slice(0, largura));
        palavra = palavra.slice(largura);
      }
      if (!palavra) continue;
      if (!linha) linha = palavra;
      else if (linha.length + 1 + palavra.length <= largura) linha += ` ${palavra}`;
      else {
        saida.push(linha);
        linha = palavra;
      }
    }
    if (linha) saida.push(linha);
  });
  return saida;
}

export function contarPalavras(texto) {
  return (texto.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? []).length;
}
